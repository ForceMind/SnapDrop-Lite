'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createHash } = require('node:crypto');
const source = fs.readFileSync('client/scripts/stream-hash.js', 'utf8');
const workerSource = fs.readFileSync('client/scripts/stream-hash-worker.js', 'utf8').replace(/^import[^\n]+\n/, '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function rig(options = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js'), events = [];
    const context = vm.createContext({ window: { ZeydropHash: sha256 }, ArrayBuffer, Uint8Array, DataView, URL,
        setTimeout, clearTimeout, queueMicrotask, addEventListener: (name, fn) => events.push({ name, fn }),
        document: { currentScript: { src: 'https://same.test/app/scripts/stream-hash.js?v=revision#ignored' } } });
    vm.runInContext(source + '\nthis.Manager=ZeydropStreamHasher;', context);
    return { manager: new context.Manager({ Worker: undefined, hashFactory: () => sha256.create(), ...options }), context, events, sha256 };
}
function fakeWorkers() {
    const workers = [];
    class Worker {
        constructor(url) { this.url = url; this.messages = []; this.terminated = false; workers.push(this); }
        postMessage(data, transfer) { this.messages.push({ data, transfer }); }
        terminate() { this.terminated = true; }
        send(data) { this.onmessage({ data }); }
    }
    return { Worker, workers };
}
function ready(worker) {
    const { session } = worker.messages[0].data;
    worker.send({ type: 'ready', session, request: 0, bytes: 0 });
}
function acknowledge(worker) {
    const { data } = worker.messages.at(-1);
    worker.send({ type: 'updated', session: data.session, request: data.request, bytes: data.offset + data.chunk.byteLength });
}
function snapshot(worker, bytes, final = false) {
    const { data } = worker.messages.at(-1);
    worker.send({ type: 'digest', session: data.session, request: data.request, bytes: data.offset, sha256: digest(bytes), final });
}
test('incremental fallback snapshots preserve continuation; final consumes state and releases its lease', async () => {
    const h = await rig(), state = h.manager.create();
    try {
        assert.equal(state.backend, 'main'); assert.equal(state.bytes, 0);
        assert.equal(await state.digestHex(), digest(''));
        const first = Buffer.alloc(256 * 1024, 0x37), second = Buffer.from('中文\0tail');
        await state.update(first); assert.equal(state.bytes, first.length);
        assert.equal(await state.digestHex({ final: false }), digest(first));
        await state.update(new DataView(second.buffer, second.byteOffset, second.byteLength));
        assert.equal(await state.digestHex(), digest(Buffer.concat([first, second])));
        assert.equal(await state.digestHex({ final: true }), digest(Buffer.concat([first, second])));
        assert.equal(state.closed, true); assert.equal(h.manager._handles.size, 0);
        await assert.rejects(state.update(new Uint8Array(0)), { name: 'HashClosedError' });
        await assert.rejects(state.digestHex(), { name: 'HashClosedError' });
        state.dispose(); assert.equal(h.manager._handles.size, 0);
    } finally { h.manager.disposeAll(); }
});
test('input validation uses native binary brands, rejects shared/oversized data and captures queued bytes by value', async () => {
    const h = await rig(), state = h.manager.create();
    try {
        for (const bad of [null, {}, { byteLength: 3, buffer: new ArrayBuffer(3) }, new Blob(['abc']), new SharedArrayBuffer(4), new Uint8Array(new SharedArrayBuffer(4))])
            await assert.rejects(state.update(bad), { name: 'TypeError' });
        await assert.rejects(state.update(new Uint8Array(256 * 1024 + 1)), { name: 'RangeError' });
        const bytes = Uint8Array.from([1, 2, 3]), operation = state.update(bytes); bytes.fill(9);
        await operation; assert.deepEqual([...bytes], [9, 9, 9]);
        assert.equal(await state.digestHex({ final: true }), digest(Buffer.from([1, 2, 3])));
    } finally { h.manager.disposeAll(); }
});
test('cross-realm buffers and views hash their exact byte ranges without shadowed getters', async () => {
    const h = await rig(), state = h.manager.create();
    try {
        const foreign = vm.runInNewContext('new Uint8Array([7,8,9,10]).subarray(1,3)');
        Object.defineProperty(foreign, 'byteLength', { get() { throw Error('private name'); } });
        Object.defineProperty(foreign, 'buffer', { get() { throw Error('private name'); } });
        await state.update(foreign);
        const foreignBuffer = vm.runInNewContext('Uint8Array.from([11,12]).buffer'); await state.update(foreignBuffer);
        assert.equal(await state.digestHex({ final: true }), digest(Buffer.from([8, 9, 11, 12])));
    } finally { h.manager.disposeAll(); }
});
test('four active/queued operations bound copied bytes and preserve FIFO snapshot offsets', async () => {
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker }), state = h.manager.create();
    try {
        const a = state.update(Uint8Array.from([1])), b = state.digestHex(), c = state.update(Uint8Array.from([2])), d = state.digestHex({ final: true });
        await assert.rejects(state.update(new Uint8Array(1)), { name: 'HashClosedError' });
        await tick(); const worker = f.workers[0]; assert.equal(worker.messages.length, 1); ready(worker);
        assert.equal(worker.messages.at(-1).data.offset, 0); acknowledge(worker); await a; await tick();
        assert.equal(worker.messages.at(-1).data.offset, 1); snapshot(worker, Buffer.from([1])); assert.equal(await b, digest(Buffer.from([1]))); await tick();
        assert.equal(worker.messages.at(-1).data.offset, 1); acknowledge(worker); await c; await tick();
        assert.equal(worker.messages.at(-1).data.offset, 2); snapshot(worker, Buffer.from([1, 2]), true); assert.equal(await d, digest(Buffer.from([1, 2])));
        assert.equal(state.bytes, 2); assert.equal(worker.terminated, true);
        const another = h.manager.create(), pending = Array.from({ length: 4 }, () => another.update(new Uint8Array(256 * 1024)));
        const settled = Promise.allSettled(pending);
        await assert.rejects(another.update(new Uint8Array(1)), { name: 'HashBusyError' });
        another.dispose(); assert.ok((await settled).every(item => item.reason.name === 'AbortError'));
    } finally { h.manager.disposeAll(); }
});
test('four handle leases are bounded before Worker creation and disposal frees only its own slot', async () => {
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker }), handles = Array.from({ length: 4 }, () => h.manager.create());
    try {
        assert.equal(f.workers.length, 0); assert.throws(() => h.manager.create(), { name: 'HashBusyError' });
        const pending = handles[0].update(new Uint8Array(1)), observed = assert.rejects(pending, { name: 'AbortError' });
        await tick(); handles[0].dispose(); await observed;
        assert.equal(f.workers[0].terminated, true); assert.equal(handles[1].closed, false);
        const replacement = h.manager.create(); assert.equal(h.manager._handles.size, 4); replacement.dispose();
    } finally { h.manager.disposeAll(); }
});
test('Worker gets only the owned copy, exact session protocol and captured script revision', async () => {
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker }); h.context.document.currentScript = null;
    const state = h.manager.create(), bytes = Uint8Array.from([1, 2, 3]), pending = state.update(bytes);
    try {
        await tick(); const worker = f.workers[0];
        assert.equal(worker.url, 'https://same.test/app/scripts/stream-hash-worker.js?v=revision');
        ready(worker); const message = worker.messages.at(-1);
        assert.deepEqual(Object.keys(message.data).sort(), ['chunk', 'offset', 'request', 'session', 'type']);
        assert.notEqual(message.data.chunk, bytes.buffer); assert.equal(message.transfer[0], message.data.chunk);
        assert.deepEqual([...new Uint8Array(message.data.chunk)], [1, 2, 3]); assert.equal(bytes.byteLength, 3);
        acknowledge(worker); await pending;
    } finally { state.dispose(); h.manager.disposeAll(); }
});
test('dispose rejects init/update/snapshot waiters and obsolete Worker replies cannot affect another handle', async () => {
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker }), a = h.manager.create(), b = h.manager.create();
    const first = a.update(new Uint8Array(1)), queued = a.digestHex(), second = b.update(new Uint8Array(2));
    const firstSettled = Promise.allSettled([first, queued]);
    try {
        await tick(); const old = f.workers[0], fresh = f.workers[1], oldMessage = old.onmessage, oldError = old.onerror;
        a.dispose(); assert.ok((await firstSettled).every(result => result.reason.name === 'AbortError'));
        oldMessage({ data: { type: 'updated', session: 2, request: 1, bytes: 2 } }); oldError({ preventDefault() {} });
        assert.equal(b.closed, false); assert.equal(fresh.terminated, false); ready(fresh); acknowledge(fresh); await second;
    } finally { h.manager.disposeAll(); }
});
test('worker errors, init/post failures and timeouts fail closed without main-thread retry', async () => {
    let calls = 0;
    for (const trigger of ['error', 'messageerror', 'timeout']) {
        const f = fakeWorkers(), h = await rig({ Worker: f.Worker, timeoutMs: 20, hashFactory() { calls++; throw Error('private'); } }), state = h.manager.create();
        const pending = state.update(new Uint8Array(1)); const checked = assert.rejects(pending, { name: trigger === 'timeout' ? 'HashTimeoutError' : 'HashWorkerError' });
        await tick(); if (trigger !== 'timeout') f.workers[0]['on' + trigger]({ preventDefault() {} });
        await checked; assert.equal(state.closed, true); assert.equal(h.manager._handles.size, 0); assert.equal(f.workers[0].terminated, true);
    }
    for (const Worker of [class { constructor() { throw Error('private-worker-url'); } }, class { postMessage() { throw Error('private-body'); } terminate() {} }]) {
        const h = await rig({ Worker, hashFactory() { calls++; } }); const state = h.manager.create();
        await assert.rejects(state.digestHex(), error => error.name === 'HashWorkerError' && !error.message.includes('private'));
        assert.equal(h.manager._handles.size, 0);
    }
    assert.equal(calls, 0);
});
test('malformed/future/session-mismatched Worker responses fail while stale completed requests are ignored', async () => {
    for (const payload of [d => ({ type: 'updated', session: d.session + 1, request: d.request, bytes: 3 }),
        d => ({ type: 'updated', session: d.session, request: d.request + 1, bytes: 3 }),
        d => ({ type: 'updated', session: d.session, request: d.request, bytes: 4 }),
        d => ({ type: 'updated', session: d.session, request: d.request, bytes: 3, private: 'name' }),
        d => ({ type: 'error', session: d.session, request: d.request, errorName: 'PrivateFilenameError' })]) {
        const f = fakeWorkers(), h = await rig({ Worker: f.Worker }), state = h.manager.create(), job = state.update(new Uint8Array(3));
        const checked = assert.rejects(job, error => error.name === 'HashProtocolError' && !error.message.includes('name'));
        await tick(); const worker = f.workers[0]; ready(worker); worker.send(payload(worker.messages.at(-1).data)); await checked;
        assert.equal(state.closed, true);
    }
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker }), state = h.manager.create();
    try {
        const a = state.update(new Uint8Array(1)); await tick(); const worker = f.workers[0]; ready(worker); acknowledge(worker); await a;
        const b = state.update(new Uint8Array(1)); await tick();
        worker.send({ type: 'updated', session: 1, request: 1, bytes: 1 }); assert.equal(state.closed, false);
        acknowledge(worker); await b; assert.equal(state.bytes, 2);
    } finally { h.manager.disposeAll(); }
});
test('pagehide disposes every live handle and new sessions can be created afterward', async () => {
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker }), state = h.manager.create(), job = state.digestHex();
    const checked = assert.rejects(job, { name: 'AbortError' }); await tick();
    for (const { name, fn } of h.events) if (name === 'pagehide') fn(); await checked;
    assert.equal(state.closed, true); const fresh = h.manager.create(); assert.equal(fresh.closed, false); fresh.dispose();
});
test('unsafe handle/request sequences and cumulative offsets never post reused identifiers', async () => {
    const f = fakeWorkers(), h = await rig({ Worker: f.Worker });
    h.manager._sequence = Number.MAX_SAFE_INTEGER; assert.throws(() => h.manager.create(), { name: 'HashBusyError' });
    h.manager._sequence = 0; const state = h.manager.create(); state._request = Number.MAX_SAFE_INTEGER;
    await assert.rejects(state.digestHex(), { name: 'HashProtocolError' }); assert.equal(f.workers.length, 0);
    state._request = 0; state._reservedBytes = Number.MAX_SAFE_INTEGER;
    await assert.rejects(state.update(new Uint8Array(1)), { name: 'HashProtocolError' }); assert.equal(f.workers.length, 0); state.dispose();
});
test('fallback read/hash failures and malformed digest never expose original errors or leave leased states', async () => {
    for (const factory of [() => { throw Error('private-file-name'); }, () => ({ update() { throw Error('private-file-name'); }, clone() {}, digest() {} }),
        () => ({ update() {}, clone() { return this; }, digest() { return new Uint8Array(31); } })]) {
        const h = await rig({ hashFactory: factory }), state = h.manager.create();
        await assert.rejects(state.update(new Uint8Array(1)).then(() => state.digestHex()), error => error.name === 'HashReadError' && !error.message.includes('private'));
        assert.equal(state.closed, true); assert.equal(h.manager._handles.size, 0);
    }
});
test('the actual Worker supports incremental snapshot/continuation/final vectors and rejects malformed state transitions', async () => {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    function worker() {
        const replies = [], context = vm.createContext({ sha256, ArrayBuffer, Uint8Array, self: { postMessage: value => replies.push(value) } });
        vm.runInContext(workerSource, context); return { replies, send: data => context.self.onmessage({ data }) };
    }
    for (const chunks of [[], [Buffer.from('abc')], [Buffer.alloc(256 * 1024, 0x7a), Buffer.from('中文 tail')]]) {
        const w = worker(); w.send({ type: 'init', session: 1, request: 0 }); assert.equal(w.replies.at(-1).type, 'ready');
        let request = 0, offset = 0; const body = [];
        for (const chunk of chunks) {
            const copy = Uint8Array.from(chunk); w.send({ type: 'update', session: 1, request: ++request, offset, chunk: copy.buffer }); offset += chunk.length; body.push(chunk);
            assert.equal(w.replies.at(-1).bytes, offset);
            w.send({ type: 'digest', session: 1, request: ++request, offset, final: false }); assert.equal(w.replies.at(-1).sha256, digest(Buffer.concat(body)));
        }
        w.send({ type: 'digest', session: 1, request: ++request, offset, final: true }); assert.equal(w.replies.at(-1).sha256, digest(Buffer.concat(body)));
        w.send({ type: 'digest', session: 1, request: ++request, offset, final: false }); assert.equal(w.replies.at(-1).type, 'error');
    }
    for (const mutate of [d => ({ ...d, offset: 1 }), d => ({ ...d, session: 2 }), d => ({ ...d, request: 3 }),
        d => ({ ...d, chunk: new Uint8Array(1) }), d => ({ ...d, chunk: new ArrayBuffer(256 * 1024 + 1) }), d => ({ ...d, name: 'private' })]) {
        const w = worker(); w.send({ type: 'init', session: 1, request: 0 });
        w.send(mutate({ type: 'update', session: 1, request: 1, offset: 0, chunk: new ArrayBuffer(1) }));
        assert.equal(w.replies.at(-1).type, 'error'); assert.equal(w.replies.at(-1).errorName, 'HashProtocolError');
        assert.deepEqual(Object.keys(w.replies.at(-1)).sort(), ['errorName', 'request', 'session', 'type']);
    }
});
test('bridge and actual Worker protocol agree through transferred copies, snapshots and final cleanup', async () => {
    const { sha256 } = await import('@noble/hashes/sha2.js'), workers = [];
    // Exercise the real protocol code with structured-clone transfer semantics.
    // Native browser thread creation is covered separately by browser E2E.
    class SourceWorker {
        constructor(url) {
            this.url = url; this.terminated = false; this.transferred = [];
            const self = { postMessage: data => {
                const copy = structuredClone(data);
                queueMicrotask(() => { if (!this.terminated) this.onmessage({ data: copy }); });
            } };
            this.context = vm.createContext({ sha256, ArrayBuffer, Uint8Array, self });
            vm.runInContext(workerSource, this.context); workers.push(this);
        }
        postMessage(data, transfer = []) {
            const copy = structuredClone(data, { transfer });
            for (const buffer of transfer) this.transferred.push(buffer);
            queueMicrotask(() => { if (!this.terminated) this.context.self.onmessage({ data: copy }); });
        }
        terminate() { this.terminated = true; }
    }
    const h = await rig({ Worker: SourceWorker, hashFactory() { throw Error('unexpected fallback'); } }), state = h.manager.create();
    try {
        assert.equal(state.backend, 'worker'); assert.equal(workers.length, 0);
        assert.equal(await state.digestHex(), digest(''));
        const first = Buffer.alloc(256 * 1024, 0x5b), tail = Buffer.from('中文\0continued');
        await state.update(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
        assert.equal(await state.digestHex(), digest(first));
        const caller = Uint8Array.from(tail), update = state.update(caller); caller.fill(0x31);
        await update;
        assert.equal(caller.byteLength, tail.length); assert.equal(first.byteLength, 256 * 1024);
        assert.deepEqual([...caller], new Array(tail.length).fill(0x31));
        assert.equal(await state.digestHex({ final: true }), digest(Buffer.concat([first, tail])));
        assert.equal(state.bytes, first.length + tail.length); assert.equal(state.closed, true);
        assert.equal(workers[0].transferred.length, 2);
        assert.ok(workers[0].transferred.every(buffer => buffer.byteLength === 0));
        assert.equal(workers[0].terminated, true); assert.equal(h.manager._handles.size, 0);
    } finally { h.manager.disposeAll(); }
});
