'use strict';
// This module never receives room/peer credentials and cannot send a file.
// Exercise actual metadata/rehash/CAS policies with a shared lock/storage rig.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {webcrypto,createHash}=require('node:crypto');
const source=fs.readFileSync('client/scripts/send-queue-store.js','utf8');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const checksum=value=>createHash('sha256').update(value).digest('hex');
async function rig() {
    const{sha256}=await import('@noble/hashes/sha2.js');let now=1794000000000;
    const values=new Map();let writeError=null,readError=null,writes=0;
    const storage={getItem(key){if(readError)throw readError;return values.get(key)??null;},setItem(key,value){if(writeError)throw writeError;writes++;values.set(key,value);},removeItem(key){values.delete(key);}};
    const locks={tail:Promise.resolve(),request(name,options,fn){assert.equal(options.mode,'exclusive');const job=this.tail.then(fn);this.tail=job.catch(()=>{});return job;}};
    const window={ZeydropHash:sha256},context=vm.createContext({window,navigator:{locks},crypto:webcrypto,TextEncoder,Uint8Array,Date});
    vm.runInContext(source+'\nthis.Store=ZeydropSendQueueStore;',context);
    const make=options=>new context.Store({storage,locks,hashFactory:()=>sha256.create(),randomUUID:()=>webcrypto.randomUUID(),now:()=>now,...options});
    return{store:make(),make,values,storage,locks,window,setNow:value=>now=value,now:()=>now,
        writeError:error=>writeError=error,readError:error=>readError=error,writes:()=>writes};
}
const file=(content,name='文件.txt',type='text/plain')=>new File([content],name,{type,lastModified:1700000000000});
function delayed(original) {
    const started=deferred(),release=deferred();let reads=0;
    return{started,release,reads:()=>reads,selected:{name:original.name,size:original.size,type:original.type,lastModified:original.lastModified,
        slice(start,end){return{async arrayBuffer(){reads++;started.resolve();await release.promise;return original.slice(start,end).arrayBuffer();}};}}};
}
test('saving and reselecting require explicit user consent before any file read',async()=>{
    const h=await rig(), item=delayed(file('secret'));
    await assert.rejects(h.store.save([item.selected],{expectedRevision:null}),{name:'QueueConsentError'});
    assert.equal(item.reads(),0);assert.equal(h.values.size,0);
    const snapshot=await h.store.save([file('secret')],{optIn:true,expectedRevision:null});
    await assert.rejects(h.store.reselect(snapshot.revision,[item.selected]),{name:'QueueConsentError'});
    assert.equal(item.reads(),0);
});
test('only bounded metadata and full SHA-256 are persisted, never bodies, File handles or credentials',async()=>{
    const h=await rig(), bytes=Buffer.from('PRIVATE_FILE_BODY_SENTINEL');
    const selected=[file(bytes,'中文 []+#&.txt'),file('', 'empty.bin','')];
    const snapshot=await h.store.save(selected,{optIn:true,expectedRevision:null});
    assert.equal(h.store.storageKey,'zeydrop-send-queue-v1');assert.equal(h.values.size,1);
    const text=h.values.get(h.store.storageKey),saved=JSON.parse(text);
    assert.ok(!text.includes('PRIVATE_FILE_BODY_SENTINEL'));assert.equal(saved.files[0].sha256,checksum(bytes));
    assert.equal(saved.files[1].sha256,checksum(Buffer.alloc(0)));assert.equal(saved.files[1].mime,'application/octet-stream');
    assert.equal(saved.files[0].name,selected[0].name);assert.notEqual(saved.files[0].entryId,saved.files[1].entryId);
    assert.deepEqual(Object.keys(saved).sort(),['createdAt','expiresAt','files','revision','version']);
    assert.deepEqual(Object.keys(saved.files[0]).sort(),['entryId','lastModified','mime','name','sha256','size']);
    snapshot.files[0].name='changed returned object';assert.equal((await h.store.load()).files[0].name,selected[0].name);
});
test('all reselected contents are hashed and returned in the original queue order',async()=>{
    const h=await rig(),a=file('first','a.bin'),b=file('second','b.bin');
    const snapshot=await h.store.save([a,b],{optIn:true,expectedRevision:null});
    const a2=file('first','a.bin'),b2=file('second','b.bin');
    const result=await h.store.reselect(snapshot.revision,[b2,a2],{confirmed:true});
    assert.equal(result.files[0],a2);assert.equal(result.files[1],b2);assert.equal(result.snapshot.revision,snapshot.revision);
    await assert.rejects(h.store.reselect(snapshot.revision,[file('FIRST','a.bin'),b2],{confirmed:true}),{name:'QueueFileMismatchError'});
    const unread=delayed(a2);
    await assert.rejects(h.store.reselect(snapshot.revision,[unread.selected],{confirmed:true}),{name:'QueueFileMismatchError'});
    assert.equal(unread.reads(),0);assert.equal((await h.store.load()).revision,snapshot.revision);
});
test('removeEntry is revision-checked and preserves the original expiry, including final deletion',async()=>{
    const h=await rig();let snapshot=await h.store.save([file('a','a'),file('b','b')],{optIn:true,expectedRevision:null});
    const original=snapshot;h.setNow(h.now()+3600000);
    snapshot=await h.store.removeEntry(snapshot.files[0].entryId,{expectedRevision:snapshot.revision});
    assert.notEqual(snapshot.revision,original.revision);assert.equal(snapshot.createdAt,original.createdAt);assert.equal(snapshot.expiresAt,original.expiresAt);
    assert.equal(snapshot.files[0].entryId,original.files[1].entryId);
    await assert.rejects(h.store.removeEntry(snapshot.files[0].entryId,{expectedRevision:original.revision}),{name:'QueueConflictError'});
    assert.equal(await h.store.removeEntry(snapshot.files[0].entryId,{expectedRevision:snapshot.revision}),null);assert.equal(await h.store.load(),null);
});
test('updates do not silently extend TTL and expired records are cleared when inspected',async()=>{
    const h=await rig(),a=file('a');const old=await h.store.save([a],{optIn:true,expectedRevision:null});
    h.setNow(h.now()+1000);const updated=await h.store.save([a],{optIn:true,expectedRevision:old.revision});
    assert.equal(updated.createdAt,old.createdAt);assert.equal(updated.expiresAt,old.expiresAt);
    h.setNow(old.expiresAt);await assert.rejects(h.store.load(),{name:'QueueExpiredError'});assert.equal(h.values.size,0);
    assert.equal(await h.store.load(),null);
});
test('corrupt/future/oversized or duplicate-entry metadata cannot be rebound and needs explicit cleanup',async()=>{
    const h=await rig(),snapshot=await h.store.save([file('a')],{optIn:true,expectedRevision:null});
    const samples=['{truncated','x'.repeat(128*1024+1),JSON.stringify({...snapshot,createdAt:h.now()+120000}),
        JSON.stringify({...snapshot,files:[snapshot.files[0],snapshot.files[0]]})];
    for(const text of samples){h.values.set(h.store.storageKey,text);await assert.rejects(h.store.load(),{name:'QueueCorruptError'});assert.equal(h.values.get(h.store.storageKey),text);}
    await assert.rejects(h.store.clearCorrupt(),{name:'QueueConsentError'});
    await h.store.clearCorrupt({confirmed:true});assert.equal(h.values.size,0);
    const fresh=await h.store.save([file('b')],{optIn:true,expectedRevision:null});
    await assert.rejects(h.store.clearCorrupt({confirmed:true}),{name:'QueueConflictError'});assert.equal((await h.store.load()).revision,fresh.revision);
});
test('two tabs saving the same prior revision cannot overwrite one another',async()=>{
    const h=await rig(),other=h.make();
    const results=await Promise.allSettled([h.store.save([file('one')],{optIn:true,expectedRevision:null}),other.save([file('two')],{optIn:true,expectedRevision:null})]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected').reason.name,'QueueConflictError');assert.equal(h.writes(),1);
    const snapshot=await h.store.load();await other.clear({expectedRevision:snapshot.revision});
    await assert.rejects(h.store.clear({expectedRevision:snapshot.revision}),{name:'QueueConflictError'});
});
test('a queue changed while File hashing is pending cannot be restored from stale metadata',async()=>{
    const h=await rig(),a=file('alpha'),snapshot=await h.store.save([a],{optIn:true,expectedRevision:null}),late=delayed(a);
    const matching=h.store.reselect(snapshot.revision,[late.selected],{confirmed:true});await late.started.promise;
    await h.make().clear({expectedRevision:snapshot.revision});late.release.resolve();
    await assert.rejects(matching,{name:'QueueConflictError'});assert.equal(await h.store.load(),null);
});
test('a late save cannot overwrite a completion update from another tab',async()=>{
    const h=await rig(),a=file('alpha','a'),b=file('beta','b');
    const original=await h.store.save([a,b],{optIn:true,expectedRevision:null}),late=delayed(a);
    const saving=h.store.save([late.selected],{optIn:true,expectedRevision:original.revision});await late.started.promise;
    const updated=await h.make().removeEntry(original.files[0].entryId,{expectedRevision:original.revision});
    late.release.resolve();await assert.rejects(saving,{name:'QueueConflictError'});
    const found=await h.store.load();assert.equal(found.revision,updated.revision);assert.equal(found.files[0].entryId,original.files[1].entryId);
});
test('unknown fields, invalid entry IDs and altered TTL cannot become selected files',async()=>{
    const h=await rig(),snapshot=await h.store.save([file('a')],{optIn:true,expectedRevision:null});
    for(const changed of [
        {...snapshot,peerToken:'must-not-be-accepted'},
        {...snapshot,expiresAt:snapshot.expiresAt+1},
        {...snapshot,files:[{...snapshot.files[0],entryId:'untrusted'}]},
        {...snapshot,files:[{...snapshot.files[0],sourceHandle:{}}]}
    ]){
        h.values.set(h.store.storageKey,JSON.stringify(changed));
        await assert.rejects(h.store.reselect(snapshot.revision,[file('a')],{confirmed:true}),{name:'QueueCorruptError'});
    }
});
test('short or malformed file reads cannot replace a valid saved manifest',async()=>{
    const h=await rig(),original=await h.store.save([file('original')],{optIn:true,expectedRevision:null});
    const raw=h.values.get(h.store.storageKey);
    for(const result of [new ArrayBuffer(3),{byteLength:5},null]){
        const bad={name:'bad',size:5,type:'text/plain',lastModified:0,slice(){return{async arrayBuffer(){return result;}};}};
        await assert.rejects(h.store.save([bad],{optIn:true,expectedRevision:original.revision}),{name:'QueueFileMismatchError'});
        assert.equal(h.values.get(h.store.storageKey),raw);
    }
});
test('quota/permission failures propagate and cannot destroy the previously saved queue',async()=>{
    const h=await rig(),snapshot=await h.store.save([file('a')],{optIn:true,expectedRevision:null});
    const quota=new DOMException('quota','QuotaExceededError');h.writeError(quota);
    await assert.rejects(h.store.save([file('b')],{optIn:true,expectedRevision:snapshot.revision}),{name:'QuotaExceededError'});
    assert.equal((await h.store.load()).revision,snapshot.revision);h.writeError(null);
    h.readError(new DOMException('blocked','SecurityError'));await assert.rejects(h.store.load(),{name:'SecurityError'});
});
test('file hashing is chunked and cancellable before metadata commit',async()=>{
    const h=await rig(),content=file(Buffer.alloc(2*256*1024+19)),late=delayed(content),abort=new AbortController();
    const saving=h.store.save([late.selected],{optIn:true,expectedRevision:null,signal:abort.signal});await late.started.promise;
    abort.abort();late.release.resolve();await assert.rejects(saving,{name:'AbortError'});assert.equal(late.reads(),1);assert.equal(h.values.size,0);
    const sizes=[],probe={name:content.name,size:content.size,type:content.type,lastModified:content.lastModified,slice(start,end){sizes.push(end-start);return content.slice(start,end);}};
    await h.store.save([probe],{optIn:true,expectedRevision:null});assert.deepEqual(sizes,[256*1024,256*1024,19]);
});
test('file count, safe numeric size, metadata bytes and unsupported lock boundaries fail closed',async()=>{
    const h=await rig();for(const files of [[],Array.from({length:101},()=>file('x'))])await assert.rejects(h.store.save(files,{optIn:true,expectedRevision:null}),{name:'QueueLimitError'});
    await assert.rejects(h.store.save([file('x','../path')],{optIn:true,expectedRevision:null}),{name:'QueueFileMismatchError'});
    const huge={name:'huge',size:Number.MAX_SAFE_INTEGER,type:'text/plain',lastModified:0,slice(){throw Error('must reject before IO');}};
    await assert.rejects(h.store.save([huge,file('x')],{optIn:true,expectedRevision:null}),{name:'QueueLimitError'});
    const oversized=Array.from({length:100},()=>({name:'\ud800'.repeat(255),size:0,type:'text/plain',lastModified:0,slice(){throw Error('zero-size file has no IO');}}));
    await assert.rejects(h.store.save(oversized,{optIn:true,expectedRevision:null}),{name:'QueueLimitError'});
    const unsupported=h.make({locks:{}});assert.equal(unsupported.supported,false);await assert.rejects(unsupported.load(),{name:'QueueUnsupportedError'});assert.equal(h.values.size,0);
});
