'use strict';
// Exercise the shipped UI class rather than copying it. Deferred operations model
// late lock/storage completions; real-store cases also read/hash actual chunks.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const uiSource = fs.readFileSync('client/scripts/ui.js', 'utf8');
const start = uiSource.indexOf('class SendQueueUI {'), end = uiSource.indexOf('class Zeydrop {', start);
assert.ok(start >= 0 && end > start, 'the actual queue controller must be present');
const queueSource = uiSource.slice(start, end);
const storeSource = fs.readFileSync('client/scripts/send-queue-store.js', 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const hash = value => createHash('sha256').update(value).digest('hex');
const error = name => Object.assign(Error(name), { name });
function manifest(name = 'file.bin', content = 'payload') {
    return { version: 1, revision: webcrypto.randomUUID(), files: [{ entryId: webcrypto.randomUUID(), name, size: content.length, mime: 'application/octet-stream', lastModified: 0, sha256: hash(content) }] };
}
function fakeStore(snapshot = null) {
    return { supported: true, storageKey: 'zeydrop-send-queue-v1', load: async () => snapshot,
        save: async () => snapshot, reselect: async (revision, files) => ({ snapshot, files }),
        removeEntry: async () => null, clear: async () => true, clearCorrupt: async () => true };
}
async function rig({ store = fakeStore(), actual = false, beforeUI, beforeDOM } = {}) {
    const elements = new Map(), listeners = new Map(), events = new Map(), values = new Map();
    const $ = id => {
        if (!elements.has(id)) {
            const element = { hidden: false, disabled: false, checked: false, files: [], value: '', children: [],
                replaceChildren() { this.children = []; }, append(item) { this.children.push(item); }, click() {} };
            // A real file input drops its FileList when code clears its value.
            if (id === 'sendQueueFiles') {
                let value = '';
                Object.defineProperty(element, 'value', { get: () => value, set(next) { value = next; if (next === '') this.files = []; } });
            }
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const locks = { tail: Promise.resolve(), request(name, options, fn) {
        const job = this.tail.then(() => { if (options.signal?.aborted) throw error('AbortError'); return fn(); });
        this.tail = job.catch(() => {}); return job;
    } };
    const window = { localStorage: storage, ZeydropHash: { create: () => createHash('sha256') },
        addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); } };
    const Events = { on(name, listener) { if (!events.has(name)) events.set(name, []); events.get(name).push(listener); } };
    const context = vm.createContext({ window, Events, $, navigator: { locks }, crypto: webcrypto, TextEncoder, Uint8Array, Date,
        AbortController, document: { createElement: () => ({}) }, fmt: size => size + ' B' });
    if (actual) { vm.runInContext(storeSource, context); store = window.ZeydropSendQueue; }
    else window.ZeydropSendQueue = store;
    if (beforeUI) await beforeUI(store);
    if (beforeDOM) beforeDOM($);
    vm.runInContext(queueSource + '\nthis.QueueUI = SendQueueUI;', context);
    const sent = [], peer = { _filesQueue: [], _canSend: () => true, sendFiles(files) { sent.push(files); this._outgoing = {}; return true; } };
    const ui = new context.QueueUI({ peers: new Map([['peer', peer]]) });
    const emit = (name, detail) => { for (const listener of events.get(name) || []) listener({ detail }); };
    const windowEvent = (name, event = {}) => { for (const listener of listeners.get(name) || []) listener(event); };
    return { ui, store, $, sent, peer, values, emit, windowEvent, ready: flush };
}
function delayedFile(content = 'private', name = 'private.txt') {
    const bytes = new TextEncoder().encode(content), started = deferred(), release = deferred();
    return { started, release, file: { name, size: bytes.length, type: 'text/plain', lastModified: 0,
        slice(start, end) { return { async arrayBuffer() { started.resolve(); await release.promise; return bytes.slice(start, end).buffer; } }; } } };
}

test('constructor rejects browser-restored consent and file input state without discarding saved metadata', async () => {
    const saved = manifest(), restoredFile = {}, store = fakeStore(saved);
    const h = await rig({ store, beforeDOM($) {
        $('rememberSendQueue').checked = true;
        $('sendQueueFiles').value = 'C:\\fakepath\\restored.bin'; $('sendQueueFiles').files = [restoredFile];
    } });
    await h.ready();
    assert.equal(h.$('rememberSendQueue').checked, false);
    assert.equal(h.$('sendQueueFiles').value, ''); assert.equal(h.$('sendQueueFiles').files.length, 0);
    assert.equal(h.ui.snapshot, saved); assert.equal(h.ui.boundFiles, null);
    assert.equal(h.ui.bindings.get(restoredFile), undefined); assert.equal(h.$('sendStoredQueue').disabled, true);
    assert.equal(h.sent.length, 0);
});

test('BFCache restoration resets transient permission and File bindings while ordinary pageshow preserves the current choice', async () => {
    const saved = manifest(), file = {}, store = fakeStore(saved), h = await rig({ store }); await h.ready();
    h.ui.mode = 'reselect'; await h.ui.choose([file]); h.$('rememberSendQueue').checked = true;
    h.$('sendQueueFiles').value = 'C:\\fakepath\\current.bin'; h.$('sendQueueFiles').files = [file];
    const sequence = h.ui.sequence;
    h.windowEvent('pageshow', { persisted: false }); await h.ready();
    assert.equal(h.$('rememberSendQueue').checked, true); assert.equal(h.ui.sequence, sequence);
    assert.equal(h.$('sendQueueFiles').value, 'C:\\fakepath\\current.bin');
    assert.equal(h.ui.boundFiles[0], file); assert.equal(h.ui.bindings.get(file), saved.files[0].entryId);

    h.windowEvent('pagehide', { persisted: true });
    assert.equal(h.$('rememberSendQueue').checked, false); assert.equal(h.$('sendQueueFiles').value, '');
    assert.equal(h.ui.boundFiles, null); assert.equal(h.ui.bindings.get(file), undefined);
    // Firefox may restore dynamic form state after pagehide but before pageshow.
    h.$('rememberSendQueue').checked = true;
    h.$('sendQueueFiles').value = 'C:\\fakepath\\restored.bin'; h.$('sendQueueFiles').files = [file];
    h.windowEvent('pageshow', { persisted: true }); await h.ready();
    assert.equal(h.$('rememberSendQueue').checked, false);
    assert.equal(h.$('sendQueueFiles').value, ''); assert.equal(h.$('sendQueueFiles').files.length, 0);
    assert.equal(h.ui.snapshot, saved); assert.equal(h.ui.boundFiles, null); assert.equal(h.ui.bindings.get(file), undefined);
    assert.equal(h.$('sendStoredQueue').disabled, true); assert.equal(h.sent.length, 0);
});

test('withdrawing metadata consent during hashing aborts before any manifest is stored', async () => {
    const h = await rig({ actual: true }); await h.ready();
    const original = delayedFile(); h.$('rememberSendQueue').checked = true; h.ui.mode = 'save';
    const choosing = h.ui.choose([original.file]); await original.started.promise;
    h.$('rememberSendQueue').checked = false; h.$('rememberSendQueue').onchange();
    assert.equal(h.ui.hashController.signal.aborted, true);
    original.release.resolve(); await choosing;
    assert.equal(await h.store.load(), null); assert.equal(h.ui.boundFiles, null); assert.equal(h.sent.length, 0);
});

test('stopping file verification cannot persist or authorize the pending files', async () => {
    const h = await rig({ actual: true }); await h.ready();
    const original = delayedFile(); h.$('rememberSendQueue').checked = true; h.ui.mode = 'save';
    const choosing = h.ui.choose([original.file]); await original.started.promise;
    h.$('cancelQueueHash').onclick(); original.release.resolve(); await choosing;
    assert.equal(await h.store.load(), null); assert.equal(h.ui.boundFiles, null); assert.equal(h.sent.length, 0);
});

test('a storage update cancels reselect hashing and cannot restore stale File bindings', async () => {
    const original = new File(['private'], 'private.txt', { type: 'text/plain', lastModified: 0 });
    let saved; const h = await rig({ actual: true, beforeUI: async store => { saved = await store.save([original], { optIn: true, expectedRevision: null }); } });
    await h.ready(); const late = delayedFile(); h.ui.mode = 'reselect';
    const choosing = h.ui.choose([late.file]); await late.started.promise;
    await h.store.clear({ expectedRevision: saved.revision }); h.windowEvent('storage', { key: h.store.storageKey });
    await h.ready(); late.release.resolve(); await choosing;
    assert.equal(h.ui.snapshot, null); assert.equal(h.ui.boundFiles, null); assert.equal(h.ui.bindings.get(late.file), undefined);
    assert.equal(h.sent.length, 0); assert.equal(h.ui.busy, false);
});

test('an older metadata refresh cannot overwrite a newly saved and bound selection', async () => {
    const late = deferred(), saved = manifest(), file = {}, store = fakeStore(saved);
    store.load = () => late.promise;
    const h = await rig({ store }); h.ui.mode = 'save'; h.$('rememberSendQueue').checked = true;
    await h.ui.choose([file]); late.resolve(null); await h.ready();
    assert.equal(h.ui.snapshot, saved); assert.equal(h.ui.boundFiles[0], file); assert.equal(h.ui.bindings.get(file), saved.files[0].entryId);
});

test('a late completion update cannot replace metadata loaded after a cross-tab change', async () => {
    const old = manifest('old.bin'), fresh = manifest('fresh.bin'), late = deferred(), store = fakeStore(old), file = {};
    store.removeEntry = () => late.promise;
    const h = await rig({ store }); await h.ready(); h.ui.bindings.set(file, old.files[0].entryId);
    const completing = h.ui.completed(file, old.files[0].sha256);
    store.load = async () => fresh; h.windowEvent('storage', { key: store.storageKey }); await h.ready();
    late.resolve(null); await completing;
    assert.equal(h.ui.snapshot, fresh); assert.equal(h.ui.boundFiles, null); assert.equal(h.ui.bindings.get(file), undefined);
});

test('a failed stale completion cannot invalidate a newly reselected original', async () => {
    const old = manifest('old.bin'), fresh = manifest('fresh.bin'), late = deferred(), store = fakeStore(old), oldFile = {}, freshFile = {};
    store.removeEntry = () => late.promise;
    const h = await rig({ store }); await h.ready(); h.ui.bindings.set(oldFile, old.files[0].entryId);
    const completing = h.ui.completed(oldFile, old.files[0].sha256);
    store.load = async () => fresh; store.reselect = async () => ({ files: [freshFile], snapshot: fresh });
    h.windowEvent('storage', { key: store.storageKey }); await h.ready(); h.ui.mode = 'reselect'; await h.ui.choose([freshFile]);
    late.reject(error('QueueConflictError')); await completing;
    assert.equal(h.ui.snapshot, fresh); assert.equal(h.ui.boundFiles[0], freshFile);
    assert.equal(h.ui.bindings.get(freshFile), fresh.files[0].entryId);
});

test('clearing revokes bindings immediately and a late result cannot erase a newer tab snapshot', async () => {
    const old = manifest('old.bin'), fresh = manifest('fresh.bin'), late = deferred(), store = fakeStore(old), file = {};
    store.clear = () => late.promise;
    const h = await rig({ store }); await h.ready(); h.ui.boundFiles = [file]; h.ui.bindings.set(file, old.files[0].entryId);
    const clearing = h.ui.clear(); assert.equal(h.ui.busy, true); assert.equal(h.ui.boundFiles, null); assert.equal(h.ui.bindings.get(file), undefined);
    store.load = async () => fresh; h.windowEvent('storage', { key: store.storageKey }); await h.ready(); late.resolve(true); await clearing;
    assert.equal(h.ui.snapshot, fresh); assert.equal(h.ui.boundFiles, null); assert.equal(h.sent.length, 0);
});

test('a send preflight returning after a cross-tab change neither sends nor overwrites the new snapshot', async () => {
    const old = manifest('old.bin'), fresh = manifest('fresh.bin'), late = deferred(), store = fakeStore(old), file = {};
    const h = await rig({ store }); await h.ready(); h.ui.boundFiles = [file]; h.ui.bindings.set(file, old.files[0].entryId);
    store.load = () => late.promise; const sending = h.ui.send();
    store.load = async () => fresh; h.windowEvent('storage', { key: store.storageKey }); await h.ready(); late.resolve(old); await sending;
    assert.equal(h.ui.snapshot, fresh); assert.equal(h.ui.boundFiles, null); assert.equal(h.sent.length, 0);
});

test('stored metadata and verified file selection do not send until manual send and fresh peer authorization', async () => {
    const saved = manifest(), file = {}, store = fakeStore(saved), h = await rig({ store }); await h.ready();
    h.ui.mode = 'reselect'; await h.ui.choose([file]); assert.equal(h.sent.length, 0);
    h.peer._canSend = () => false; await h.ui.send(); assert.equal(h.sent.length, 0);
    h.peer._canSend = () => true; await h.ui.send(); assert.equal(h.sent.length, 1); assert.equal(h.sent[0][0], file); assert.equal(h.ui.boundFiles, null);
});

test('only matching final SHA-256 completion removes a bound saved entry', async () => {
    const saved = manifest(), file = {}, store = fakeStore(saved), removed = [];
    store.removeEntry = async (entryId, options) => { removed.push({ entryId, revision: options.expectedRevision }); return null; };
    const h = await rig({ store }); await h.ready(); h.ui.bindings.set(file, saved.files[0].entryId);
    await assert.rejects(h.ui.completed(file, hash('different bytes')), { name: 'QueueFileMismatchError' });
    assert.equal(removed.length, 0); assert.equal(h.ui.snapshot, saved);
    h.emit('send-file-complete', { file, sha256: saved.files[0].sha256 }); await h.ui.completionChain;
    assert.deepEqual(removed, [{ entryId: saved.files[0].entryId, revision: saved.revision }]);
    assert.equal(h.ui.snapshot, null); assert.equal(h.ui.bindings.get(file), undefined);
});
