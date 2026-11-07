'use strict';
// Real transfer state machine with a stateful committed-storage fixture. The
// recovery worker's actual OPFS publication/lock behavior has separate tests.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function harness({ failOn, errorName = 'QuotaExceededError', delayedWrite = false, delayedFinish = false, durable = true, parkFails = true } = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const prefix = Buffer.alloc(16384, 7), tail = Buffer.from('new-tail'), frames = [], events = [], peers = [], timers = new Set();
    const failure = () => Object.assign(Error('storage failure'), { name: errorName });
    const disk = { body: Buffer.from(prefix), committed: { offset: prefix.length, hash: digest(prefix) }, deleted: false,
        active: false, aborts: 0, releases: 0, parks: [], writeEntered: gate(), writeGate: gate(), finishEntered: gate(), finishGate: gate() };
    const sink = { size: prefix.length,
        async write(bytes) {
            disk.writeEntered.resolve();
            if (delayedWrite) await disk.writeGate.promise;
            if (failOn === 'write') throw failure();
            disk.body = Buffer.concat([disk.body, Buffer.from(bytes)]); this.size += bytes.byteLength;
        },
        async checkpoint() { if (failOn === 'checkpoint') throw failure(); },
        async finish() {
            if (failOn === 'finish') throw failure();
            const saved = Buffer.from(disk.body); disk.finishEntered.resolve();
            if (delayedFinish) await disk.finishGate.promise;
            disk.active = false;
            if (durable) disk.committed = { offset: saved.length, hash: digest(saved), phase: 'complete' };
            return { blob: new Blob([saved]), ...(durable ? { locallyStored: true } : {}),
                release() { disk.releases++; disk.deleted = true; disk.body = null; } };
        },
        async park(hash) {
            disk.parks.push(hash);
            if (!disk.active) return false; // actual worker finish already closed/published the file
            disk.active = false;
            if (!parkFails) { disk.committed = { offset: this.size, hash }; return true; }
            // The failed retry deliberately leaves the previously committed
            // metadata unchanged, as a quota/permission failure must do.
            throw failure();
        },
        async abort() { disk.aborts++; disk.deleted = true; disk.body = null; disk.active = false; }
    };
    if (!durable) delete sink.park;
    const context = vm.createContext({
        crypto: crypto.webcrypto, performance, TextEncoder, Uint8Array, Blob, File,
        setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
        Events: { fire(type, detail) { events.push({ type, detail }); } },
        window: { ZeydropHash: sha256, ZeydropRecovery: { supported: true,
            async restore() {
                if (disk.deleted) throw Object.assign(Error('original partial deleted'), { name: 'NotFoundError' });
                assert.equal(disk.active, false, 'a failed park must have released fixture ownership');
                disk.active = true; disk.body = disk.body.subarray(0, disk.committed.offset); sink.size = disk.committed.offset;
                return { sink, snapshot: new Blob([disk.body]), offset: disk.committed.offset, prefixSha256: disk.committed.hash };
            }
        } }
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer=TransferPeer;', context);
    function peer(verified = true) {
        const p = new context.Peer({}, 'same-paired-device');
        Object.assign(p, { _verified: verified, _remoteHello: true, _path: { direct: true }, _isConnected: () => true, _connectionEvent() {} });
        p._send = data => frames.push({ peer: p, message: JSON.parse(data) });
        p.close = reason => p.abortAll(reason); peers.push(p); return p;
    }
    const meta = { name: '已提交前缀.bin', size: prefix.length + tail.length, mime: 'application/octet-stream' };
    async function accept(p, id = crypto.randomUUID()) {
        await p._onMessage(JSON.stringify({ type: 'offer', id, ...meta }));
        await p.acceptIncoming(id, { resumeLocalId: 'b'.repeat(32) });
        assert.ok(p._incoming?.sink, 'explicit fresh acceptance must recover the committed original');
        assert.equal(p._incoming.offset, disk.committed.offset);
        assert.equal(Buffer.from(p._incoming.hash.clone().digest()).toString('hex'), disk.committed.hash);
        await p._onMessage(JSON.stringify({ type: 'resume-confirm', id, offset: disk.committed.offset, sha256: disk.committed.hash }));
        return p._incoming;
    }
    async function cleanup() {
        disk.writeGate.resolve(); disk.finishGate.resolve();
        for (const p of peers) p.abortAll('fixture cleanup', true);
        await Promise.allSettled(peers.map(p => p._messageChain)); await turn();
        for (const timer of timers) clearTimeout(timer);
    }
    return { peer, accept, disk, sink, frames, events, prefix, tail, meta, cleanup };
}

for (const failOn of ['write', 'checkpoint', 'finish']) test('durable ' + failOn + ' quota/permission failure preserves a recoverable committed prefix without ACK or completion', async () => {
    for (const errorName of ['QuotaExceededError', 'NotAllowedError']) {
        const h = await harness({ failOn, errorName }), p = h.peer();
        try {
            const state = await h.accept(p), baseline = { ...h.disk.committed };
            h.frames.length = 0; h.events.length = 0;
            await p._onMessage(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength));
            if (failOn === 'checkpoint') await p._onMessage(JSON.stringify({ type: 'checkpoint', id: state.meta.id, offset: state.offset }));
            if (failOn === 'finish') await p._onMessage(JSON.stringify({ type: 'finish', id: state.meta.id, sha256: digest(Buffer.concat([h.prefix, h.tail])) }));
            await turn(); await turn();
            assert.equal(p._incoming, null); assert.equal(h.disk.deleted, false, 'non-user storage failure must not erase the original');
            assert.equal(h.disk.aborts, 0); assert.equal(h.disk.parks.length, 1);
            assert.deepEqual(h.disk.committed, baseline);
            assert.equal(h.frames.some(frame => ['ack', 'complete'].includes(frame.message.type)), false);
            assert.equal(h.events.some(event => event.type === 'file-received' || (event.type === 'transfer-state' && event.detail.phase === 'complete')), false);
            if (failOn === 'finish') assert.equal(h.disk.parks[0], digest(Buffer.concat([h.prefix, h.tail])), 'final failure uses the actually verified SHA after digest consumed the live hasher');
            const next = h.peer(); await h.accept(next);
            assert.equal(next._incoming.offset, baseline.offset);
            assert.equal(digest(h.disk.body), baseline.hash, 'new restore discards uncommitted tail but preserves the old prefix');
        } finally { await h.cleanup(); }
    }
});

test('hash mismatch remains terminal and aborts the durable sink without trusting a remote final digest', async () => {
    const h = await harness(), p = h.peer();
    try {
        const state = await h.accept(p);
        await p._onMessage(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength));
        p._receive(JSON.stringify({ type: 'finish', id: state.meta.id, sha256: '0'.repeat(64) }));
        await p._messageChain; await turn();
        assert.equal(h.disk.deleted, true); assert.equal(h.disk.aborts, 1); assert.equal(h.disk.parks.length, 0);
        assert.equal(h.events.some(event => event.type === 'file-received'), false);
    } finally { await h.cleanup(); }
});

for (const verifyEarly of [false, true]) test('an old durable write failure reaches the exact adopted owner ' + (verifyEarly ? 'after' : 'before') + ' renewed verification', async () => {
    const h = await harness({ failOn: 'write', delayedWrite: true }), original = h.peer(), replacement = h.peer(false);
    try {
        const state = await h.accept(original); let oldWire = true;
        original._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength), () => oldWire);
        await h.disk.writeEntered.promise; oldWire = false;
        original._verified = false; original._path = { direct: false }; original.suspendTransfers('old wire interrupted');
        replacement.adoptHeldTransfers(original.takeHeldTransfers());
        if (verifyEarly) { replacement._verified = true; replacement.restoreTransfers(); }
        h.disk.writeGate.reject(Object.assign(Error('delayed storage failure'), { name: 'QuotaExceededError' }));
        await original._messageChain; await turn(); await turn();
        if (!verifyEarly) { replacement._verified = true; replacement.restoreTransfers(); }
        assert.equal(replacement._incoming, null); assert.equal(replacement._held, null);
        assert.equal(h.disk.deleted, false); assert.equal(h.disk.aborts, 0); assert.equal(h.disk.parks.length, 1);
        assert.equal(h.disk.committed.hash, digest(h.prefix));
        assert.equal(h.frames.some(frame => frame.peer === replacement && ['ack', 'complete'].includes(frame.message.type)), false);
        assert.equal(state.error === undefined, false);
    } finally { await h.cleanup(); }
});

test('a late durable failure never targets a fresh incoming state just because its ID matches', async () => {
    const h = await harness({ failOn: 'write', delayedWrite: true }), original = h.peer(), replacement = h.peer(false);
    try {
        const state = await h.accept(original); let oldWire = true;
        original._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength), () => oldWire);
        await h.disk.writeEntered.promise; oldWire = false; original.suspendTransfers('old wire interrupted');
        replacement.adoptHeldTransfers(original.takeHeldTransfers()); replacement._verified = true; replacement.restoreTransfers();
        replacement.cancel(state.meta.id, 'explicit user cancellation');
        await replacement._onMessage(JSON.stringify({ type: 'offer', id: state.meta.id, ...h.meta, name: 'fresh.bin' }));
        const fresh = replacement._incoming, aborts = h.disk.aborts, parks = h.disk.parks.length;
        h.disk.writeGate.reject(Object.assign(Error('late old failure'), { name: 'NotAllowedError' }));
        await original._messageChain; await turn();
        assert.equal(replacement._incoming, fresh); assert.equal(fresh.error, undefined); assert.equal(fresh.sink, undefined);
        assert.equal(h.disk.aborts, aborts); assert.equal(h.disk.parks.length, parks);
    } finally { await h.cleanup(); }
});

for (const durable of [true, false]) test('a transient disconnect during unresolved finish ' + (durable ? 'preserves the locally stored result' : 'still aborts and releases an ordinary Blob'), async () => {
    const h = await harness({ delayedFinish: true, durable }), p = h.peer();
    try {
        const state = await h.accept(p);
        await p._onMessage(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength));
        const expected = digest(Buffer.concat([h.prefix, h.tail])); h.frames.length = 0; h.events.length = 0;
        p._receive(JSON.stringify({ type: 'finish', id: state.meta.id, sha256: expected }));
        await h.disk.finishEntered.promise;
        p._verified = false; p._path = { direct: false };
        assert.equal(p.suspendTransfers('network lost during final storage'), false);
        assert.equal(p._held, null, 'a finishing state cannot become a live adopted checkpoint');
        assert.equal(p._incoming, null);
        h.disk.finishGate.resolve(); await p._messageChain; await turn(); await turn();
        assert.equal(h.events.some(event => event.type === 'file-received' || (event.type === 'transfer-state' && event.detail.phase === 'complete')), false);
        assert.equal(h.frames.some(frame => ['complete', 'ack'].includes(frame.message.type)), false);
        if (durable) {
            assert.equal(h.disk.aborts, 0); assert.equal(h.disk.releases, 0); assert.equal(h.disk.deleted, false);
            assert.equal(digest(h.disk.body), expected); assert.deepEqual(h.disk.parks, [expected]);
            assert.equal(h.disk.committed.phase, 'complete'); assert.equal(h.disk.committed.hash, expected);
        } else {
            assert.equal(h.disk.aborts, 1); assert.equal(h.disk.releases, 1); assert.equal(h.disk.deleted, true);
        }
    } finally { await h.cleanup(); }
});

test('explicit user cancellation during a durable finish still aborts and releases its late result', async () => {
    const h = await harness({ delayedFinish: true }), p = h.peer();
    try {
        const state = await h.accept(p);
        await p._onMessage(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength));
        p._receive(JSON.stringify({ type: 'finish', id: state.meta.id, sha256: digest(Buffer.concat([h.prefix, h.tail])) }));
        await h.disk.finishEntered.promise;
        p.cancel(state.meta.id, 'explicit user cancellation');
        h.disk.finishGate.resolve(); await p._messageChain; await turn();
        assert.equal(h.disk.aborts, 1); assert.equal(h.disk.releases, 1); assert.equal(h.disk.deleted, true);
        assert.equal(h.disk.parks.length, 0); assert.equal(p._held, null);
        assert.equal(h.events.some(event => event.type === 'file-received'), false);
    } finally { await h.cleanup(); }
});

for (const durable of [true, false]) test('expired handoff waits for an old write and disposes its shared hold exactly once for ' + (durable ? 'durable storage' : 'ordinary Blob'), async () => {
    const h = await harness({ delayedWrite: true, durable }), original = h.peer(), candidate = h.peer(false);
    try {
        const state = await h.accept(original); let oldWire = true;
        h.frames.length = 0; h.events.length = 0;
        original._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength), () => oldWire);
        await h.disk.writeEntered.promise; oldWire = false;
        original._verified = false; original._path = { direct: false }; original.suspendTransfers('handoff delayed in background');
        const hold = original.takeHeldTransfers(); hold.deadline = Date.now() - 1;
        assert.equal(candidate.adoptHeldTransfers(hold), false);
        assert.equal(candidate._held, null); assert.equal(candidate._incoming, null);
        original._dropHeld('old timer fired late');
        assert.equal(h.disk.aborts, 0, 'cleanup must wait for the already-started write');
        h.disk.writeGate.resolve(); await original._messageChain; await turn(); await turn();
        if (durable) {
            assert.equal(h.disk.deleted, false); assert.equal(h.disk.aborts, 0);
            assert.deepEqual(h.disk.parks, [digest(Buffer.concat([h.prefix, h.tail]))], 'park digest must include the settled old write');
            assert.equal(state.offset, h.prefix.length + h.tail.length);
            assert.equal(h.disk.committed.hash, digest(h.prefix));
        } else { assert.equal(h.disk.aborts, 1); assert.equal(h.disk.deleted, true); }
        original._dropHeld('duplicate old timer');
        assert.equal(candidate.adoptHeldTransfers(hold), false); await turn();
        assert.equal(durable ? h.disk.parks.length : h.disk.aborts, 1);
        assert.equal(h.frames.some(frame => ['resume-at', 'resume-confirm', 'ack', 'complete'].includes(frame.message.type)), false);
    } finally { await h.cleanup(); }
});

test('foreign held cleanup revokes only the exact adopted state and waits for its old write before durable park', async () => {
    const h = await harness({ delayedWrite: true }), original = h.peer(), replacement = h.peer(false);
    try {
        const state = await h.accept(original); let oldWire = true;
        original._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength), () => oldWire);
        await h.disk.writeEntered.promise; oldWire = false;
        original.suspendTransfers('old wire interrupted'); replacement.adoptHeldTransfers(original.takeHeldTransfers());
        replacement._verified = true; replacement.restoreTransfers();
        original._dropHeld('old hold invalidated'); await turn();
        assert.equal(replacement._incoming, null); assert.equal(replacement._held, null);
        assert.equal(h.disk.aborts, 0); assert.equal(h.disk.parks.length, 0);
        h.disk.writeGate.resolve(); await original._messageChain; await turn(); await turn();
        assert.equal(h.disk.deleted, false); assert.equal(h.disk.aborts, 0);
        assert.deepEqual(h.disk.parks, [digest(Buffer.concat([h.prefix, h.tail]))]);
        assert.equal(state.offset, h.prefix.length + h.tail.length);
    } finally { await h.cleanup(); }
});

for (const adopted of [false, true]) test('active keepDurable cancellation accounts for an unresolved write before publishing recoverable offset/hash ' + (adopted ? 'on an adopted owner' : 'on the same peer'), async () => {
    const h = await harness({ delayedWrite: true, parkFails: false }), original = h.peer();
    try {
        const state = await h.accept(original); let validWire = true;
        original._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength), () => validWire);
        await h.disk.writeEntered.promise;
        let owner = original;
        if (adopted) {
            validWire = false; original.suspendTransfers('old wire interrupted');
            owner = h.peer(false); owner.adoptHeldTransfers(original.takeHeldTransfers()); owner._verified = true; owner.restoreTransfers();
        }
        h.frames.length = 0; h.events.length = 0;
        owner.abortAll('terminal network failure', true); await turn();
        assert.equal(h.disk.parks.length, 0, 'park must wait for the exact original write and hashing chain');
        h.disk.writeGate.resolve(); await original._messageChain; await turn(); await turn();
        const expected = digest(Buffer.concat([h.prefix, h.tail]));
        assert.equal(state.offset, h.prefix.length + h.tail.length); assert.equal(h.sink.size, state.offset);
        assert.equal(h.disk.aborts, 0); assert.equal(h.disk.deleted, false); assert.deepEqual(h.disk.parks, [expected]);
        assert.deepEqual(h.disk.committed, { offset: h.prefix.length + h.tail.length, hash: expected });
        assert.equal(h.frames.some(frame => ['ack', 'complete', 'resume-at'].includes(frame.message.type)), false);
        assert.equal(h.events.some(event => event.type === 'file-received'), false);
        const next = h.peer(); await h.accept(next);
        assert.equal(next._incoming.offset, h.disk.body.length);
        assert.equal(Buffer.from(next._incoming.hash.clone().digest()).toString('hex'), expected, 'a fresh explicit recovery independently hashes the published prefix');
    } finally { await h.cleanup(); }
});

test('active durable cleanup hashes only its cancelled state while a fresh same-ID offer stays unchanged', async () => {
    const h = await harness({ delayedWrite: true, parkFails: false }), p = h.peer();
    try {
        const old = await h.accept(p);
        p._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.byteLength)); await h.disk.writeEntered.promise;
        p.abortAll('network failure', true);
        await p._onMessage(JSON.stringify({ type: 'offer', id: old.meta.id, ...h.meta, name: 'new-unaccepted.bin' }));
        const fresh = p._incoming;
        h.disk.writeGate.resolve(); await p._messageChain; await turn(); await turn();
        assert.equal(p._incoming, fresh); assert.equal(fresh.offset, 0); assert.equal(fresh.sink, undefined); assert.equal(fresh.error, undefined);
        assert.equal(old.offset, h.prefix.length + h.tail.length);
        assert.deepEqual(h.disk.parks, [digest(Buffer.concat([h.prefix, h.tail]))]);
        assert.equal(h.disk.aborts, 0);
    } finally { await h.cleanup(); }
});
