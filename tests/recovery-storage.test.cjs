'use strict';
// Deterministic async interleavings around the real recovery-worker methods.
// The in-memory OPFS fixture implements exclusive data handles and atomic JSON
// commits; browser disk semantics remain covered in recovery-browser.cjs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync('client/scripts/recovery-worker.js', 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function filesystem() {
    const files = new Map();
    const state = { files, beforeAcquire: null, beforeCommit: null };
    const directory = {
        async getDirectoryHandle() { return directory; },
        async getFileHandle(name, options = {}) {
            if (!files.has(name)) {
                if (!options.create) throw new DOMException('missing file', 'NotFoundError');
                files.set(name, { bytes: Buffer.alloc(0), modified: Date.now(), locked: false, writing: false });
            }
            const entry = files.get(name);
            return {
                async getFile() { return new File([entry.bytes], name, { lastModified: entry.modified }); },
                async createWritable() {
                    if (entry.writing) throw new DOMException('metadata in use', 'NoModificationAllowedError');
                    entry.writing = true; let pending = entry.bytes;
                    return {
                        async write(value) { pending = Buffer.from(value); },
                        async close() {
                            await state.beforeCommit?.(name, pending);
                            entry.bytes = pending; entry.modified = Date.now(); entry.writing = false;
                        },
                        async abort() { entry.writing = false; }
                    };
                },
                async createSyncAccessHandle() {
                    await state.beforeAcquire?.(name);
                    if (entry.locked) throw new DOMException('data in use', 'NoModificationAllowedError');
                    entry.locked = true;
                    return {
                        getSize: () => entry.bytes.length,
                        truncate(size) { const bytes = Buffer.alloc(size); entry.bytes.copy(bytes); entry.bytes = bytes; },
                        write(bytes, { at }) {
                            if (entry.bytes.length < at + bytes.byteLength) {
                                const grown = Buffer.alloc(at + bytes.byteLength); entry.bytes.copy(grown); entry.bytes = grown;
                            }
                            entry.bytes.set(bytes, at); return bytes.byteLength;
                        },
                        flush() { entry.modified = Date.now(); },
                        close() { entry.locked = false; }
                    };
                }
            };
        },
        async removeEntry(name) {
            const entry = files.get(name);
            if (!entry) throw new DOMException('missing file', 'NotFoundError');
            if (entry.locked || entry.writing) throw new DOMException('file in use', 'NoModificationAllowedError');
            files.delete(name);
        },
        async *entries() { for (const name of [...files.keys()]) yield [name, {}]; }
    };
    return Object.assign(state, { directory });
}
function worker(storage) {
    const jobs = new Map(); let sequence = 0;
    const self = { postMessage(message) {
        const job = jobs.get(message.request); jobs.delete(message.request);
        if (message.ok) job.resolve(message.value);
        else { const error = Error(message.error); error.name = message.errorName; job.reject(error); }
    } };
    const context = vm.createContext({ navigator: { storage: { getDirectory: async () => storage.directory } }, self, crypto: crypto.webcrypto, Date, ArrayBuffer, Uint8Array });
    vm.runInContext(source, context);
    return { request(type, ...args) {
        const request = ++sequence;
        return new Promise((resolve, reject) => { jobs.set(request, { resolve, reject }); self.onmessage({ data: { request, type, args } }); });
    } };
}
function metadata() { return { id: crypto.randomUUID(), name: '并发恢复.bin', size: 3 * 16384, mime: 'application/octet-stream' }; }

test('erase waits for an earlier checkpoint commit instead of deleting its data underneath it', async () => {
    const storage = filesystem(), a = worker(storage), meta = metadata();
    const bytes = Buffer.alloc(16384, 7);
    await a.request('start', meta); await a.request('append', meta.id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const started = deferred(), release = deferred();
    storage.beforeCommit = async () => { started.resolve(); await release.promise; };
    const checkpoint = a.request('checkpoint', meta.id, digest(bytes), true);
    await started.promise;
    const erase = a.request('erase', meta.id); const settledErase = erase.catch(error => error);
    await turn(); const dataStillPresent = storage.files.has(meta.id + '.part');
    release.resolve(); await checkpoint; const erased = await settledErase;
    assert.equal(dataStillPresent, true, 'erase must not race the in-progress checkpoint');
    assert.equal(erased, true); assert.deepEqual([...storage.files.keys()], ['mutation-lock'], 'no metadata or part can be resurrected');
    assert.equal(storage.files.get('mutation-lock').bytes.length, 0);
});

test('resume rereads the latest committed checkpoint after acquiring its data lock', async () => {
    const storage = filesystem(), a = worker(storage), b = worker(storage), meta = metadata();
    const first = Buffer.alloc(16384, 1), second = Buffer.alloc(16384, 2);
    await a.request('start', meta); await a.request('append', meta.id, first.buffer.slice(first.byteOffset, first.byteOffset + first.length));
    await a.request('park', meta.id, digest(first));
    const started = deferred(), release = deferred(); let blocked = false;
    storage.beforeAcquire = async () => { if (!blocked) { blocked = true; started.resolve(); await release.promise; } };
    const oldResume = b.request('resume', meta.id, meta); await started.promise;
    await a.request('resume', meta.id, meta);
    await a.request('append', meta.id, second.buffer.slice(second.byteOffset, second.byteOffset + second.length));
    const expected = Buffer.concat([first, second]); await a.request('park', meta.id, digest(expected));
    release.resolve(); const resumed = await oldResume;
    assert.equal(resumed.meta.offset, expected.length); assert.equal(resumed.snapshot.size, expected.length);
    assert.deepEqual(Buffer.from(await resumed.snapshot.arrayBuffer()), expected);
    assert.equal(storage.files.get(meta.id + '.part').bytes.length, expected.length, 'newer persisted bytes must never be truncated to the old offset');
    await b.request('park', meta.id, digest(expected));
});

test('finish keeps the data lock until complete metadata is published', async () => {
    const storage = filesystem(), a = worker(storage), b = worker(storage), meta = { ...metadata(), size: 16384 };
    const bytes = Buffer.alloc(meta.size, 3), sha = digest(bytes);
    await a.request('start', meta); await a.request('append', meta.id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const started = deferred(), release = deferred();
    storage.beforeCommit = async (name, value) => { if (JSON.parse(value).phase === 'complete') { started.resolve(); await release.promise; } };
    const finish = a.request('finish', meta.id, sha); await started.promise;
    const refused = await b.request('erase', meta.id).then(() => null, error => error);
    const locked = storage.files.get(meta.id + '.part')?.locked;
    release.resolve(); const result = await finish;
    assert.equal(locked, true); assert.equal(refused?.name, 'NoModificationAllowedError');
    assert.equal(result.meta.phase, 'complete'); assert.equal(result.file.size, bytes.length);
    assert.deepEqual(Buffer.from(await result.file.arrayBuffer()), bytes);
    await b.request('erase', meta.id);
});

test('an obsolete worker error cannot reject or terminate the replacement worker', async () => {
    const workers = [];
    class Worker { constructor() { workers.push(this); } postMessage(message) { this.last = message; } terminate() { this.terminated = true; } }
    const window = {}, context = vm.createContext({ window, Worker, navigator: { storage: { getDirectory() {} } } });
    vm.runInContext(fs.readFileSync('client/scripts/recovery.js', 'utf8'), context);
    const store = window.ZeydropRecovery;
    const first = store.request('list').catch(error => error); const old = workers[0]; old.onerror();
    assert.match((await first).message, /已中断/);
    const next = store.request('list'); const current = workers[1]; old.onerror();
    assert.equal(store.worker, current); assert.ok(!current.terminated);
    current.onmessage({ data: { request: current.last.request, ok: true, value: ['replacement result'] } });
    assert.deepEqual(await next, ['replacement result']);
    const badMessage = store.request('list').catch(error => error); current.onmessageerror();
    assert.match((await badMessage).message, /已中断/); assert.equal(store.pending.size, 0);
});

test('expired or corrupt records stay manageable when safe cleanup is blocked', async () => {
    const storage = filesystem(), a = worker(storage), meta = metadata();
    const bytes = Buffer.alloc(16384, 9);
    await a.request('start', meta); await a.request('append', meta.id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    await a.request('park', meta.id, digest(bytes));
    const header = storage.files.get(meta.id + '.json');
    const value = JSON.parse(header.bytes); value.createdAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    header.bytes = Buffer.from(JSON.stringify(value));
    const expired = await a.request('list');
    assert.equal(expired.length, 1); assert.equal(expired[0].phase, 'expired');
    await assert.rejects(a.request('resume', meta.id, meta), /匹配/);
    value.createdAt = Date.now() + 120000; header.bytes = Buffer.from(JSON.stringify(value));
    assert.equal((await a.request('list'))[0].phase, 'invalid');
    await assert.rejects(a.request('resume', meta.id, meta), /匹配/);
    // A stale corrupt entry may be locked by another context. Failed garbage
    // collection must leave a visible record, not hide retained private bytes.
    const stale = Date.now() - 2 * 24 * 60 * 60 * 1000;
    header.bytes = Buffer.from('{truncated'); header.modified = stale;
    const part = storage.files.get(meta.id + '.part'); part.modified = stale; part.locked = true;
    const corrupt = await a.request('list');
    assert.equal(corrupt.length, 1); assert.equal(corrupt[0].phase, 'invalid');
    part.locked = false; await a.request('erase', meta.id); assert.deepEqual([...storage.files.keys()], ['mutation-lock']); assert.equal(storage.files.get('mutation-lock').bytes.length, 0);
});
