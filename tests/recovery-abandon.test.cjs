'use strict';
// Execute the actual OPFS worker against native-boundary fixtures. An append
// may have reached storage before its hash fails; release must not publish an
// old digest at the new offset or delete the previously committed checkpoint.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const workerSource = fs.readFileSync('client/scripts/recovery-worker.js', 'utf8');
const bridgeSource = fs.readFileSync('client/scripts/recovery.js', 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
    const state = { files: new Map(), erases: [], closes: [], flushes: 0, metadataWrites: 0,
        closeErrors: new Map(), blockNextCommit: null, commitEntered: deferred(), replies: [], waiting: new Map() };
    const directory = {
        async getDirectoryHandle() { return directory; },
        async getFileHandle(name, { create = false } = {}) {
            if (!state.files.has(name)) {
                if (!create) throw new DOMException('missing', 'NotFoundError');
                state.files.set(name, { bytes: Buffer.alloc(0), locked: false, writing: false, modified: Date.now() });
            }
            const entry = state.files.get(name);
            return {
                async getFile() { return new File([entry.bytes], name, { lastModified: entry.modified }); },
                async createWritable() {
                    if (entry.writing) throw new DOMException('writer held', 'NoModificationAllowedError');
                    entry.writing = true; let pending = Buffer.from(entry.bytes);
                    return {
                        async write(value) { pending = Buffer.from(value); },
                        async close() {
                            const block = state.blockNextCommit; state.blockNextCommit = null;
                            if (block) { state.commitEntered.resolve(); await block.promise; }
                            entry.bytes = pending; entry.writing = false; entry.modified = Date.now(); state.metadataWrites++;
                        },
                        async abort() { entry.writing = false; }
                    };
                },
                async createSyncAccessHandle() {
                    if (entry.locked) throw new DOMException('access held', 'NoModificationAllowedError');
                    entry.locked = true;
                    return {
                        getSize() { return entry.bytes.length; },
                        truncate(size) { const next = Buffer.alloc(size); entry.bytes.copy(next); entry.bytes = next; },
                        write(bytes, { at }) {
                            if (entry.bytes.length < at + bytes.length) {
                                const next = Buffer.alloc(at + bytes.length); entry.bytes.copy(next); entry.bytes = next;
                            }
                            entry.bytes.set(bytes, at); return bytes.length;
                        },
                        flush() { state.flushes++; entry.modified = Date.now(); },
                        close() {
                            state.closes.push(name); const error = state.closeErrors.get(name);
                            if (error) throw error;
                            entry.locked = false;
                        }
                    };
                }
            };
        },
        async removeEntry(name) {
            state.erases.push(name); const entry = state.files.get(name);
            if (entry?.locked || entry?.writing) throw new DOMException('held', 'NoModificationAllowedError');
            state.files.delete(name);
        },
        async *entries() { for (const name of state.files.keys()) yield [name, {}]; }
    };
    const self = { postMessage(message) {
        state.replies.push(message); state.waiting.get(message.request)?.resolve(message); state.waiting.delete(message.request);
    } };
    const context = vm.createContext({ navigator: { storage: { getDirectory: async () => directory } }, self,
        crypto: crypto.webcrypto, Date, ArrayBuffer, Uint8Array });
    vm.runInContext(workerSource + '\nthis.ops={start,append,checkpoint,park,resume,active,releaseCommitted:typeof releaseCommitted===\'function\'?releaseCommitted:null};', context);
    let sequence = 0;
    const dispatch = (type, ...args) => {
        const request = ++sequence, gate = deferred(); state.waiting.set(request, gate);
        self.onmessage({ data: { request, type, args } }); return gate.promise;
    };
    return { state, ops: context.ops, dispatch };
}
async function prepare({ prefix = Buffer.from([1, 2, 3]), tail = Buffer.from([4, 5]) } = {}) {
    const h = fixture(), meta = { id: crypto.randomUUID(), name: 'recoverable-prefix.bin', mime: 'application/octet-stream', size: prefix.length + tail.length + 9 };
    await h.ops.start(meta);
    if (prefix.length) { await h.ops.append(meta.id, arrayBuffer(prefix)); await h.ops.checkpoint(meta.id, digest(prefix), true); }
    const committed = Buffer.from(h.state.files.get(meta.id + '.json').bytes);
    if (tail.length) await h.ops.append(meta.id, arrayBuffer(tail));
    return { ...h, meta, prefix, tail, committed };
}
function available(h) { assert.equal(typeof h.ops.releaseCommitted, 'function', 'safe release must exist instead of publishing an unavailable digest'); }
function intact(h) {
    assert.deepEqual(h.state.files.get(h.meta.id + '.json').bytes, h.committed, 'release cannot rewrite committed metadata');
    assert.deepEqual(h.state.files.get(h.meta.id + '.part').bytes, Buffer.concat([h.prefix, h.tail]), 'release itself cannot truncate or erase the uncommitted tail');
    assert.deepEqual(h.state.erases, []);
}

test('releasing unhashed appended bytes preserves the committed prefix and a later resume truncates only the tail', async () => {
    const h = await prepare(); available(h);
    const writes = h.state.metadataWrites, flushes = h.state.flushes;
    assert.equal(await h.ops.releaseCommitted(h.meta.id), h.prefix.length); intact(h);
    assert.equal(h.ops.active.has(h.meta.id), false); assert.equal(h.state.files.get(h.meta.id + '.part').locked, false);
    assert.equal(h.state.metadataWrites, writes); assert.equal(h.state.flushes, flushes);
    const restored = await h.ops.resume(h.meta.id, h.meta);
    assert.equal(restored.meta.offset, h.prefix.length); assert.equal(restored.meta.prefixSha256, digest(h.prefix));
    assert.deepEqual(Buffer.from(await restored.snapshot.arrayBuffer()), h.prefix);
    assert.deepEqual(h.state.files.get(h.meta.id + '.part').bytes, h.prefix);
    await h.ops.releaseCommitted(h.meta.id);
});

test('a zero committed offset remains distinguishable from an already released handle without making it resumable', async () => {
    const h = await prepare({ prefix: Buffer.alloc(0), tail: Buffer.from([7]) }); available(h);
    assert.equal(await h.ops.releaseCommitted(h.meta.id), 0); intact(h);
    assert.equal(await h.ops.releaseCommitted(h.meta.id), null); assert.equal(h.state.closes.length, 1);
    await assert.rejects(h.ops.resume(h.meta.id, h.meta), /匹配/);
});

test('release is scoped to the requested active item, idempotent and rejects invalid identifiers without touching another writer', async () => {
    const h = await prepare(); available(h);
    const other = { id: crypto.randomUUID(), name: 'other.bin', mime: 'application/octet-stream', size: 8 };
    await h.ops.start(other); await h.ops.append(other.id, arrayBuffer(Buffer.from([6])));
    const otherMetadata = Buffer.from(h.state.files.get(other.id + '.json').bytes);
    assert.equal(await h.ops.releaseCommitted(crypto.randomUUID()), null);
    for (const value of [undefined, null, 123, '../file', 'not-an-id']) await assert.rejects(h.ops.releaseCommitted(value));
    assert.equal(await h.ops.releaseCommitted(h.meta.id), h.prefix.length);
    assert.equal(await h.ops.releaseCommitted(h.meta.id), null); intact(h);
    assert.equal(h.ops.active.has(other.id), true); assert.equal(h.state.files.get(other.id + '.part').locked, true);
    assert.deepEqual(h.state.files.get(other.id + '.json').bytes, otherMetadata);
    assert.deepEqual(h.state.files.get(other.id + '.part').bytes, Buffer.from([6]));
    assert.deepEqual(h.state.closes, [h.meta.id + '.part']); await h.ops.releaseCommitted(other.id);
});

test('native close failure rejects the original error, drops logical ownership and preserves data without claiming physical unlock', async () => {
    const h = await prepare(); available(h);
    const error = new DOMException('synthetic close failure', 'InvalidStateError');
    h.state.closeErrors.set(h.meta.id + '.part', error);
    await assert.rejects(h.ops.releaseCommitted(h.meta.id), received => received === error); intact(h);
    assert.equal(h.ops.active.has(h.meta.id), false); assert.equal(h.state.files.get(h.meta.id + '.part').locked, true);
    assert.equal(await h.ops.releaseCommitted(h.meta.id), null);
    await assert.rejects(h.ops.resume(h.meta.id, h.meta), /另一标签页/);
});

test('actual worker task ordering completes an append before releasing the same handle without publishing its unhashed bytes', { timeout: 5000 }, async () => {
    const h = await prepare({ tail: Buffer.alloc(0) }); available(h);
    h.state.blockNextCommit = deferred(); const block = h.state.blockNextCommit;
    const checkpoint = h.dispatch('checkpoint', h.meta.id, digest(h.prefix), true);
    await h.state.commitEntered.promise;
    const appended = Buffer.from([4, 5]), append = h.dispatch('append', h.meta.id, arrayBuffer(appended));
    const release = h.dispatch('releaseCommitted', h.meta.id);
    assert.deepEqual(h.state.replies, []); assert.equal(h.state.closes.length, 0);
    assert.equal(h.ops.active.get(h.meta.id).offset, h.prefix.length);
    block.resolve();
    const responses = await Promise.all([checkpoint, append, release]);
    assert.ok(responses.every(response => response.ok === true));
    assert.deepEqual(h.state.replies.map(response => response.request), [1, 2, 3]);
    assert.equal(responses[1].value, h.prefix.length + appended.length); assert.equal(responses[2].value, h.prefix.length);
    assert.equal(h.ops.active.has(h.meta.id), false); assert.equal(h.state.closes.length, 1);
    assert.deepEqual(h.state.files.get(h.meta.id + '.json').bytes, h.committed);
    assert.deepEqual(h.state.files.get(h.meta.id + '.part').bytes, Buffer.concat([h.prefix, appended]));
    const restored = await h.ops.resume(h.meta.id, h.meta);
    assert.deepEqual(Buffer.from(await restored.snapshot.arrayBuffer()), h.prefix); await h.ops.releaseCommitted(h.meta.id);
});

test('durable bridge sends only the release operation and id, then waits for the acknowledged committed offset', async () => {
    const workers = [];
    class Worker {
        constructor() { this.posts = []; workers.push(this); }
        postMessage(message) { this.posts.push(message); }
        terminate() {}
    }
    const context = vm.createContext({ Worker, navigator: { storage: { getDirectory() {} } }, window: {}, URL, ArrayBuffer });
    vm.runInContext(bridgeSource + '\nthis.Sink=ZeydropDurableSink;', context);
    const store = context.window.ZeydropRecovery, sink = new context.Sink(store, 'a'.repeat(32), { size: 20 }, 5);
    assert.equal(typeof sink.parkCommitted, 'function');
    let settled = false; const releasing = sink.parkCommitted().then(value => { settled = true; return value; });
    const worker = workers[0], message = worker.posts[0];
    assert.equal(message.type, 'releaseCommitted'); assert.deepEqual([...message.args], ['a'.repeat(32)]);
    assert.equal(store.pending.size, 1); await Promise.resolve(); assert.equal(settled, false);
    worker.onmessage({ data: { request: message.request, ok: true, value: 0 } });
    assert.equal(await releasing, 0); assert.equal(sink.lastCommitted, 0);
    assert.equal(sink.size, 5, 'acknowledged release does not claim that file tail was truncated');
    assert.equal(sink.saved, false); assert.equal(store.pending.size, 0);
});
