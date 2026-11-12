'use strict';
// Actual recovery Worker entry points in independent contexts over an OPFS
// boundary fixture. Deleted native file handles become invalid in this model;
// this is deterministic scheduling evidence, not native-browser disk evidence.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync('client/scripts/recovery-worker.js', 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const asBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
function filesystem() {
    const files = new Map(), erased = [];
    const state = { files, erased, beforeRemove: null, afterSnapshot: null, failClose: null, failHeaderCreate: null, closeCalls: [] };
    function directory(owner) {
        return {
            async getDirectoryHandle() { return directory(owner); },
            async getFileHandle(name, options = {}) {
                if (options.create && state.failHeaderCreate === name) {
                    state.failHeaderCreate = null; throw new DOMException('publication failed', 'QuotaExceededError');
                }
                if (!files.has(name)) {
                    if (!options.create) throw new DOMException('not found', 'NotFoundError');
                    files.set(name, { bytes: Buffer.alloc(0), modified: Date.now(), locked: false, writing: false });
                }
                const entry = files.get(name);
                function present() { if (files.get(name) !== entry) throw new DOMException('deleted entry', 'NotFoundError'); }
                return {
                    async getFile() {
                        present(); const snapshot = new File([entry.bytes], name, { lastModified: entry.modified });
                        await state.afterSnapshot?.(owner, name, snapshot); return snapshot;
                    },
                    async createWritable() {
                        present(); if (entry.locked || entry.writing) throw new DOMException('locked', 'NoModificationAllowedError');
                        entry.writing = true; let pending = entry.bytes;
                        return {
                            async write(value) { present(); pending = Buffer.from(value); },
                            async close() { present(); entry.bytes = pending; entry.modified = Date.now(); entry.writing = false; },
                            async abort() { entry.writing = false; }
                        };
                    },
                    async createSyncAccessHandle() {
                        present(); if (entry.locked || entry.writing) throw new DOMException('locked', 'NoModificationAllowedError');
                        entry.locked = true;
                        return {
                            getSize() { present(); return entry.bytes.length; },
                            truncate(size) { present(); const bytes = Buffer.alloc(size); entry.bytes.copy(bytes); entry.bytes = bytes; },
                            write(bytes, { at }) {
                                present(); if (at + bytes.byteLength > entry.bytes.length) {
                                    const grown = Buffer.alloc(at + bytes.byteLength); entry.bytes.copy(grown); entry.bytes = grown;
                                }
                                entry.bytes.set(bytes, at); entry.modified = Date.now(); return bytes.byteLength;
                            },
                            flush() { present(); entry.modified = Date.now(); },
                            close() {
                                state.closeCalls.push(name);
                                if (state.failClose === name) { state.failClose = null; throw new DOMException('native close failed', 'NotAllowedError'); }
                                entry.locked = false;
                            }
                        };
                    }
                };
            },
            async removeEntry(name) {
                await state.beforeRemove?.(owner, name);
                const entry = files.get(name);
                if (!entry) throw new DOMException('not found', 'NotFoundError');
                if (entry.locked || entry.writing) throw new DOMException('locked', 'NoModificationAllowedError');
                files.delete(name); erased.push([owner, name]);
            },
            async *entries() { for (const name of [...files.keys()]) yield [name, {}]; }
        };
    }
    return Object.assign(state, { directory });
}
function worker(storage, owner) {
    const jobs = new Map(); let sequence = 0;
    const context = vm.createContext({ navigator: { storage: { getDirectory: async () => storage.directory(owner) } },
        crypto: crypto.webcrypto, Date, ArrayBuffer, Uint8Array, self: { postMessage(message) {
            const job = jobs.get(message.request); jobs.delete(message.request);
            if (message.ok) job.resolve(message.value);
            else { const error = Error(message.error); error.name = message.errorName; job.reject(error); }
        } } });
    vm.runInContext(source, context);
    return { activeCount: () => vm.runInContext('active.size', context), request(type, ...args) {
        return new Promise((resolve, reject) => {
            const request = ++sequence; jobs.set(request, { resolve, reject });
            context.self.onmessage({ data: { request, type, args } });
        });
    } };
}
const meta = () => ({ id: crypto.randomUUID(), name: '并发暂存.bin', size: 32768, mime: 'application/octet-stream' });
async function committed(worker, value, byte = 7) {
    const prefix = Buffer.alloc(16384, byte);
    await worker.request('start', value); await worker.request('append', value.id, asBuffer(prefix));
    await worker.request('park', value.id, digest(prefix)); return prefix;
}
function snapshot(storage, id) {
    return new Map([id + '.part', id + '.json'].map(name => [name, Buffer.from(storage.files.get(name).bytes)]));
}
function preserved(storage, expected) {
    for (const [name, bytes] of expected) {
        assert.equal(storage.files.has(name), true, 'a stale retirement must preserve ' + name);
        assert.deepEqual(storage.files.get(name).bytes, bytes, 'body and metadata must remain byte-identical');
    }
}

test('orphan TTL cleanup must not erase a same-ID prefix published after its stale snapshot', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), b = worker(storage, 'b'), value = meta();
    storage.files.set(value.id + '.part', { bytes: Buffer.alloc(0), modified: Date.now() - 25 * 3600000, locked: false, writing: false });
    const entered = deferred(), release = deferred(); let blocked = false;
    storage.afterSnapshot = async (owner, name) => {
        if (!blocked && owner === 'b' && name === value.id + '.part') { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = b.request('list'); await entered.promise;
    const prefix = await committed(a, value), expected = snapshot(storage, value.id);
    release.resolve(); await pending;
    preserved(storage, expected);
    const restored = await a.request('resume', value.id, value);
    assert.equal(restored.meta.offset, prefix.length); assert.equal(restored.meta.prefixSha256, digest(prefix));
    assert.deepEqual(Buffer.from(await restored.snapshot.arrayBuffer()), prefix);
    await a.request('park', value.id, digest(prefix));
});

for (const gap of ['part', 'json']) test('manual retirement excludes competing mutation through the ' + gap + ' unlink gap', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), b = worker(storage, 'b'), value = meta();
    await committed(a, value, 1); const original = snapshot(storage, value.id);
    const entered = deferred(), release = deferred(); let blocked = false;
    storage.beforeRemove = async (owner, name) => {
        if (!blocked && owner === 'b' && name === value.id + '.' + gap) { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = b.request('erase', value.id).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await assert.rejects(a.request('erase', value.id), error => error.name === 'NoModificationAllowedError');
    await assert.rejects(a.request('start', value), /已有同名断点/);
    if (gap === 'part') { preserved(storage, original); assert.deepEqual(storage.erased, []); }
    else {
        assert.equal(storage.files.has(value.id + '.part'), false);
        assert.deepEqual(storage.files.get(value.id + '.json').bytes, original.get(value.id + '.json'));
        assert.deepEqual(storage.erased, [['b', value.id + '.part']]);
    }
    release.resolve(); assert.equal((await pending).value, true);
    const prefix = await committed(a, value, 9), expected = snapshot(storage, value.id);
    preserved(storage, expected); assert.equal(digest(storage.files.get(value.id + '.part').bytes), digest(prefix));
    assert.deepEqual(storage.erased, [['b', value.id + '.part'], ['b', value.id + '.json']]);
    const restored = await b.request('resume', value.id, value);
    assert.equal(restored.meta.prefixSha256, digest(prefix)); assert.equal(restored.meta.offset, prefix.length);
    assert.deepEqual(Buffer.from(await restored.snapshot.arrayBuffer()), prefix);
    await b.request('park', value.id, digest(prefix));
});

for (const phase of ['corrupt', 'expired']) test('automatic ' + phase + ' retirement rechecks a replacement under the mutation lock', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), b = worker(storage, 'b'), value = meta();
    await committed(a, value, 2);
    const old = Date.now() - 25 * 3600000;
    const header = storage.files.get(value.id + '.json'); header.modified = old;
    if (phase === 'corrupt') header.bytes = Buffer.from('{invalid');
    else { const data = JSON.parse(header.bytes); data.createdAt = old; header.bytes = Buffer.from(JSON.stringify(data)); }
    storage.files.get(value.id + '.part').modified = old;
    const entered = deferred(), release = deferred(); let blocked = false;
    storage.afterSnapshot = async (owner, name) => {
        if (!blocked && owner === 'b' && name === value.id + '.part') { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = b.request('list'); await entered.promise;
    await a.request('erase', value.id); const prefix = await committed(a, value, 8), expected = snapshot(storage, value.id);
    const removed = storage.erased.length; release.resolve(); await pending;
    preserved(storage, expected); assert.equal(storage.erased.length, removed, 'stale cleanup must not unlink the replacement');
    assert.equal(digest(storage.files.get(value.id + '.part').bytes), digest(prefix));
});

test('a busy mutation lock cannot close this Worker own active writer and other active files can continue', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), b = worker(storage, 'b'), value = meta(), other = meta();
    await committed(b, value, 5); await a.request('start', other);
    const entered = deferred(), release = deferred(); let blocked = false;
    storage.beforeRemove = async (owner, name) => {
        if (!blocked && owner === 'b' && name === value.id + '.part') { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = b.request('erase', value.id); await entered.promise;
    await assert.rejects(a.request('erase', other.id), error => error.name === 'NoModificationAllowedError');
    assert.equal(a.activeCount(), 1); assert.equal(storage.files.get(other.id + '.part').locked, true);
    const prefix = Buffer.alloc(16384, 6); await a.request('append', other.id, asBuffer(prefix));
    await a.request('park', other.id, digest(prefix)); const expected = snapshot(storage, other.id);
    release.resolve(); await pending; preserved(storage, expected);
});

for (const operation of ['start', 'resume']) test('a mutation-lock close failure after ' + operation + ' drops adopted ownership without claiming physical unlock', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), value = meta();
    if (operation === 'resume') await committed(a, value, 4);
    storage.failClose = 'mutation-lock';
    await assert.rejects(a.request(operation, operation === 'start' ? value : value.id, value), error => error.name === 'NotAllowedError');
    assert.equal(a.activeCount(), 0); assert.equal(storage.files.get(value.id + '.part').locked, false);
    assert.equal(storage.files.get('mutation-lock').locked, true, 'native close failed, so the physical mutation lock is retained');
    assert.deepEqual(storage.erased, []);
    storage.files.get('mutation-lock').locked = false; // fixture teardown, not product release
});

test('a failed publication keeps its primary error when mutation-lock close also fails', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), value = meta();
    storage.failHeaderCreate = value.id + '.json'; storage.failClose = 'mutation-lock';
    await assert.rejects(a.request('start', value), error => error.name === 'QuotaExceededError');
    assert.equal(a.activeCount(), 0); assert.equal(storage.files.get(value.id + '.part').locked, false);
    assert.equal(storage.files.get('mutation-lock').locked, true); assert.deepEqual(storage.erased, []);
    assert.equal(storage.files.get(value.id + '.part').bytes.length, 0);
    storage.files.get('mutation-lock').locked = false; // fixture teardown only
});

test('the stable control file remains empty and invisible after actual expired orphan cleanup', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), value = meta();
    storage.files.set(value.id + '.part', { bytes: Buffer.alloc(0), modified: Date.now() - 25 * 3600000, locked: false, writing: false });
    assert.equal((await a.request('list')).length, 0);
    assert.deepEqual([...storage.files.keys()], ['mutation-lock']);
    assert.equal(storage.files.get('mutation-lock').bytes.length, 0); assert.equal(storage.files.get('mutation-lock').locked, false);
});

test('automatic retirement cannot validate stale files while another Worker can still commit and release their writer', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), b = worker(storage, 'b'), value = meta();
    const prefix = Buffer.alloc(16384, 0x69), sha256 = digest(prefix);
    await a.request('start', value); await a.request('append', value.id, asBuffer(prefix));
    await a.request('checkpoint', value.id, sha256, true);
    const old = Date.now() - 25 * 3600000, header = storage.files.get(value.id + '.json');
    const expired = JSON.parse(header.bytes); expired.createdAt = old;
    header.bytes = Buffer.from(JSON.stringify(expired)); header.modified = old;
    storage.files.get(value.id + '.part').modified = old;
    const entered = deferred(), release = deferred(); let blocked = false;
    storage.beforeRemove = async (owner, name) => {
        if (!blocked && owner === 'b' && name === value.id + '.part') { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = b.request('list');
    // Before the fix the stale decision reaches unlink while A still owns the
    // writer. Afterwards the native exclusive-read precondition refuses it.
    await Promise.race([entered.promise, pending]);
    await a.request('park', value.id, sha256); const expected = snapshot(storage, value.id);
    release.resolve(); await pending;
    preserved(storage, expected); assert.deepEqual(storage.erased, []);
    const restored = await b.request('resume', value.id, value);
    assert.equal(restored.meta.prefixSha256, sha256); assert.deepEqual(Buffer.from(await restored.snapshot.arrayBuffer()), prefix);
    await b.request('park', value.id, sha256);
});

test('a native data-lock close failure prevents automatic unlink and leaves the expired record manageable', async () => {
    const storage = filesystem(), a = worker(storage, 'a'), value = meta();
    await committed(a, value, 4);
    const old = Date.now() - 25 * 3600000, header = storage.files.get(value.id + '.json');
    const expired = JSON.parse(header.bytes); expired.createdAt = old;
    header.bytes = Buffer.from(JSON.stringify(expired)); header.modified = old;
    storage.files.get(value.id + '.part').modified = old;
    const expected = snapshot(storage, value.id); storage.failClose = value.id + '.part';
    const result = await a.request('list'); assert.equal(result[0].phase, 'expired');
    preserved(storage, expected); assert.deepEqual(storage.erased, []);
    assert.equal(storage.files.get(value.id + '.part').locked, true, 'a throwing native close is not a physical-release claim');
    assert.equal(storage.files.get('mutation-lock').locked, false);
    storage.files.get(value.id + '.part').locked = false; // fixture teardown only
});
