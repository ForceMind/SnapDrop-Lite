'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {createHash}=require('node:crypto');
const bridge=fs.readFileSync('client/scripts/file-hash.js','utf8');
const workerSource=fs.readFileSync('client/scripts/file-hash-worker.js','utf8').replace(/^import[^\n]+\n/,'');
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function rig(options={}) {
    const{sha256}=await import('@noble/hashes/sha2.js');const events={};
    const window={ZeydropHash:sha256};
    const context=vm.createContext({window,Blob,File,URL,Uint8Array,TextEncoder,setTimeout,clearTimeout,queueMicrotask,
        document:{currentScript:{src:'https://example.test/app/scripts/file-hash.js?v=fixture'}},
        addEventListener:(name,fn)=>events[name]=fn});
    vm.runInContext(bridge+'\nthis.Hasher=ZeydropFileHasher;',context);
    return{hasher:new context.Hasher({Worker:undefined,hashFactory:()=>sha256.create(),...options}),context,events,sha256};
}
function fakeWorkers(){
    const instances=[];
    class Worker {
        constructor(url){this.url=url;this.messages=[];this.terminated=false;instances.push(this);}
        postMessage(data){this.messages.push(data);}
        terminate(){this.terminated=true;}
        send(data){this.onmessage({data});}
    }
    return{Worker,instances};
}
const complete=(worker,bytes)=>{const request=worker.messages.at(-1).request;worker.send({type:'complete',request,bytes:bytes.length,sha256:checksum(bytes)});};
test('main fallback hashes native Blob/File in bounded slices, including zero bytes',async()=>{
    const h=await rig();let largest=0;const read=h.hasher._read.bind(h.hasher);
    h.hasher._read=(blob,start,end)=>{largest=Math.max(largest,end-start);return read(blob,start,end);};
    for(const bytes of [Buffer.alloc(0),Buffer.from('中文 SHA-256'),Buffer.alloc(2*256*1024+7,0x5a)]){
        const progress=[],result=await h.hasher.hash(new File([bytes],'private-name.bin'),{onProgress:item=>progress.push(item)});
        assert.equal(result.sha256,checksum(bytes));assert.equal(result.bytes,bytes.length);assert.equal(result.backend,'main');
        assert.equal(progress[0].bytes,0);assert.equal(progress.at(-1).bytes,bytes.length);
        assert.ok(progress.every(item=>Object.keys(item).sort().join(',')==='bytes,total'&&item.total===bytes.length));
    }
    assert.equal(largest,256*1024);
    await assert.rejects(h.hasher.hash({size:10,slice(){throw Error('must not read');}}),{name:'TypeError'});
});
test('worker receives a Blob view without File metadata and uses the script version query',async()=>{
    const f=fakeWorkers(),h=await rig({Worker:f.Worker}),bytes=Buffer.from('worker'),blob=new File([bytes],'PRIVATE_NAME.bin',{lastModified:1700000000000});
    const result=h.hasher.hash(blob),worker=f.instances[0],message=worker.messages[0];
    assert.equal(worker.url,'https://example.test/app/scripts/file-hash-worker.js?v=fixture');
    assert.notEqual(message.blob,blob);assert.equal(message.blob instanceof Blob,true);assert.equal(message.blob instanceof File,false);
    assert.equal(message.blob.name,undefined);assert.equal(message.blob.lastModified,undefined);
    assert.deepEqual(Buffer.from(await message.blob.arrayBuffer()),bytes);assert.deepEqual(Object.keys(message).sort(),['blob','request','type']);
    complete(worker,bytes);const value=await result;assert.equal(value.sha256,checksum(bytes));assert.equal(value.backend,'worker');
});
test('one active task and four waiting tasks bound retained file references',async()=>{
    const f=fakeWorkers(),h=await rig({Worker:f.Worker}),blob=new Blob(['q']);
    const jobs=Array.from({length:5},()=>h.hasher.hash(blob));
    await assert.rejects(h.hasher.hash(blob),{name:'HashBusyError'});
    assert.equal(f.instances.length,1);assert.equal(f.instances[0].messages.length,1);
    h.hasher.cancelAll();for(const job of jobs)await assert.rejects(job,{name:'AbortError'});
    assert.equal(h.hasher._queue.length,0);assert.equal(h.hasher._active,null);assert.equal(f.instances[0].terminated,true);
});
test('queued cancellation never terminates the active task; active cancellation isolates old worker events',async()=>{
    const f=fakeWorkers(),h=await rig({Worker:f.Worker}),bytes=Buffer.from('abc'),blob=new Blob([bytes]);
    const activeAbort=new AbortController(),queuedAbort=new AbortController();
    const first=h.hasher.hash(blob,{signal:activeAbort.signal}),old=f.instances[0],oldMessage=old.onmessage,oldError=old.onerror;
    const queued=h.hasher.hash(blob,{signal:queuedAbort.signal});queuedAbort.abort();
    await assert.rejects(queued,{name:'AbortError'});assert.equal(old.terminated,false);
    activeAbort.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(old.terminated,true);
    const next=h.hasher.hash(blob),fresh=f.instances[1];
    oldMessage({data:{type:'complete',request:old.messages[0].request,bytes:3,sha256:checksum(bytes)}});oldError();
    assert.equal(h.hasher._worker,fresh);assert.equal(h.hasher._active.done,false);
    complete(fresh,bytes);assert.equal((await next).backend,'worker');
});
test('malformed/future worker responses fail closed, while old task messages cannot complete a new task',async()=>{
    for(const payload of [request=>({type:'complete',request,bytes:3,sha256:'0'.repeat(64),extra:true}),
        request=>({type:'progress',request,bytes:4,total:3}),request=>({type:'error',request,errorName:'UntrustedError'}),
        request=>({type:'complete',request:request+1,bytes:3,sha256:'0'.repeat(64)})]){
        const f=fakeWorkers(),h=await rig({Worker:f.Worker}),job=h.hasher.hash(new Blob(['abc']));
        f.instances[0].send(payload(f.instances[0].messages[0].request));
        await assert.rejects(job,{name:'HashProtocolError'});assert.equal(f.instances[0].terminated,true);
    }
    const f=fakeWorkers(),h=await rig({Worker:f.Worker}),blob=new Blob(['abc']);
    const first=h.hasher.hash(blob),worker=f.instances[0];complete(worker,Buffer.from('abc'));await first;
    const next=h.hasher.hash(blob);worker.send({type:'complete',request:1,bytes:3,sha256:'0'.repeat(64)});
    assert.equal(h.hasher._active.done,false);complete(worker,Buffer.from('abc'));await next;
});
test('worker failure/timeout/postMessage errors do not silently rehash on the main thread',async()=>{
    const f=fakeWorkers(),h=await rig({Worker:f.Worker,timeoutMs:20});let mainReads=0;h.hasher._read=()=>{mainReads++;throw Error();};
    const crashed=h.hasher.hash(new Blob(['abc']));let prevented=false;
    f.instances[0].onerror({preventDefault(){prevented=true;}});await assert.rejects(crashed,{name:'HashWorkerError'});assert.equal(prevented,true);
    const timed=h.hasher.hash(new Blob(['abc']));await assert.rejects(timed,{name:'HashTimeoutError'});
    assert.equal(f.instances[1].terminated,true);assert.equal(mainReads,0);
    const fresh=h.hasher.hash(new Blob(['abc']));f.instances[2].onmessageerror();await assert.rejects(fresh,{name:'HashWorkerError'});
    class BadWorker{postMessage(){throw new DOMException('private','DataCloneError');}terminate(){}}
    const bad=await rig({Worker:BadWorker});await assert.rejects(bad.hasher.hash(new Blob(['abc'])),{name:'HashWorkerError'});
    class BlockedWorker{constructor(){throw new DOMException('private-url','SecurityError');}}
    const blocked=await rig({Worker:BlockedWorker});await assert.rejects(blocked.hasher.hash(new Blob(['abc'])),{name:'HashWorkerError'});
});
test('native read error names are fixed and file names/read messages never escape worker replies',async()=>{
    const f=fakeWorkers(),h=await rig({Worker:f.Worker}),job=h.hasher.hash(new Blob(['abc']));
    f.instances[0].send({type:'error',request:1,errorName:'NotReadableError'});
    await assert.rejects(job,error=>error.name==='NotReadableError'&&!error.message.includes('private'));
    const fallback=await rig();fallback.hasher._read=()=>{throw new DOMException('private-path.txt','NotReadableError');};
    await assert.rejects(fallback.hasher.hash(new Blob(['abc'])),error=>error.name==='NotReadableError'&&!error.message.includes('private-path'));
});
test('main fallback aborts late reads, rejects short reads, and captures progress callbacks',async()=>{
    const h=await rig(),read=deferred(),controller=new AbortController();
    h.hasher._read=()=>read.promise;const job=h.hasher.hash(new Blob(['abc']),{signal:controller.signal});
    controller.abort();await assert.rejects(job,{name:'AbortError'});read.resolve(new ArrayBuffer(3));await tick();
    h.hasher._read=async()=>new ArrayBuffer(2);await assert.rejects(h.hasher.hash(new Blob(['abc'])),{name:'HashReadError'});
    await assert.rejects(h.hasher.hash(new Blob(['abc']),{onProgress(){throw Error('private');}}),{name:'HashReadError'});
    assert.equal(h.hasher._active,null);
});
test('pagehide aborts current/waiting jobs but leaves the singleton reusable after BFCache return',async()=>{
    const f=fakeWorkers(),h=await rig({Worker:f.Worker});
    const first=h.hasher.hash(new Blob(['a'])),queued=h.hasher.hash(new Blob(['b']));h.events.pagehide();
    await assert.rejects(first,{name:'AbortError'});await assert.rejects(queued,{name:'AbortError'});
    const next=h.hasher.hash(new Blob(['c']));complete(f.instances.at(-1),Buffer.from('c'));await next;
});
test('progress messages are monotonic, bounded to 10 Hz, and receive a final completion update',async()=>{
    let now=1000;const f=fakeWorkers(),h=await rig({Worker:f.Worker,now:()=>now}),progress=[];
    const job=h.hasher.hash(new Blob(['abc']),{onProgress:value=>progress.push(value)}),worker=f.instances[0];
    worker.send({type:'progress',request:1,bytes:1,total:3});worker.send({type:'progress',request:1,bytes:2,total:3});
    assert.equal(progress.length,1);now+=100;worker.send({type:'progress',request:1,bytes:2,total:3});
    complete(worker,Buffer.from('abc'));await job;assert.equal(progress.length,3);assert.equal(progress.at(-1).bytes,3);
});
test('actual worker implementation hashes standard vectors and rejects message/body lookalikes',async()=>{
    const{sha256}=await import('@noble/hashes/sha2.js'),messages=[];
    const context=vm.createContext({sha256,Blob,Uint8Array,Date:{now:()=>1000},self:{postMessage:value=>messages.push(value)}});
    vm.runInContext(workerSource,context);
    for(const bytes of [Buffer.alloc(0),Buffer.from('abc'),Buffer.alloc(2*256*1024+11,0x6b)]){
        messages.length=0;context.self.onmessage({data:{type:'hash',request:1,blob:new Blob([bytes])}});
        while(!messages.some(value=>value.type==='complete'||value.type==='error'))await tick();
        const done=messages.at(-1);assert.equal(done.type,'complete');assert.equal(done.sha256,checksum(bytes));assert.equal(done.bytes,bytes.length);
        assert.ok(messages.filter(value=>value.type==='progress').length<=2);
    }
    messages.length=0;context.self.onmessage({data:{type:'hash',request:2,blob:{size:3},name:'private'}});await tick();
    assert.equal(messages[0].type,'error');assert.equal(messages[0].errorName,'HashReadError');
    assert.deepEqual(Object.keys(messages[0]).sort(),['errorName','request','type']);
});
