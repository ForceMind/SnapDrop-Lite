'use strict';
// Disconnect while the receiver hashes a manually selected durable prefix.
// The OPFS writer already starts at N even though transfer offset/hash are not
// ready yet. It must never be restored as offset zero or erase that prefix.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function rig({ deferHash = true, deferRestore = false, corrupt = false } = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const prefix = new Uint8Array(16384).fill(7), hashEntered = deferred(), releaseHash = deferred();
    const restoreEntered = deferred(), releaseRestore = deferred();
    const expectedHash = crypto.createHash('sha256').update(prefix).digest('hex');
    const frames = [], id = 'a'.repeat(32); let hashReads = 0, restoreCalls = 0;
    const meta = { id, name: '已保存前缀.bin', size: 32768, mime: 'application/octet-stream' };
    const sink = { size: prefix.length, aborted: 0, parkedHash: null,
        async abort() { this.aborted++; }, async park(hash) { this.parkedHash = hash; } };
    const snapshot = { slice() { return { async *stream() {
        hashReads++; hashEntered.resolve(); if (deferHash) await releaseHash.promise;
        yield corrupt ? new Uint8Array(prefix.length).fill(8) : prefix;
    } }; } };
    const context = vm.createContext({
        crypto: crypto.webcrypto, performance, TextEncoder, Uint8Array, Blob, File,
        setTimeout: (fn,ms) => {const timer=setTimeout(fn,ms);timer.unref();return timer;}, clearTimeout,
        Events: { fire() {} },
        window: { ZeydropHash: sha256, ZeydropRecovery: { supported:true,
            async restore() {
                restoreCalls++; restoreEntered.resolve(); if (deferRestore) await releaseRestore.promise;
                return { sink, snapshot, offset: prefix.length, prefixSha256: expectedHash };
            } } }
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.Peer = TransferPeer;',context);
    const peer = new context.Peer({},'same-authorized-peer');
    peer._verified=true;peer._path={direct:true};peer._remoteHello=true;peer._isConnected=()=>true;
    peer._connectionEvent=()=>{};peer._send=data=>frames.push(JSON.parse(data));
    await peer._onMessage(JSON.stringify({type:'offer',...meta}));
    return { peer, sink, frames, meta, id, expectedHash, hashEntered, releaseHash, restoreEntered, releaseRestore,
        hashReads:()=>hashReads, restoreCalls:()=>restoreCalls,
        prepare:()=>peer.acceptIncoming(id,{resumeLocalId:'b'.repeat(32)}) };
}
test('disconnect during durable prefix preparation never resumes at an incompatible writer offset', async () => {
    const h = await rig(), preparation = h.prepare(); await h.hashEntered.promise;
    h.peer.suspendTransfers('network disappeared during local prefix read');
    h.releaseHash.resolve(); await preparation;
    h.peer.restoreTransfers();
    await h.peer._onMessage(JSON.stringify({type:'resume-offer',...h.meta}));
    const resume = h.frames.find(frame=>frame.type==='resume-at');
    try {
        assert.equal(h.sink.aborted,0,'a transient drop must not delete the previously committed local prefix');
        if (resume) {
            assert.equal(resume.offset,h.sink.size,'advertised prefix must match the existing writer offset');
            assert.equal(resume.sha256,h.expectedHash);
        } else {
            assert.equal(h.sink.parkedHash,h.expectedHash,'a preparation that cannot resume must preserve the original committed checkpoint');
        }
    } finally { h.peer.abortAll('fixture cleanup'); }
});
test('cancelling an in-progress prefix read parks the original checkpoint without authorizing bytes', async () => {
    const h = await rig(), preparation = h.prepare(); await h.hashEntered.promise;
    h.peer.cancel(h.id); h.releaseHash.resolve(); await preparation;
    assert.equal(h.sink.aborted,0); assert.equal(h.sink.parkedHash,h.expectedHash);
    assert.equal(h.peer._incoming,null); assert.equal(h.peer._held,null);
    assert.ok(!h.frames.some(frame=>['accept','resume-at'].includes(frame.type)));
});
test('cancelling before the OPFS restore returns releases its late result without reading it', async () => {
    const h = await rig({deferRestore:true}), preparation = h.prepare(); await h.restoreEntered.promise;
    h.peer.cancel(h.id); h.releaseRestore.resolve(); await preparation;
    assert.equal(h.hashReads(),0); assert.equal(h.sink.aborted,0);
    assert.equal(h.sink.parkedHash,h.expectedHash);
    assert.ok(!h.frames.some(frame=>['accept','resume-at'].includes(frame.type)));
});
test('a corrupt local prefix aborts the preparing sink and never sends a resume grant', async () => {
    const h = await rig({deferHash:false,corrupt:true}); await h.prepare();
    assert.equal(h.sink.aborted,1); assert.equal(h.sink.parkedHash,null);
    assert.equal(h.peer._incoming,null);
    assert.ok(!h.frames.some(frame=>['accept','resume-at','complete'].includes(frame.type)));
});
test('a stale receive confirmation cannot open storage after identity authorization is revoked', async () => {
    const h = await rig(); h.peer._verified=false; await h.prepare();
    assert.equal(h.restoreCalls(),0); assert.equal(h.peer._incoming,null);
    assert.ok(!h.frames.some(frame=>['accept','resume-at'].includes(frame.type)));
});
test('a late old preparation cannot alter a newer offer even if its transfer ID is replayed', async () => {
    const h = await rig({deferRestore:true}), preparation = h.prepare(); await h.restoreEntered.promise;
    h.peer.cancel(h.id);
    await h.peer._onMessage(JSON.stringify({type:'offer',...h.meta,name:'new-offer.bin'}));
    const next = h.peer._incoming;
    h.releaseRestore.resolve(); await preparation;
    try {
        assert.equal(h.peer._incoming,next); assert.equal(next.meta.name,'new-offer.bin');
        assert.equal(next.accepting,undefined); assert.equal(next.sink,undefined);
        assert.equal(h.sink.parkedHash,h.expectedHash); assert.equal(h.sink.aborted,0);
        assert.ok(!h.frames.some(frame=>['accept','resume-at'].includes(frame.type)));
    } finally { h.peer.abortAll('fixture cleanup'); }
});
