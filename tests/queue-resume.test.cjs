'use strict';
// In-page queue restoration never bypasses renewed identity or receiver consent.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
async function rig() {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const frames = [], events = [];
    const context = {
        crypto: webcrypto, performance, File, Blob, TextEncoder,
        setTimeout: (cb,ms) => {const t=setTimeout(cb,ms);t.unref?.();return t;},
        clearTimeout, Uint8Array,
        window: { ZeydropHash: sha256, ZEYDROP_CONFIG: {} },
        Events: { fire: (type,detail) => events.push({type,detail}) }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.Peer = TransferPeer;',context);
    function peer(verified=true) {
        const p=new context.Peer({},'same-authorized-peer');
        p._verified=verified;p._remoteHello=true;p._path={direct:true};
        p._connectionEvent=()=>{}; p._isConnected=()=>true;
        p._waitForDrain=async()=>{};
        p._send=data=>frames.push(typeof data==='string'?JSON.parse(data):data);
        return p;
    }
    return { peer, frames, events, files:[
        new File(['first'.repeat(10000)], 'first.bin'),
        new File(['second'.repeat(10000)], 'second.bin'),
        new File(['third'.repeat(10000)], 'third.bin')
    ] };
}
test('pending files remain in page memory during accepted-file reconnection',async()=>{
    const h=await rig(), a=h.peer();
    a.sendFiles(h.files);
    const first=a._outgoing;
    assert.equal(first.meta.name,'first.bin');
    first.phase='sending'; // receiver approved the first file
    assert.equal(a.suspendTransfers('network switch'),true);
    const hold=a.takeHeldTransfers();
    assert.equal(hold.outgoing,first);
    assert.equal(hold.pendingFiles.length,2);
    assert.equal(a._filesQueue.length,0);
    const b=h.peer(false); b.adoptHeldTransfers(hold);
    assert.equal(b._outgoing,null,'reconnected peer cannot restore before new manual confirmation');
    b._verified=true; b.restoreTransfers();
    assert.equal(b._outgoing,first);
    assert.equal(b._filesQueue.length,2);
    assert.equal(b._outgoing.phase,'resuming');
    b._outgoing=null;
    b._dequeueFile();
    assert.equal(b._outgoing.meta.name,'second.bin');
    assert.equal(b._filesQueue.length,1);
    b.cancel(b._outgoing.meta.id,'cleanup',false);
});
test('unaccepted offer is regenerated only after renewed identity confirmation',async()=>{
    const h=await rig(), a=h.peer();
    a.sendFiles(h.files.slice(0,2));
    const oldId=a._outgoing.meta.id;
    assert.equal(a._outgoing.phase,'offered');
    a.suspendTransfers('signal reconnect');
    const hold=a.takeHeldTransfers();
    assert.equal(hold.outgoing,null);
    assert.equal(hold.pendingFiles.length,2);
    const b=h.peer(false);
    b.adoptHeldTransfers(hold);
    assert.equal(h.frames.filter(x=>x.type==='offer').length,1);
    b._verified=true; b.restoreTransfers();
    assert.equal(b._outgoing.meta.name,'first.bin');
    assert.notEqual(b._outgoing.meta.id,oldId,'new request must get fresh id and receiver consent');
    assert.equal(h.frames.filter(x=>x.type==='offer').length,2);
    assert.equal(b._outgoing.phase,'offered');
    b.abortAll('test end');
});
test('queued files do not send on a connected but unverified or invalid ICE path',async()=>{
    const h=await rig(), a=h.peer();
    a._filesQueue.push(h.files[0]);
    a._verified=false;
    a._dequeueFile();assert.equal(a._outgoing,null);
    a._verified=true;a._path={direct:false};
    a._dequeueFile();assert.equal(a._outgoing,null);
    a._path={direct:true};a._remoteHello=false;
    a._dequeueFile();assert.equal(a._outgoing,null);
    a._remoteHello=true;a._dequeueFile();
    assert.equal(a._outgoing.meta.name,'first.bin');
    a.abortAll('cleanup');
});
test('expired suspended queue is released and never reoffered',async()=>{
    const h=await rig(), a=h.peer();
    a.sendFiles(h.files);a.suspendTransfers('network');
    const hold=a.takeHeldTransfers(), b=h.peer();
    hold.deadline=Date.now()-1;
    assert.equal(b.adoptHeldTransfers(hold),false);
    assert.deepEqual(hold.pendingFiles,[]);
    assert.equal(b._outgoing,null);
});
test('a pending fallback save does not auto-resume queued files across channels',async()=>{
    const h=await rig(), a=h.peer();
    a._filesQueue.push(h.files[0]);a._queueWaitId='a'.repeat(32);
    assert.equal(a.suspendTransfers('network'),false);
    assert.equal(a._filesQueue.length,0);
    assert.equal(a._queueWaitId,null);
});
