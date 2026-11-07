'use strict';
// Faults in native storage boundaries around the actual worker implementation.
// Atomic JSON commits are modeled; physical browser/disk close failures cannot
// be repaired or proven released by this in-memory fixture.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync('client/scripts/recovery-worker.js','utf8');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const arrayBuffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);
function rig(){
    const state={files:new Map(),writerFault:null,flushError:null,closeError:null,closeCalls:0,eraseCalls:0};
    const fault=stage=>{if(state.writerFault?.stage===stage)throw state.writerFault.error;};
    const directory={
        async getDirectoryHandle(){return directory;},
        async getFileHandle(name,{create=false}={}){
            if(!state.files.has(name)){
                if(!create)throw new DOMException('missing','NotFoundError');
                state.files.set(name,{bytes:Buffer.alloc(0),locked:false,writing:false,modified:Date.now()});
            }
            const entry=state.files.get(name);
            return{
                async getFile(){return new File([entry.bytes],name,{lastModified:entry.modified});},
                async createWritable(){
                    fault('open');if(entry.writing)throw new DOMException('writer in use','NoModificationAllowedError');
                    entry.writing=true;let pending=entry.bytes;
                    return{
                        async write(value){fault('write');pending=Buffer.from(value);},
                        async close(){fault('commit');entry.bytes=pending;entry.writing=false;entry.modified=Date.now();},
                        async abort(){entry.writing=false;}
                    };
                },
                async createSyncAccessHandle(){
                    if(entry.locked)throw new DOMException('locked','NoModificationAllowedError');entry.locked=true;
                    return{
                        getSize(){return entry.bytes.length;},
                        truncate(size){const updated=Buffer.alloc(size);entry.bytes.copy(updated);entry.bytes=updated;},
                        write(value,{at}){
                            if(entry.bytes.length<at+value.length){const updated=Buffer.alloc(at+value.length);entry.bytes.copy(updated);entry.bytes=updated;}
                            entry.bytes.set(value,at);return value.length;
                        },
                        flush(){if(state.flushError)throw state.flushError;entry.modified=Date.now();},
                        close(){state.closeCalls++;if(state.closeError)throw state.closeError;entry.locked=false;}
                    };
                }
            };
        },
        async removeEntry(name){state.eraseCalls++;const entry=state.files.get(name);if(entry?.locked||entry?.writing)throw new DOMException('locked','NoModificationAllowedError');state.files.delete(name);},
        async *entries(){for(const name of state.files.keys())yield[name,{}];}
    };
    const context=vm.createContext({navigator:{storage:{getDirectory:async()=>directory}},self:{postMessage(){}},
        crypto:crypto.webcrypto,Date,ArrayBuffer,Uint8Array});
    vm.runInContext(source+'\nthis.methods={start,append,checkpoint,park,resume,active};',context);
    return{...state,state,methods:context.methods};
}
async function prepared(){
    const h=rig(),meta={id:crypto.randomUUID(),name:'checkpoint.bin',mime:'application/octet-stream',size:3*16384};
    const prefix=Buffer.alloc(16384,0x6a),tail=Buffer.alloc(8192,0x5b);
    await h.methods.start(meta);await h.methods.append(meta.id,arrayBuffer(prefix));
    await h.methods.checkpoint(meta.id,digest(prefix),true);await h.methods.append(meta.id,arrayBuffer(tail));
    return{...h,meta,prefix,tail,previous:Buffer.from(h.state.files.get(meta.id+'.json').bytes)};
}
function retained(h){
    const part=h.state.files.get(h.meta.id+'.part');
    assert.equal(h.state.files.size,2);assert.equal(h.state.eraseCalls,0,'parking must never erase file data');
    assert.deepEqual(h.state.files.get(h.meta.id+'.json').bytes,h.previous,'the previous committed metadata remains intact');
    assert.deepEqual(part.bytes,Buffer.concat([h.prefix,h.tail]),'the uncommitted tail is preserved until explicit resume rollback');
    assert.equal(h.methods.active.has(h.meta.id),false,'the failed park must release its active ownership');
    return part;
}
for(const [stage,name] of [['write','QuotaExceededError'],['open','NotAllowedError'],['commit','NoModificationAllowedError']]){
    test('park releases its access handle after metadata '+stage+' fails with '+name+' and preserves resumable checkpoint',async()=>{
        const h=await prepared(),error=new DOMException('synthetic storage failure',name);
        h.state.writerFault={stage,error};
        await assert.rejects(h.methods.park(h.meta.id,digest(Buffer.concat([h.prefix,h.tail]))),received=>received===error);
        const part=retained(h);assert.equal(part.locked,false);assert.equal(h.state.closeCalls,1);
        h.state.writerFault=null;
        const resumed=await h.methods.resume(h.meta.id,h.meta);
        assert.equal(resumed.meta.offset,h.prefix.length);assert.equal(resumed.meta.prefixSha256,digest(h.prefix));
        assert.deepEqual(Buffer.from(await resumed.snapshot.arrayBuffer()),h.prefix);
        assert.deepEqual(part.bytes,h.prefix,'resume truncates only to the last published offset');
        await h.methods.park(h.meta.id,digest(h.prefix));assert.equal(part.locked,false);
    });
}
test('park also releases after data flush fails without publishing or deleting the prior checkpoint',async()=>{
    const h=await prepared(),error=new DOMException('flush failure','NotAllowedError');h.state.flushError=error;
    await assert.rejects(h.methods.park(h.meta.id,digest(h.prefix)),received=>received===error);
    assert.equal(retained(h).locked,false);h.state.flushError=null;
    const resumed=await h.methods.resume(h.meta.id,h.meta);assert.equal(resumed.meta.prefixSha256,digest(h.prefix));
    await h.methods.park(h.meta.id,digest(h.prefix));
});
test('a close failure cannot replace the primary checkpoint error or claim physical lock release',async()=>{
    const h=await prepared(),primary=new DOMException('quota','QuotaExceededError'),close=new DOMException('close','InvalidStateError');
    h.state.writerFault={stage:'write',error:primary};h.state.closeError=close;
    await assert.rejects(h.methods.park(h.meta.id,digest(h.prefix)),received=>received===primary);
    assert.equal(retained(h).locked,true,'a throwing native close may leave the physical lock held');assert.equal(h.state.closeCalls,1);
    h.state.writerFault=null;h.state.closeError=null;
    await assert.rejects(h.methods.resume(h.meta.id,h.meta),/另一标签页/);
    assert.equal(h.state.eraseCalls,0);
});
test('a close failure after a successful checkpoint rejects instead of reporting a successful park',async()=>{
    const h=await prepared(),error=new DOMException('close','InvalidStateError'),all=Buffer.concat([h.prefix,h.tail]);h.state.closeError=error;
    await assert.rejects(h.methods.park(h.meta.id,digest(all)),received=>received===error);
    assert.equal(h.methods.active.has(h.meta.id),false);assert.equal(h.state.files.get(h.meta.id+'.part').locked,true);
    const saved=JSON.parse(h.state.files.get(h.meta.id+'.json').bytes);
    assert.equal(saved.offset,all.length);assert.equal(saved.prefixSha256,digest(all));assert.equal(h.state.eraseCalls,0);
});
test('successful park commits the complete current prefix and then releases ownership without deleting data',async()=>{
    const h=await prepared(),all=Buffer.concat([h.prefix,h.tail]);assert.equal(await h.methods.park(h.meta.id,digest(all)),true);
    assert.equal(h.methods.active.has(h.meta.id),false);assert.equal(h.state.files.get(h.meta.id+'.part').locked,false);
    const resumed=await h.methods.resume(h.meta.id,h.meta);assert.equal(resumed.meta.offset,all.length);assert.equal(resumed.meta.prefixSha256,digest(all));
    assert.deepEqual(Buffer.from(await resumed.snapshot.arrayBuffer()),all);await h.methods.park(h.meta.id,digest(all));
    assert.equal(h.state.eraseCalls,0);assert.equal(await h.methods.park(crypto.randomUUID(),digest(all)),false);
});
