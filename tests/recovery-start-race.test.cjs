'use strict';
// Real recovery-worker entry points with two independent Worker contexts and a
// shared, exclusive OPFS-boundary fixture. This is not native disk evidence.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync('client/scripts/recovery-worker.js', 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const asBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
function filesystem() {
    const files = new Map(), mutations = [], erased = [];
    const state = { files, mutations, erased, beforeCreate: null, beforeRemove: null, afterClose: null, closeCalls: [], failHeaderCreate: null, failHeaderLookup: null, failClose: false, failMetaWrite: false };
    const directory = {
        async getDirectoryHandle() { return directory; },
        async getFileHandle(name, options = {}) {
            if (options.create) await state.beforeCreate?.(name);
            if (options.create && state.failHeaderCreate === name) {
                state.failHeaderCreate = null;
                throw new DOMException('initial header creation unavailable', 'QuotaExceededError');
            }
            if (!options.create && state.failHeaderLookup === name) {
                state.failHeaderLookup = null;
                throw new DOMException('header lookup unavailable', 'NotAllowedError');
            }
            if (!files.has(name)) {
                if (!options.create) throw new DOMException('not found', 'NotFoundError');
                files.set(name, { bytes: Buffer.alloc(0), locked: false, writing: false, modified: Date.now() });
            }
            const item = files.get(name);
            return {
                async getFile() { return new File([item.bytes], name, { lastModified: item.modified }); },
                async createWritable() {
                    if (item.writing) throw new DOMException('metadata locked', 'NoModificationAllowedError');
                    item.writing = true; let pending;
                    return {
                        async write(value) {
                            if (state.failMetaWrite) { state.failMetaWrite = false; throw Error('initial publication failed'); }
                            pending = Buffer.from(value);
                        },
                        async close() { item.bytes = pending; item.writing = false; item.modified = Date.now(); mutations.push(['metadata', name]); },
                        async abort() { item.writing = false; }
                    };
                },
                async createSyncAccessHandle() {
                    if (item.locked) throw new DOMException('data locked', 'NoModificationAllowedError');
                    item.locked = true;
                    return {
                        getSize: () => item.bytes.length,
                        truncate(size) { mutations.push(['truncate', name, size]); const next = Buffer.alloc(size); item.bytes.copy(next); item.bytes = next; },
                        write(bytes, { at }) {
                            if (at + bytes.byteLength > item.bytes.length) {
                                const next = Buffer.alloc(at + bytes.byteLength); item.bytes.copy(next); item.bytes = next;
                            }
                            item.bytes.set(bytes, at); mutations.push(['write', name, at, bytes.byteLength]); return bytes.byteLength;
                        },
                        flush() { item.modified = Date.now(); },
                        close() {
                            state.closeCalls.push(name);
                            if (state.failClose) { state.failClose = false; throw new DOMException('native close failed', 'NotAllowedError'); }
                            item.locked = false; state.afterClose?.(name);
                        }
                    };
                }
            };
        },
        async removeEntry(name) {
            await state.beforeRemove?.(name);
            const item = files.get(name);
            if (!item) throw new DOMException('not found', 'NotFoundError');
            if (item.locked || item.writing) throw new DOMException('locked', 'NoModificationAllowedError');
            erased.push(name); files.delete(name);
        },
        async *entries() { for (const name of [...files.keys()]) yield [name, {}]; }
    };
    return Object.assign(state, { directory });
}
function worker(storage) {
    const jobs = new Map(); let sequence = 0;
    const context = vm.createContext({ navigator: { storage: { getDirectory: async () => storage.directory } },
        crypto: crypto.webcrypto, Date, ArrayBuffer, Uint8Array, self: { postMessage(message) {
            const job = jobs.get(message.request); jobs.delete(message.request);
            if (message.ok) job.resolve(message.value);
            else { const error = Error(message.error); error.name = message.errorName; job.reject(error); }
        } } });
    vm.runInContext(source, context);
    return {
        activeCount: () => vm.runInContext('active.size', context),
        request(type, ...args) {
            return new Promise((resolve, reject) => {
                const request = ++sequence; jobs.set(request, { resolve, reject });
                context.self.onmessage({ data: { request, type, args } });
            });
        }
    };
}
async function race(phase = 'partial') {
    const storage = filesystem(), a = worker(storage), b = worker(storage);
    const meta = { id: crypto.randomUUID(), name: 'committed-prefix.bin', size: phase === 'complete' ? 16384 : 32768, mime: 'application/octet-stream' };
    const entered = deferred(), release = deferred(); let blocked = false;
    storage.beforeCreate = async name => {
        if (!blocked && name === meta.id + '.part') { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = b.request('start', meta).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await a.request('start', meta);
    const prefix = Buffer.alloc(16384, 0x5a);
    await a.request('append', meta.id, asBuffer(prefix));
    if (phase === 'complete') await a.request('finish', meta.id, digest(prefix));
    else await a.request('park', meta.id, digest(prefix));
    if (phase === 'corrupt') storage.files.get(meta.id + '.json').bytes = Buffer.from('{broken header');
    const other = { id: crypto.randomUUID(), name: 'independent.bin', size: 1, mime: 'application/octet-stream' };
    await a.request('start', other); await a.request('append', other.id, asBuffer(Buffer.from([9])));
    await a.request('park', other.id, digest(Buffer.from([9])));
    const snapshots = new Map([...storage.files].map(([name, entry]) => [name, Buffer.from(entry.bytes)]));
    const beforeMutations = storage.mutations.length;
    return { storage, a, b, meta, prefix, pending, release, snapshots, beforeMutations };
}
function unchanged(h) {
    assert.deepEqual([...h.storage.files.keys()].sort(), [...h.snapshots.keys()].sort());
    for (const [name, bytes] of h.snapshots) assert.deepEqual(h.storage.files.get(name).bytes, bytes, 'the other worker record must remain: ' + name);
    assert.equal(h.storage.mutations.length, h.beforeMutations, 'a stale start must not truncate or rewrite anything');
    assert.deepEqual(h.storage.erased, [], 'rejected initialization must not call erase on an existing record');
    assert.equal(h.b.activeCount(), 0);
}
for (const phase of ['partial', 'complete', 'corrupt']) test('stale start refuses a newly published ' + phase + ' record after acquiring its native data lock', async () => {
    const h = await race(phase); h.release.resolve(); const result = await h.pending;
    assert.ok(result.error, 'the stale start must reject rather than replace the record');
    assert.match(result.error.message, /已有同名断点/); unchanged(h);
    assert.equal(h.storage.files.get(h.meta.id + '.part').locked, false, 'the rejected opener must close only its newly acquired handle');
    if (phase === 'partial') {
        const restored = await h.a.request('resume', h.meta.id, h.meta);
        assert.equal(restored.meta.offset, h.prefix.length); assert.equal(restored.meta.prefixSha256, digest(h.prefix));
        assert.deepEqual(Buffer.from(await restored.snapshot.arrayBuffer()), h.prefix);
        await h.a.request('park', h.meta.id, digest(h.prefix));
    } else if (phase === 'complete') {
        const result = await h.a.request('completed', h.meta.id);
        assert.equal(result.meta.completeSha256, digest(h.prefix)); assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), h.prefix);
    }
});
test('a metadata lookup failure under the acquired lock preserves existing records and closes the new handle', async () => {
    const h = await race(); h.storage.failHeaderLookup = h.meta.id + '.json'; h.release.resolve();
    const result = await h.pending; assert.equal(result.error?.name, 'NotAllowedError'); unchanged(h);
    assert.equal(h.storage.files.get(h.meta.id + '.part').locked, false);
});
test('a native close failure when rejecting the stale opener is reported without erasing or claiming physical release', async () => {
    const h = await race(); h.storage.failClose = true; h.release.resolve();
    const result = await h.pending; assert.equal(result.error?.name, 'NotAllowedError'); unchanged(h);
    assert.equal(h.storage.files.get(h.meta.id + '.part').locked, true, 'native close failed; the fixture intentionally retains its physical lock');
    h.storage.files.get(h.meta.id + '.part').locked = false; // fixture teardown only, not a product recovery claim
});
test('fresh initialization remains usable and a failed publication retains only its empty manageable stub', async () => {
    const storage = filesystem(), a = worker(storage), b = worker(storage);
    const fresh = { id: crypto.randomUUID(), name: 'new.bin', size: 16384, mime: 'application/octet-stream' };
    await a.request('start', fresh); const data = Buffer.alloc(fresh.size, 3);
    await a.request('append', fresh.id, asBuffer(data)); await a.request('park', fresh.id, digest(data));
    const old = new Map([...storage.files].map(([name, entry]) => [name, Buffer.from(entry.bytes)]));
    const bad = { ...fresh, id: crypto.randomUUID(), name: 'failed-new.bin' }; storage.failMetaWrite = true;
    const closes = storage.closeCalls.length;
    await assert.rejects(b.request('start', bad), /initial publication failed/);
    assert.equal(b.activeCount(), 0); assert.equal(storage.files.get(bad.id + '.part').bytes.length, 0);
    assert.equal(storage.files.get(bad.id + '.json').bytes.length, 0);
    assert.equal(storage.files.get(bad.id + '.part').locked, false);
    assert.deepEqual(storage.closeCalls.slice(closes), [bad.id + '.part']);
    for (const [name, bytes] of old) assert.deepEqual(storage.files.get(name).bytes, bytes);
    assert.deepEqual(storage.erased, [], 'post-close initialization cleanup must never erase by a reused ID');
    const listed = await b.request('list');
    assert.equal(listed.find(item => item.id === bad.id)?.phase, 'invalid', 'an invalid published header stays manually manageable');
    await b.request('erase', bad.id);
    assert.deepEqual([...storage.files.keys()].sort(), [...old.keys()].sort(), 'explicit user deletion can remove the failed stub');
});

test('a failed initializer must not erase a same-ID record committed after its data handle closes', async () => {
    const storage = filesystem(), a = worker(storage), b = worker(storage);
    const meta = { id: crypto.randomUUID(), name: 'published-after-failed-start.bin', size: 32768, mime: 'application/octet-stream' };
    const entered = deferred(), release = deferred(), closed = deferred(); let delayed = false;
    storage.afterClose = name => { if (name === meta.id + '.part') closed.resolve(); };
    storage.beforeRemove = async name => {
        if (!delayed && name === meta.id + '.part') { delayed = true; entered.resolve(); await release.promise; }
    };
    storage.failHeaderCreate = meta.id + '.json';
    const pending = b.request('start', meta).then(value => ({ value }), error => ({ error }));
    await closed.promise;
    // Old code suspends inside its destructive erase; fixed code has already
    // rejected after close without scheduling that obsolete deletion.
    await Promise.race([entered.promise, pending]);
    assert.equal(storage.files.has(meta.id + '.json'), false, 'the failed start never published a header');
    assert.equal(storage.files.get(meta.id + '.part').locked, false, 'failure cleanup released its original data handle');
    await a.request('start', meta); const prefix = Buffer.alloc(16384, 0x7c);
    await a.request('append', meta.id, asBuffer(prefix)); await a.request('park', meta.id, digest(prefix));
    const header = Buffer.from(storage.files.get(meta.id + '.json').bytes);
    release.resolve(); const result = await pending;
    assert.equal(result.error?.name, 'QuotaExceededError');
    assert.equal(storage.files.has(meta.id + '.part'), true, 'late failed-start cleanup must not delete a newly committed prefix');
    assert.equal(digest(storage.files.get(meta.id + '.part').bytes), digest(prefix));
    assert.deepEqual(storage.files.get(meta.id + '.json')?.bytes, header, 'late failed-start cleanup must not delete newly published metadata');
    assert.equal(b.activeCount(), 0);
    assert.deepEqual(storage.erased, []);
});


test('initial publication error survives a simultaneous close failure without claiming release or deleting the stub', async () => {
    const storage = filesystem(), a = worker(storage);
    const meta = { id: crypto.randomUUID(), name: 'failed-and-locked.bin', size: 16384, mime: 'application/octet-stream' };
    storage.failMetaWrite = true; storage.failClose = true;
    await assert.rejects(a.request('start', meta), /initial publication failed/);
    assert.equal(a.activeCount(), 0); assert.equal(storage.files.get(meta.id + '.part').locked, true);
    assert.deepEqual(storage.closeCalls, [meta.id + '.part']); assert.deepEqual(storage.erased, []);
    assert.equal(storage.files.get(meta.id + '.part').bytes.length, 0);
    storage.files.get(meta.id + '.part').locked = false; // fixture teardown only
});

test('a failed headerless initialization is later removed by the existing orphan TTL cleanup', async () => {
    const storage = filesystem(), a = worker(storage);
    const meta = { id: crypto.randomUUID(), name: 'orphan.bin', size: 16384, mime: 'application/octet-stream' };
    storage.failHeaderCreate = meta.id + '.json';
    await assert.rejects(a.request('start', meta), error => error.name === 'QuotaExceededError');
    assert.equal(storage.files.has(meta.id + '.json'), false); assert.equal(storage.files.get(meta.id + '.part').bytes.length, 0);
    assert.equal(storage.files.get(meta.id + '.part').locked, false); assert.deepEqual(storage.erased, []);
    storage.files.get(meta.id + '.part').modified = Date.now() - 25 * 60 * 60 * 1000;
    assert.equal((await a.request('list')).length, 0);
    assert.equal(storage.files.size, 0); assert.deepEqual(storage.erased, [meta.id + '.part']);
});
