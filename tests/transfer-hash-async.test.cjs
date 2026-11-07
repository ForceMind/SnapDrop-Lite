'use strict';
// Exercise the real transfer state machine and opaque async hash bridge. Only
// the native Worker/storage boundaries are fixtures; no clone/digest API is
// exposed to TransferPeer, and SHA answers come from independent Node crypto.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const bridge = fs.readFileSync('client/scripts/stream-hash.js', 'utf8');
const transfer = fs.readFileSync('client/scripts/transfer.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function harness() {
    const workers = [], gates = [], pauses = [], timers = new Set(), frames = [], events = [], peers = [];
    class Worker {
        constructor() { this.hash = crypto.createHash('sha256'); this.bytes = 0; this.terminated = false; workers.push(this); }
        postMessage(message) {
            const deliver = () => {
                let response;
                if (message.type === 'init') response = { type: 'ready', session: message.session, request: 0, bytes: 0 };
                if (message.type === 'update') {
                    this.hash.update(new Uint8Array(message.chunk)); this.bytes += message.chunk.byteLength;
                    response = { type: 'updated', session: message.session, request: message.request, bytes: this.bytes };
                }
                if (message.type === 'digest') response = { type: 'digest', session: message.session, request: message.request,
                    bytes: this.bytes, sha256: (message.final ? this.hash : this.hash.copy()).digest('hex'), final: message.final };
                this.onmessage({ data: response });
            };
            const pauseIndex = pauses.findIndex(pause => pause.type === message.type
                && (pause.final === undefined || pause.final === message.final));
            if (pauseIndex !== -1) {
                const pause = pauses.splice(pauseIndex, 1)[0];
                Object.assign(pause, { worker: this, message, deliver }); pause.entered.resolve();
            } else queueMicrotask(() => { if (!this.terminated) deliver(); });
        }
        terminate() { this.terminated = true; }
    }
    function pause(type, final) {
        const item = { type, final, entered: deferred(), settled: false,
            resolve() { if (!this.settled) { this.settled = true; this.deliver(); } },
            fail() { if (!this.settled) { this.settled = true; this.worker.onerror({ preventDefault() {} }); } }
        };
        pauses.push(item); gates.push(item); return item;
    }
    const prefix = Buffer.alloc(16384, 7), tail = Buffer.from('async-tail');
    const disk = { body: Buffer.alloc(0), committed: { offset: 0, hash: digest('') }, active: false,
        deleted: false, aborts: 0, finishes: 0, checkpoints: [], parks: [], safeParks: [] };
    const sink = { size: 0,
        async write(bytes) { disk.body = Buffer.concat([disk.body, Buffer.from(bytes)]); this.size += bytes.byteLength; },
        async checkpoint(sha256) {
            assert.equal(sha256, digest(disk.body), 'published digest must match all bytes physically written');
            disk.checkpoints.push(sha256); disk.committed = { offset: this.size, hash: sha256 };
        },
        async park(sha256) {
            assert.equal(sha256, digest(disk.body), 'parking cannot publish an old hash at a newer disk offset');
            disk.parks.push(sha256); disk.committed = { offset: this.size, hash: sha256 }; disk.active = false;
        },
        async parkCommitted() { disk.safeParks.push(disk.committed.offset); disk.active = false; return disk.committed.offset; },
        async finish(sha256) {
            disk.finishes++; assert.equal(sha256, digest(disk.body)); disk.active = false;
            disk.committed = { offset: this.size, hash: sha256, phase: 'complete' };
            return { blob: new Blob([disk.body]), locallyStored: true };
        },
        async abort() { disk.aborts++; disk.deleted = true; disk.active = false; }
    };
    const context = vm.createContext({ Worker, crypto: crypto.webcrypto, performance, queueMicrotask, URL,
        ArrayBuffer, Uint8Array, DataView, TextEncoder, Blob, File,
        document: { currentScript: { src: 'https://same.test/scripts/stream-hash.js?v=async-fixture' } },
        setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
        Events: { fire(type, detail) { events.push({ type, detail }); } },
        window: { ZeydropRecovery: { supported: true,
            async open() { disk.active = true; return sink; },
            async restore() {
                disk.body = disk.body.subarray(0, disk.committed.offset); sink.size = disk.committed.offset; disk.active = true;
                return { sink, snapshot: new Blob([disk.body]), offset: disk.committed.offset, prefixSha256: disk.committed.hash };
            }
        } }
    });
    vm.runInContext(bridge + '\n' + transfer + '\nthis.Peer=TransferPeer;', context);
    const manager = context.window.ZeydropStreamHash;
    function peer(verified = true) {
        const p = new context.Peer({}, 'paired-device');
        Object.assign(p, { _verified: verified, _remoteHello: true, _path: { direct: true }, _pathEpoch: 0,
            _isConnected: () => true, _waitForDrain: async () => {}, _connectionEvent() {} });
        p._send = data => frames.push({ peer: p, ...(typeof data === 'string' ? { message: JSON.parse(data) } : { bytes: Buffer.from(data) }) });
        p.close = reason => p.abortAll(reason); peers.push(p); return p;
    }
    async function receive(p, message) {
        p._receive(typeof message === 'string' || message instanceof ArrayBuffer ? message : JSON.stringify(message));
        await p._messageChain;
    }
    async function accept(p) {
        const meta = { id: crypto.randomUUID(), name: '异步校验.bin', size: prefix.length + tail.length, mime: 'application/octet-stream' };
        await receive(p, { type: 'offer', ...meta });
        await p.acceptIncoming(meta.id, { durable: true });
        const state = p._incoming;
        assert.equal(typeof state.hash.digestHex, 'function'); assert.equal(state.hash.clone, undefined);
        await receive(p, buffer(prefix)); await receive(p, { type: 'checkpoint', id: meta.id, offset: prefix.length });
        assert.equal(disk.committed.offset, prefix.length);
        frames.length = 0; events.length = 0; disk.checkpoints.length = 0;
        return state;
    }
    async function flush() { await tick(); await tick(); }
    async function cleanup() {
        for (const item of gates) if (!item.settled && item.worker) item.fail();
        for (const p of peers) p.abortAll('fixture cleanup');
        manager.disposeAll(); await Promise.allSettled(peers.map(p => p._messageChain)); await flush();
        for (const timer of timers) clearTimeout(timer);
    }
    function noCompletion() {
        assert.equal(frames.some(frame => ['ack', 'complete'].includes(frame.message?.type)), false);
        assert.equal(events.some(event => event.type === 'file-received'
            || (event.type === 'transfer-state' && event.detail.phase === 'complete')), false);
    }
    return { pause, prefix, tail, disk, sink, peer, receive, accept, flush, cleanup, frames, events, manager, noCompletion };
}

test('a disk append followed by async hash failure preserves the old committed prefix without ACK, checkpoint or abort', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        const state = await h.accept(p), baseline = { ...h.disk.committed }, update = h.pause('update');
        p._receive(buffer(h.tail)); await update.entered.promise;
        assert.equal(h.sink.size, state.meta.size); assert.equal(state.offset, h.prefix.length);
        assert.equal(h.disk.safeParks.length, 0); update.fail(); await p._messageChain; await h.flush();
        assert.equal(p._incoming, null); assert.equal(h.disk.aborts, 0); assert.equal(h.disk.deleted, false);
        assert.equal(h.disk.active, false); assert.deepEqual(h.disk.committed, baseline);
        assert.deepEqual(h.disk.checkpoints, []); assert.deepEqual(h.disk.parks, []);
        assert.deepEqual(h.disk.safeParks, [baseline.offset]); assert.equal(h.manager._handles.size, 0);
        h.noCompletion();
    } finally { await h.cleanup(); }
});

test('an async checkpoint snapshot failure cannot publish a new offset or acknowledge uncommitted bytes', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        const state = await h.accept(p), baseline = { ...h.disk.committed };
        await h.receive(p, buffer(h.tail)); const snapshot = h.pause('digest', false);
        p._receive(JSON.stringify({ type: 'checkpoint', id: state.meta.id, offset: state.offset })); await snapshot.entered.promise;
        assert.deepEqual(h.disk.checkpoints, []); h.noCompletion();
        snapshot.fail(); await p._messageChain; await h.flush();
        assert.equal(p._incoming, null); assert.deepEqual(h.disk.committed, baseline);
        assert.deepEqual(h.disk.safeParks, [baseline.offset]); assert.deepEqual(h.disk.parks, []);
        assert.deepEqual(h.disk.checkpoints, []); assert.equal(h.disk.aborts, 0); h.noCompletion();
    } finally { await h.cleanup(); }
});

for (const adopted of [false, true]) test('retired-wire async update finishes exact-state accounting before durable park ' + (adopted ? 'on the adopted peer' : 'on the original peer'), { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        const state = await h.accept(p), update = h.pause('update'); let currentWire = true;
        p._receive(buffer(h.tail), () => currentWire); await update.entered.promise;
        currentWire = false; p._verified = false; p._path = { direct: false };
        assert.equal(p.suspendTransfers('old wire disconnected'), true);
        let owner = p;
        if (adopted) {
            owner = h.peer(false); assert.equal(owner.adoptHeldTransfers(p.takeHeldTransfers()), true);
            owner._verified = true; owner.restoreTransfers();
        }
        owner.abortAll('network recovery expired', true); await h.flush();
        assert.deepEqual(h.disk.parks, []); assert.deepEqual(h.disk.safeParks, []);
        update.resolve(); await p._messageChain; await h.flush();
        const expected = digest(Buffer.concat([h.prefix, h.tail]));
        assert.equal(state.offset, state.meta.size); assert.equal(h.sink.size, state.offset);
        assert.deepEqual(h.disk.parks, [expected]); assert.deepEqual(h.disk.safeParks, []);
        assert.deepEqual(h.disk.committed, { offset: state.meta.size, hash: expected });
        assert.equal(h.disk.aborts, 0); assert.equal(h.disk.active, false); h.noCompletion();
    } finally { await h.cleanup(); }
});

test('adoption waits for an old wire hash update before advertising its actual prefix and never ACKs the dead channel', { timeout: 5000 }, async () => {
    const h = harness(), original = h.peer(), replacement = h.peer(false);
    try {
        const state = await h.accept(original), update = h.pause('update'); let currentWire = true;
        original._receive(buffer(h.tail), () => currentWire); await update.entered.promise;
        original._receive(JSON.stringify({ type: 'checkpoint', id: state.meta.id, offset: state.meta.size }), () => currentWire);
        currentWire = false; original._verified = false; original._path = { direct: false };
        original.suspendTransfers('old wire disconnected'); replacement.adoptHeldTransfers(original.takeHeldTransfers());
        replacement._verified = true; replacement.restoreTransfers();
        const resumed = replacement._onMessage(JSON.stringify({ type: 'resume-offer', ...state.meta }));
        await h.flush(); assert.equal(h.frames.some(frame => frame.message?.type === 'resume-at'), false);
        update.resolve(); await original._messageChain; await resumed; await h.flush();
        const reply = h.frames.find(frame => frame.message?.type === 'resume-at');
        assert.equal(reply.peer, replacement); assert.equal(reply.message.offset, state.meta.size);
        assert.equal(reply.message.sha256, digest(Buffer.concat([h.prefix, h.tail])));
        assert.equal(replacement._incoming, state); assert.equal(state.offset, state.meta.size);
        h.noCompletion();
    } finally { await h.cleanup(); }
});

test('cancellation during a consuming final digest prevents storage finish and completion while retaining the durable checkpoint', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        const state = await h.accept(p); await h.receive(p, buffer(h.tail));
        const final = h.pause('digest', true), expected = digest(Buffer.concat([h.prefix, h.tail]));
        p._receive(JSON.stringify({ type: 'finish', id: state.meta.id, sha256: expected })); await final.entered.promise;
        p.abortAll('network failed during local verification', true); await h.flush();
        assert.equal(h.disk.finishes, 0); assert.equal(h.disk.parks.length, 0);
        final.resolve(); await p._messageChain; await h.flush();
        assert.equal(h.disk.finishes, 0); assert.equal(h.disk.aborts, 0); assert.equal(h.disk.deleted, false);
        assert.equal(h.disk.active, false); assert.deepEqual(h.disk.parks, [expected]);
        assert.deepEqual(h.disk.committed, { offset: state.meta.size, hash: expected });
        assert.equal(h.manager._handles.size, 0); h.noCompletion();
    } finally { await h.cleanup(); }
});

test('sender cancellation during an async update releases the hash lease and a late callback cannot send file bytes', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        p.sendFiles([new File([h.tail], 'outgoing.bin')]); const state = p._outgoing, update = h.pause('update');
        await h.receive(p, { type: 'accept', id: state.meta.id }); await update.entered.promise;
        p.cancel(state.meta.id, 'explicit sender cancellation'); update.resolve(); await h.flush();
        assert.equal(p._outgoing, null); assert.equal(state.offset, 0); assert.equal(state.hash.closed, true);
        assert.equal(h.manager._handles.size, 0); assert.equal(update.worker.terminated, true);
        assert.equal(h.frames.some(frame => frame.bytes || ['checkpoint', 'finish'].includes(frame.message?.type)), false);
        h.noCompletion();
    } finally { await h.cleanup(); }
});

test('a late old Worker failure and callback preserve a fresh same-ID incoming state and release only the old disk ownership', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        const old = await h.accept(p), baseline = { ...h.disk.committed }, update = h.pause('update');
        p._receive(buffer(h.tail)); await update.entered.promise;
        p.abortAll('old transport abandoned', true);
        await p._onMessage(JSON.stringify({ type: 'offer', ...old.meta, name: 'fresh-unaccepted.bin' }));
        const fresh = p._incoming; assert.notEqual(fresh, old);
        update.fail(); await p._messageChain; await h.flush();
        // Native callbacks can race terminate(). The bridge must ignore them.
        update.deliver(); update.worker.onerror({ preventDefault() {} }); await h.flush();
        assert.equal(p._incoming, fresh); assert.equal(fresh.offset, 0); assert.equal(fresh.error, undefined);
        assert.equal(fresh.sink, undefined); assert.equal(fresh.hash.closed, false); assert.equal(fresh.hash.bytes, 0);
        assert.equal(h.manager._handles.size, 1); assert.equal(h.disk.aborts, 0); assert.deepEqual(h.disk.committed, baseline);
        assert.deepEqual(h.disk.safeParks, [baseline.offset]); assert.deepEqual(h.disk.parks, []); h.noCompletion();
    } finally { await h.cleanup(); }
});

for (const failedOperation of ['update', 'digest']) test('a local outgoing prefix ' + failedOperation + ' failure keeps the independent incoming durable transfer usable', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        const incoming = await h.accept(p), baseline = { ...h.disk.committed };
        p.sendFiles([new File([h.tail], 'outgoing-to-resume.bin')]); const outgoing = p._outgoing;
        const failure = h.pause(failedOperation, failedOperation === 'digest' ? false : undefined);
        await h.receive(p, { type: 'resume-at', id: outgoing.meta.id, offset: h.tail.length, sha256: digest(h.tail) });
        await failure.entered.promise; failure.fail(); await h.flush();
        assert.equal(p._outgoing, null); assert.equal(p._retryFiles.has(outgoing.meta.id), true);
        assert.equal(p._queueBlocked, true); assert.equal(outgoing.hash.closed, true);
        assert.equal(p._incoming, incoming); assert.equal(incoming.hash.closed, false);
        assert.equal(p._verified, true); assert.equal(p._path.direct, true);
        assert.equal(h.disk.active, true); assert.equal(h.disk.deleted, false); assert.equal(h.disk.aborts, 0);
        assert.deepEqual(h.disk.committed, baseline); assert.deepEqual(h.disk.parks, []); assert.deepEqual(h.disk.safeParks, []);
        assert.equal(h.manager._handles.size, 1);
        assert.equal(h.frames.some(frame => frame.bytes || ['resume-confirm', 'finish'].includes(frame.message?.type)), false);
        h.noCompletion();
        // The opposite direction must remain operational, not merely retain an
        // inert state object after all local hash leases were disposed.
        await h.receive(p, buffer(h.tail));
        await h.receive(p, { type: 'checkpoint', id: incoming.meta.id, offset: incoming.meta.size });
        assert.equal(p._incoming, incoming); assert.equal(incoming.offset, incoming.meta.size);
        assert.deepEqual(h.disk.committed, { offset: incoming.meta.size, hash: digest(Buffer.concat([h.prefix, h.tail])) });
        assert.equal(h.frames.some(frame => frame.message?.type === 'ack' && frame.message.id === incoming.meta.id), true);
    } finally { await h.cleanup(); }
});

test('simultaneous incoming and outgoing prefix restoration fits four hash leases and releases temporary owners at handoff', { timeout: 5000 }, async () => {
    const h = harness(), p = h.peer();
    try {
        h.disk.body = Buffer.from(h.prefix); h.sink.size = h.prefix.length;
        h.disk.committed = { offset: h.prefix.length, hash: digest(h.prefix) };
        p.sendFiles([new File([h.prefix, h.tail], 'outgoing-prefix.bin')]);
        const outgoing = p._outgoing; outgoing.paused = true;
        const meta = { id: crypto.randomUUID(), name: 'incoming-prefix.bin', size: h.prefix.length + h.tail.length, mime: 'application/octet-stream' };
        await h.receive(p, { type: 'offer', ...meta }); const incoming = p._incoming;
        assert.equal(h.manager._handles.size, 2, 'each offered direction retains its own original lease');
        const receiverPrefix = h.pause('update');
        const accepting = p.acceptIncoming(meta.id, { resumeLocalId: 'a'.repeat(32) }); await receiverPrefix.entered.promise;
        assert.equal(h.manager._handles.size, 3);
        const senderPrefix = h.pause('update');
        await h.receive(p, { type: 'resume-at', id: outgoing.meta.id, offset: h.prefix.length, sha256: digest(h.prefix) });
        await senderPrefix.entered.promise;
        assert.equal(h.manager._handles.size, 4, 'two retained leases plus two concurrent prefix preparations fit the hard cap');
        assert.throws(() => h.manager.create(), { name: 'HashBusyError' });
        assert.equal(incoming.hash.bytes, 0); assert.equal(outgoing.hash.bytes, 0);
        receiverPrefix.resolve(); senderPrefix.resolve(); await accepting; await h.flush();
        assert.equal(p._incoming, incoming); assert.equal(incoming.offset, h.prefix.length); assert.equal(incoming.awaitingResume, true);
        assert.equal(p._outgoing, outgoing); assert.equal(outgoing.offset, h.prefix.length); assert.equal(outgoing.phase, 'sending');
        assert.equal(incoming.hash.bytes, h.prefix.length); assert.equal(outgoing.hash.bytes, h.prefix.length);
        assert.equal(incoming.hash.closed, false); assert.equal(outgoing.hash.closed, false);
        assert.equal(incoming.prefixJob, null); assert.equal(outgoing.prefixJob, null); assert.equal(h.manager._handles.size, 2);
        assert.equal(h.frames.some(frame => frame.message?.type === 'resume-at' && frame.message.id === incoming.meta.id), true);
        assert.equal(h.frames.some(frame => frame.message?.type === 'resume-confirm' && frame.message.id === outgoing.meta.id), true);
        assert.equal(h.frames.some(frame => frame.bytes), false, 'paused outgoing direction cannot emit data during the restoration check');
        p.abortAll('fixture ends both directions', true); await h.flush();
        assert.equal(h.manager._handles.size, 0); assert.equal(h.disk.active, false); assert.equal(h.disk.aborts, 0);
        assert.deepEqual(h.disk.parks, [digest(h.prefix)]); assert.deepEqual(h.disk.safeParks, []);
    } finally { await h.cleanup(); }
});

test('a missing bridge in a Worker-capable browser cannot silently hash on the main thread or lose the send queue', async () => {
    let mainCalls = 0;
    const context = vm.createContext({ Worker: class Worker {}, window: { ZeydropHash: { create() { mainCalls++; } } },
        crypto: crypto.webcrypto, performance, setTimeout, clearTimeout, Events: { fire() {} } });
    vm.runInContext(transfer + '\nthis.Peer=TransferPeer;', context);
    const peer = new context.Peer({}, 'paired');
    Object.assign(peer, { _verified: true, _remoteHello: true, _path: { direct: true }, _isConnected: () => true });
    const frames = []; peer._send = data => frames.push(JSON.parse(data));
    peer.sendFiles([new File(['abc'], 'keep-original.bin')]);
    assert.equal(peer._outgoing, null); assert.equal(peer._filesQueue.length, 1); assert.equal(peer._queueBlocked, true);
    await peer._onMessage(JSON.stringify({ type: 'offer', id: crypto.randomUUID(), name: 'x', size: 3, mime: 'text/plain' }));
    assert.equal(peer._incoming, null); assert.equal(mainCalls, 0);
    assert.equal(frames.length, 1); assert.equal(frames[0].type, 'reject');
});
