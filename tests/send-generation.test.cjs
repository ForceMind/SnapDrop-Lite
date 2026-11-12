'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {webcrypto}=require('node:crypto');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function gate(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function setup(){
    const {sha256}=await import('@noble/hashes/sha2.js'),sent=[],events=[];
    const context=vm.createContext({window:{ZeydropHash:sha256},crypto:webcrypto,TextEncoder,Uint8Array,Blob,File,performance,
        setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
        Events:{fire:(type,detail)=>events.push({type,detail})}});
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.T=TransferPeer;',context);
    const peer=new context.T({},'peer');Object.assign(peer,{_verified:true,_remoteHello:true,_path:{direct:true},_isConnected:()=>true,_waitForDrain:async()=>{},_send:data=>sent.push(data),close:()=>{}});
    const state={file:new File([new Uint8Array(16384)],'same-file.bin'),meta:{id:'a'.repeat(32),name:'same-file.bin',size:16384,mime:''},phase:'sending',offset:0,acked:0,hash:sha256.create(),start:performance.now()};
    peer._outgoing=state;
    return {peer,state,sent,events,empty:Buffer.from(sha256(new Uint8Array())).toString('hex')};
}
test('an old pending File read cannot send into a restored same-peer transfer',async()=>{
    const h=await setup(),read=gate(),entered=gate();let reads=0;
    h.state.file={slice:()=>({arrayBuffer:()=>{if(++reads===1){entered.resolve();return read.promise;}return Promise.resolve(new ArrayBuffer(16384));}})};
    const old=h.peer._pump(h.state);await entered.promise;
    h.peer.suspendTransfers('drop');h.peer.restoreTransfers();
    await h.peer._resumeFromOffset({id:h.state.meta.id,offset:0,sha256:h.empty});
    for(let i=0;i<10&&!h.state.waiter;i++)await turn();
    try{
        assert.ok(h.state.waiter,'resumed sender reached its new persisted ACK window');
        read.resolve(new ArrayBuffer(16384));await turn();
        assert.equal(h.sent.filter(data=>typeof data!=='string').length,1,'old attempt cannot append a duplicate block');
        assert.equal(h.state.offset,16384);await old;
    }finally{read.resolve(new ArrayBuffer(16384));h.peer.abortAll('cleanup');}
});
test('a retired prefix hash cannot authorize the next same-page recovery attempt',async()=>{
    const h=await setup(),read=gate();h.state.phase='offered';
    h.state.file={slice:()=>({arrayBuffer:()=>read.promise})};
    const prefix=await import('@noble/hashes/sha2.js');const digest=Buffer.from(prefix.sha256(new Uint8Array(16384))).toString('hex');
    const old=h.peer._resumeFromOffset({id:h.state.meta.id,offset:16384,sha256:digest});await turn();
    h.peer.suspendTransfers('second drop');h.peer.restoreTransfers();
    try{
        read.resolve(new ArrayBuffer(16384));await old;
        const controls=h.sent.filter(data=>typeof data==='string').map(data=>JSON.parse(data).type);
        assert.ok(!controls.includes('resume-confirm'),'only the current receiver handshake can authorize a prefix');
        assert.equal(h.state.phase,'resuming');assert.equal(h.state.offset,0);assert.equal(h.state.resumeBusy,false);
    }finally{h.peer.abortAll('cleanup');}
});
test('an obsolete backpressure rejection cannot cancel a restored transfer',async()=>{
    const h=await setup(),drain=gate();h.peer._waitForDrain=()=>drain.promise;
    const old=h.peer._pump(h.state);await turn();
    h.peer.suspendTransfers('drop');h.peer.restoreTransfers();
    try{
        drain.reject(Error('old channel closed'));await old;
        assert.equal(h.peer._outgoing,h.state);assert.equal(h.state.phase,'resuming');
        assert.ok(!h.events.some(e=>e.type==='transfer-state'&&e.detail.phase==='cancelled'));
    }finally{h.peer.abortAll('cleanup');}
});
test('late async errors from an obsolete receive wire do not close the current channel',async()=>{
    const h=await setup(),blocked=gate();let valid=true,closed=0;
    h.peer._protocolError=()=>closed++;h.peer._onMessage=()=>blocked.promise;
    h.peer._receive('control',()=>valid);await turn();valid=false;
    blocked.reject(Error('old async work'));await h.peer._messageChain;
    assert.equal(closed,0);assert.equal(h.peer._queuedBytes,0);h.peer.abortAll('cleanup');
});
test('checkpoint quota failure cancels the file without closing the direct channel',async()=>{
    const h=await setup();h.peer._outgoing=null;let aborted=0;
    const error=Error('full');error.name='QuotaExceededError';
    h.peer._incoming={meta:h.state.meta,offset:0,acked:0,hash:h.state.hash,start:performance.now(),sink:{checkpoint:async()=>{throw error;},abort:async()=>aborted++}};
    await h.peer._onMessage(JSON.stringify({type:'checkpoint',id:h.state.meta.id,offset:0}));
    assert.equal(h.peer._incoming,null);assert.equal(aborted,1);
    assert.ok(h.events.some(e=>e.type==='transfer-state'&&/保存空间不足/.test(e.detail.error||'')));
});
