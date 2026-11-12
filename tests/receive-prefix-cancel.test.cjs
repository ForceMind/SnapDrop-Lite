'use strict';
// Cancel while a local durable snapshot read is genuinely unresolved. The
// fixture supports both the old Blob stream and bounded slice.arrayBuffer
// paths so fail-before does not depend on an implementation-specific stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const completes = promise => Promise.race([promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 80))]);

async function harness() {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const fixtures = new Map(), peers = [], frames = [], timers = new Map(), events = [];
    const context = vm.createContext({
        crypto: crypto.webcrypto, performance, TextEncoder, Uint8Array, Blob, File,
        setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.set(timer, { fn, ms }); return timer; },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
        Events: { fire(type, detail) { events.push({ type, detail }); } },
        window: { ZeydropHash: sha256, ZeydropRecovery: { supported: true,
            async restore(localId) {
                const item = fixtures.get(localId);
                assert.ok(item, 'restore must remain bound to the selected local fixture');
                item.restoreEntered.resolve();
                if (item.deferRestore) await item.restoreGate.promise;
                return { sink: item.sink, snapshot: item.snapshot, offset: item.prefix.length, prefixSha256: item.prefixSha256 };
            }
        } }
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer=TransferPeer;', context);
    async function make({ prefixSize = 16384, holdRead = true, deferRestore = false, deferPark = false } = {}) {
        const item = { localId: crypto.randomUUID(), prefix: Buffer.alloc(prefixSize, 7), holdRead, deferRestore,
            readGate: gate(), readEntered: gate(), restoreGate: gate(), restoreEntered: gate(), parkGate: gate(),
            reads: 0, slices: [], preparations: [], firstRange: null };
        item.prefixSha256 = crypto.createHash('sha256').update(item.prefix).digest('hex');
        item.sink = { size: prefixSize, parked: [], aborted: 0,
            async park(hash) { this.parked.push(hash); if (deferPark) await item.parkGate.promise; },
            async abort() { this.aborted++; }, async write() {}, async checkpoint() {} };
        const bytes = (start, end) => item.prefix.buffer.slice(item.prefix.byteOffset + start, item.prefix.byteOffset + end);
        const read = async (start, end) => {
            item.reads++;
            if (!item.firstRange) {
                item.firstRange = { start, end }; item.readEntered.resolve();
                if (holdRead) return item.readGate.promise;
            }
            return bytes(start, end);
        };
        item.snapshot = { size: prefixSize, slice(start, end) {
            item.slices.push({ start, end });
            return { arrayBuffer: () => read(start, end),
                async *stream() { yield new Uint8Array(await read(start, end)); } };
        } };
        item.releaseRead = () => {
            const range = item.firstRange || { start: 0, end: Math.min(prefixSize, 256 * 1024) };
            item.readGate.resolve(bytes(range.start, range.end));
        };
        item.meta = { id: crypto.randomUUID(), name: '本机原断点.bin', size: prefixSize + 16, mime: 'application/octet-stream' };
        const peer = new context.Peer({}, 'same-authorized-peer');
        Object.assign(peer, { _verified: true, _remoteHello: true, _path: { direct: true }, _isConnected: () => true, _connectionEvent() {} });
        peer._send = data => frames.push({ peer, message: JSON.parse(data) });
        peer.close = reason => peer.abortAll(reason);
        item.peer = peer; peers.push(peer); fixtures.set(item.localId, item);
        await peer._onMessage(JSON.stringify({ type: 'offer', ...item.meta }));
        item.prepare = () => {
            const promise = peer.acceptIncoming(item.meta.id, { resumeLocalId: item.localId });
            item.preparations.push(promise); return promise;
        };
        item.grants = () => frames.filter(frame => frame.peer === peer && ['accept', 'resume-at', 'complete'].includes(frame.message.type));
        return item;
    }
    async function cleanup() {
        for (const item of fixtures.values()) { item.restoreGate.resolve(); item.parkGate.resolve(); item.releaseRead(); }
        await Promise.allSettled([...fixtures.values()].flatMap(item => item.preparations));
        for (const peer of peers) peer.abortAll('fixture cleanup');
        await turn();
        for (const timer of timers.keys()) clearTimeout(timer);
    }
    return { make, frames, timers, cleanup, context, sha256, events };
}

test('cancelling an unresolved local snapshot read settles preparation and parks the original checkpoint exactly once', async () => {
    const h = await harness();
    try {
        const item = await h.make(), preparation = item.prepare(); await item.readEntered.promise;
        item.peer.cancel(item.meta.id); item.peer.cancel(item.meta.id);
        assert.equal(await completes(preparation), true, 'logical cancellation must not await the unresolved snapshot read');
        assert.deepEqual([...item.sink.parked], [item.prefixSha256]);
        assert.equal(item.sink.aborted, 0); assert.equal(item.sink.size, item.prefix.length);
        assert.equal(item.peer._incoming, null); assert.equal(item.peer._held, null); assert.equal(item.grants().length, 0);
        item.releaseRead(); await turn();
        assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.aborted, 0);
    } finally { await h.cleanup(); }
});

test('late success or failure after cancellation cannot mutate a new incoming state even when the ID is reused', async () => {
    for (const outcome of ['resolve', 'reject']) {
        const h = await harness();
        try {
            const item = await h.make(), preparation = item.prepare(); await item.readEntered.promise;
            item.peer.cancel(item.meta.id);
            assert.equal(await completes(preparation), true);
            await item.peer._onMessage(JSON.stringify({ type: 'offer', ...item.meta, name: '新文件.bin' }));
            const next = item.peer._incoming;
            if (outcome === 'resolve') item.releaseRead(); else item.readGate.reject(Error('old local snapshot failed'));
            await turn(); await turn();
            assert.equal(item.peer._incoming, next); assert.equal(next.meta.name, '新文件.bin');
            assert.equal(next.sink, undefined); assert.equal(next.accepting, undefined); assert.equal(next.offset, 0);
            assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.aborted, 0);
            assert.equal(item.grants().length, 0);
        } finally { await h.cleanup(); }
    }
});

test('transport suspension or prefix deadline settles snapshot preparation without exposing an incompatible held sink', async () => {
    for (const cause of ['suspend', 'timeout']) {
        const h = await harness();
        try {
            const item = await h.make(), preparation = item.prepare(); await item.readEntered.promise;
            if (cause === 'suspend') {
                item.peer._verified = false; item.peer._path = { direct: false };
                item.peer.suspendTransfers('snapshot preparation interrupted');
            } else {
                const deadline = h.timers.get(item.peer._incoming.timer);
                assert.equal(deadline.ms, 5 * 60 * 1000); deadline.fn();
            }
            assert.equal(await completes(preparation), true);
            assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.aborted, 0);
            assert.equal(item.peer._incoming, null); assert.equal(item.peer._held, null); assert.equal(item.grants().length, 0);
        } finally { await h.cleanup(); }
    }
});

test('receiver prefix reads use exact slices no larger than 256 KiB and publish only after all bytes validate', async () => {
    const h = await harness();
    try {
        const item = await h.make({ prefixSize: 2 * 256 * 1024 + 7 }), preparation = item.prepare();
        await item.readEntered.promise;
        assert.equal(item.grants().length, 0); assert.equal(item.peer._incoming.sink, undefined);
        assert.equal(item.peer._incoming.offset, 0);
        item.releaseRead(); await preparation;
        assert.ok(item.slices.length >= 3, 'large prefixes require multiple bounded file reads');
        assert.ok(item.slices.every(part => part.end - part.start <= 256 * 1024));
        assert.equal(item.peer._incoming.sink, item.sink);
        assert.equal(item.peer._incoming.offset, item.prefix.length);
        assert.equal(Buffer.from(item.peer._incoming.hash.clone().digest()).toString('hex'), item.prefixSha256);
        assert.deepEqual([...item.sink.parked], []); assert.equal(item.sink.aborted, 0);
        assert.equal(item.grants().length, 1);
        assert.equal(item.grants()[0].message.type, 'resume-at');
        assert.equal(item.grants()[0].message.offset, item.prefix.length);
    } finally { await h.cleanup(); }
});

test('a late restore result remains bound to its cancelled preparation and is parked without reading or deleting it', async () => {
    const h = await harness();
    try {
        const item = await h.make({ deferRestore: true }), preparation = item.prepare(); await item.restoreEntered.promise;
        item.peer.cancel(item.meta.id);
        await item.peer._onMessage(JSON.stringify({ type: 'offer', ...item.meta, name: '随后收到.bin' }));
        const next = item.peer._incoming;
        item.restoreGate.resolve(); await preparation;
        assert.equal(item.reads, 0); assert.deepEqual([...item.sink.parked], [item.prefixSha256]);
        assert.equal(item.sink.aborted, 0); assert.equal(item.peer._incoming, next); assert.equal(next.sink, undefined);
        assert.equal(item.grants().length, 0);
    } finally { await h.cleanup(); }
});

test('cancellation immediately after a read resolves still precedes validation and publishes no receive grant', async () => {
    const h = await harness();
    try {
        const item = await h.make(), preparation = item.prepare(); await item.readEntered.promise;
        const old = item.peer._incoming, oldHash = old.hash;
        item.releaseRead(); item.peer.cancel(item.meta.id);
        await preparation;
        assert.equal(old.offset, 0); assert.equal(old.hash, oldHash);
        assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.aborted, 0);
        assert.equal(item.grants().length, 0);
    } finally { await h.cleanup(); }
});

test('after validated ownership handoff, normal active cancellation owns the sink and preparation cannot park it', async () => {
    const h = await harness();
    try {
        const item = await h.make({ holdRead: false }); await item.prepare();
        assert.equal(item.peer._incoming.sink, item.sink);
        assert.equal(item.peer._incoming.prefixJob, null);
        assert.equal(item.grants().length, 1);
        item.peer.cancel(item.meta.id); await turn();
        assert.equal(item.sink.aborted, 1, 'the existing active-transfer cancellation policy must retain ownership');
        assert.deepEqual([...item.sink.parked], []);
    } finally { await h.cleanup(); }
});

test('failure to park a cancelled preparation never falls through to deleting the original partial', async () => {
    const h = await harness();
    try {
        const item = await h.make();
        item.sink.park = async hash => { item.sink.parked.push(hash); throw Error('storage park unavailable'); };
        const preparation = item.prepare(); await item.readEntered.promise;
        item.peer.cancel(item.meta.id); assert.equal(await completes(preparation), true);
        assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.aborted, 0);
        assert.equal(item.peer._incoming, null); assert.equal(item.grants().length, 0);
        item.releaseRead(); await turn();
        assert.equal(item.sink.aborted, 0); assert.equal(item.sink.parked.length, 1);
    } finally { await h.cleanup(); }
});

test('an authorized snapshot read failure preserves the committed original even if parking also fails', async () => {
    for (const parkFails of [false, true]) {
        const h = await harness();
        try {
            const item = await h.make(), originalSize = item.sink.size;
            if (parkFails) item.sink.park = async hash => { item.sink.parked.push(hash); throw Error('park failed'); };
            const preparation = item.prepare(); await item.readEntered.promise;
            const state = item.peer._incoming, originalHash = state.hash;
            assert.equal(item.peer._verified, true); assert.equal(item.peer._path.direct, true);
            const failure = Error('temporarily unreadable snapshot'); failure.name = 'NotReadableError';
            item.readGate.reject(failure); await preparation;
            assert.equal(item.sink.aborted, 0, 'a read failure is not proof that the committed prefix is corrupt');
            assert.deepEqual([...item.sink.parked], [item.prefixSha256]);
            assert.equal(item.sink.size, originalSize); assert.equal(state.offset, 0); assert.equal(state.hash, originalHash);
            assert.equal(item.grants().length, 0); assert.equal(item.peer._incoming, null);
        } finally { await h.cleanup(); }
    }
});

test('opaque hashing or malformed digest failures preserve the original instead of claiming a proven prefix mismatch', async () => {
    for (const failOn of ['update', 'clone', 'digest-size']) {
        const h = await harness();
        try {
            const item = await h.make();
            h.context.window.ZeydropHash = { create() {
                const hash = h.sha256.create();
                if (failOn === 'update') hash.update = () => { throw Error('hash engine unavailable'); };
                else if (failOn === 'clone') hash.clone = () => { throw Error('hash clone unavailable'); };
                else hash.clone = () => ({ digest: () => new Uint8Array(0) });
                return hash;
            } };
            const preparation = item.prepare(); await item.readEntered.promise;
            const state = item.peer._incoming, originalHash = state.hash;
            item.releaseRead(); await preparation;
            assert.equal(item.sink.aborted, 0, 'an invalid hash computation cannot justify deleting original bytes');
            assert.deepEqual([...item.sink.parked], [item.prefixSha256]);
            assert.equal(state.offset, 0); assert.equal(state.hash, originalHash); assert.equal(item.grants().length, 0);
        } finally { await h.cleanup(); }
    }
});

test('an authorized read failure parked late cannot cancel or attach to a newer incoming state with the same ID', async () => {
    const h = await harness();
    try {
        const item = await h.make({ deferPark: true }), preparation = item.prepare(); await item.readEntered.promise;
        item.readGate.reject(Object.assign(Error('read interrupted'), { name: 'NotReadableError' })); await turn();
        assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.aborted, 0);
        item.peer.cancel(item.meta.id);
        await item.peer._onMessage(JSON.stringify({ type: 'offer', ...item.meta, name: '新授权文件.bin' }));
        const next = item.peer._incoming;
        item.parkGate.resolve(); await preparation; await turn();
        assert.equal(item.peer._incoming, next); assert.equal(next.meta.name, '新授权文件.bin');
        assert.equal(next.sink, undefined); assert.equal(next.offset, 0);
        assert.equal(item.sink.aborted, 0); assert.equal(item.sink.parked.length, 1); assert.equal(item.grants().length, 0);
    } finally { await h.cleanup(); }
});

test('held expiry and keepDurable abort preserve the prior checkpoint when park rejects quota', async () => {
    for (const cause of ['held-expiry', 'keep-durable-abort']) {
        const h = await harness();
        try {
            const item = await h.make({ holdRead: false }); await item.prepare();
            const originalSize = item.sink.size;
            item.sink.park = async hash => {
                item.sink.parked.push(hash);
                throw Object.assign(Error('PRIVATE_QUOTA_SENTINEL'), { name: 'QuotaExceededError' });
            };
            if (cause === 'held-expiry') {
                item.peer._verified = false; item.peer._path = { direct: false };
                item.peer.suspendTransfers('disconnected');
                const deadline = h.timers.get(item.peer._held.timer); deadline.fn();
            } else item.peer.abortAll('closed connection', true);
            await turn(); await turn();
            assert.equal(item.sink.aborted, 0, 'failed checkpoint publication must not delete the previous committed bytes');
            assert.deepEqual([...item.sink.parked], [item.prefixSha256]); assert.equal(item.sink.size, originalSize);
            assert.equal(item.peer._incoming, null); assert.equal(item.peer._held, null);
            assert.ok(h.events.some(event => event.type === 'notify-user' && String(event.detail).includes('本机断点保存失败')));
            assert.equal(JSON.stringify(h.events).includes('PRIVATE_QUOTA_SENTINEL'), false, 'storage rejection emits a fixed local notice');
        } finally { await h.cleanup(); }
    }
});

test('held ordinary memory or native sinks still abort instead of pretending to keep a durable checkpoint', async () => {
    const h = await harness();
    try {
        const item = await h.make(); let aborted = 0;
        const state = item.peer._incoming;
        state.sink = { abort: async () => { aborted++; } };
        item.peer.suspendTransfers('ordinary sink disconnected');
        item.peer._dropHeld('ordinary sink expired'); await turn();
        assert.equal(aborted, 1);
    } finally { await h.cleanup(); }
});

test('a pending park RPC is requested only once without aborting the original snapshot or claiming physical cleanup completed', async () => {
    const h = await harness();
    try {
        const item = await h.make({ deferPark: true }), preparation = item.prepare(); await item.readEntered.promise;
        item.peer.cancel(item.meta.id); item.peer.cancel(item.meta.id); await turn();
        assert.deepEqual([...item.sink.parked], [item.prefixSha256]);
        assert.equal(item.sink.aborted, 0); assert.equal(item.grants().length, 0);
        // We deliberately do not require this RPC's physical completion before
        // releasing its own gate. The old snapshot read remains unresolved.
        item.parkGate.resolve(); assert.equal(await completes(preparation), true);
    } finally { await h.cleanup(); }
});

test('sender primitive and cancelled receiver prefixes share the four unresolved-read cap without deleting an unread original', async () => {
    const h = await harness();
    try {
        const direct = [];
        for (let i = 0; i < 2; i++) {
            const item = await h.make(), job = { cancelled: false, cancelRead: null };
            const read = item.peer._readPrefixChunk(job, item.snapshot, 0, item.prefix.length);
            await item.readEntered.promise; job.cancelled = true; job.cancelRead(); await read;
            direct.push(item);
        }
        for (let i = 0; i < 2; i++) {
            const item = await h.make(), preparation = item.prepare(); await item.readEntered.promise;
            item.peer.cancel(item.meta.id); assert.equal(await completes(preparation), true);
        }
        const capped = await h.make(), preparation = capped.prepare();
        assert.equal(await completes(preparation), true, 'resource cap must reject preparation without another underlying read');
        assert.equal(capped.reads, 0); assert.equal(capped.peer._incoming, null); assert.equal(capped.grants().length, 0);
        assert.deepEqual([...capped.sink.parked], [capped.prefixSha256]); assert.equal(capped.sink.aborted, 0);
        direct[0].releaseRead(); await turn();
        const available = await h.make(), resumed = available.prepare(); await available.readEntered.promise;
        available.peer.cancel(available.meta.id); assert.equal(await completes(resumed), true);
    } finally { await h.cleanup(); }
});
