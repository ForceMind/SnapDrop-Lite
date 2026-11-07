'use strict';
// Failure of a disk write begun on the old peer must reach the replacement
// owner of a held transfer; a failed/aborted sink cannot be resurrected.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}; };
async function fixture() {
    const {sha256}=await import('@noble/hashes/sha2.js');
    const writing=deferred(),disk=deferred(),frames=[];let aborted=0,oldAlive=true;
    const context=vm.createContext({
        crypto:crypto.webcrypto,performance,TextEncoder,Uint8Array,Blob,File,
        setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
        Events:{fire(){}},window:{ZeydropHash:sha256,showSaveFilePicker:async()=>({createWritable:async()=>({
            async write(){writing.resolve();await disk.promise;},async close(){},async abort(){aborted++;}
        })})}
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.Peer=TransferPeer;',context);
    function peer(verified){const p=new context.Peer({},'same-authorized-peer');p._remoteHello=true;p._verified=verified;p._path={direct:true};p._isConnected=()=>true;p._connectionEvent=()=>{};p._send=data=>frames.push(JSON.parse(data));return p;}
    const original=peer(true),replacement=peer(false),id='a'.repeat(32);
    await original._onMessage(JSON.stringify({type:'offer',id,name:'write-failure.bin',size:32768,mime:'application/octet-stream'}));
    await original.acceptIncoming(id);
    original._isConnected=()=>oldAlive;
    original._receive(new Uint8Array(16384).buffer,()=>oldAlive);
    await writing.promise;oldAlive=false;original.suspendTransfers('network interrupted during disk write');
    const hold=original.takeHeldTransfers();assert.ok(hold?.incoming);
    replacement.adoptHeldTransfers(hold);
    return{original,replacement,id,disk,frames,aborted:()=>aborted};
}
for(const verifyEarly of [false,true])test('old-peer write failure cannot revive on replacement '+(verifyEarly?'after early verification':'before new verification'),async()=>{
    const h=await fixture();
    if(verifyEarly){h.replacement._verified=true;h.replacement.restoreTransfers();}
    const error=new Error('disk full');error.name='QuotaExceededError';h.disk.reject(error);
    await h.original._messageChain;await new Promise(resolve=>setImmediate(resolve));
    if(!verifyEarly){h.replacement._verified=true;h.replacement.restoreTransfers();}
    try{
        assert.equal(h.replacement._incoming,null,'replacement must revoke the failed incoming transfer');
        assert.equal(h.replacement._held,null,'replacement cannot retain or resurrect a failed checkpoint');
        assert.ok(h.aborted()>0);
    }finally{h.replacement.abortAll('fixture cleanup');}
});
test('an old-peer write that succeeds after adoption still advances the shared checkpoint',async()=>{
    const h=await fixture();h.replacement._verified=true;h.replacement.restoreTransfers();
    h.disk.resolve();await h.original._messageChain;
    try{
        const state=h.replacement._incoming;
        assert.ok(state);assert.equal(state.offset,16384);assert.equal(state.sink.size,16384);
        assert.equal(Buffer.from(state.hash.clone().digest()).toString('hex'),crypto.createHash('sha256').update(Buffer.alloc(16384)).digest('hex'));
        assert.equal(h.aborted(),0,'ownership transfer cannot drop a valid in-flight write');
    }finally{h.replacement.abortAll('fixture cleanup');}
});
test('late failure cannot cancel a fresh offer merely because its transfer ID was reused',async()=>{
    const h=await fixture();h.replacement._verified=true;h.replacement.restoreTransfers();
    h.replacement.cancel(h.id,'user cancelled the adopted receive');
    await h.replacement._onMessage(JSON.stringify({type:'offer',id:h.id,name:'fresh-offer.bin',size:10,mime:'application/octet-stream'}));
    const fresh=h.replacement._incoming;
    h.disk.reject(Error('old disk operation failed'));await h.original._messageChain;
    await new Promise(resolve=>setImmediate(resolve));
    try{
        assert.equal(h.replacement._incoming,fresh);assert.equal(fresh.meta.name,'fresh-offer.bin');
        assert.equal(fresh.error,undefined);assert.equal(fresh.sink,undefined);
    }finally{h.replacement.abortAll('fixture cleanup');}
});
