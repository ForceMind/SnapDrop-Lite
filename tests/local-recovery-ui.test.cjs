'use strict';
// Execute the shipped local-storage controller. Completed files must pass the
// bounded file-hash bridge before a download URL becomes available.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createHash } = require('node:crypto');
const source = fs.readFileSync('client/scripts/ui.js', 'utf8');
const start = source.indexOf('const localRecovery = window.ZeydropRecovery;'), end = source.indexOf('\nconst zeydrop =', start);
assert.ok(start >= 0 && end > start, 'the shipped local recovery controller must be present');
const controller = source.slice(start, end), turn = () => new Promise(resolve => setImmediate(resolve));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture({ size, sha256, delayedErase = false } = {}) {
    const bytes = Buffer.from('已完成的本机暂存'), blob = new Blob([bytes]);
    const meta = { name: '中文文件.bin', size: size ?? bytes.length, completeSha256: checksum(bytes) };
    const job = gate(), eraseGate = gate(), calls = [], events = [], urls = [], revoked = [], timers = [], signals = [], jobs = [];
    const listeners = new Map(), unrelated = new AbortController();
    let erased = 0, present = true, globalCancellations = 0, completedReads = 0;
    class Element {
        constructor(tag = 'section') { this.tagName = tag; this.children = []; this.hidden = true; this.disabled = false; this.listeners = new Map(); }
        append(child) { child.parent = this; this.children.push(child); }
        replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
        addEventListener(name, fn) { this.listeners.set(name, fn); }
    }
    const elements = new Map(), $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const window = {
        ZeydropRecovery: { supported: true, available: async () => true,
            list: async () => present ? [{ id: 'local-file', phase: 'complete', name: meta.name, offset: bytes.length, size: meta.size }] : [],
            completed: async id => { completedReads++; assert.equal(id, 'local-file'); return { blob, meta }; },
            erase: async () => { erased++; if (delayedErase) await eraseGate.promise; present = false; } },
        ZeydropFileHash: {
            hash: async (value, options = {}) => { const pending = jobs.length ? gate() : job; jobs.push(pending); calls.push(value); signals.push(options.signal); return pending.promise; },
            cancelAll() { globalCancellations++; unrelated.abort(); }
        },
        ZeydropHash: { create() { throw Error('UI must not hash the file on its own main-thread loop'); } },
        addEventListener(name, fn) { listeners.set(name, fn); }
    };
    const context = vm.createContext({ window, $, Blob, AbortController, document: { createElement: tag => new Element(tag) },
        Events: { fire: (type, detail) => events.push({ type, detail }) }, fmt: value => value + ' B',
        URL: { createObjectURL: value => { assert.equal(value, blob); const url = 'blob:verified-' + urls.length; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url) },
        setInterval: () => 1, clearInterval() {},
        setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
        clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; } });
    vm.runInContext(controller, context); await turn();
    await $('localStorageManage').onclick();
    const row = $('localStorageRecords').children[0], load = row.children.find(child => child.tagName === 'button');
    return { bytes, blob, meta, job, calls, events, urls, revoked, timers, row, load, signals, unrelated, eraseGate,
        manage: $('localStorageManage'), records: $('localStorageRecords'), pagehide: () => listeners.get('pagehide')?.(),
        complete: (index = 0) => jobs[index].resolve({ bytes: bytes.length, sha256: sha256 ?? checksum(bytes), backend: 'worker' }),
        get erased() { return erased; }, get globalCancellations() { return globalCancellations; }, get completedReads() { return completedReads; } };
}

test('completed local files use the file-hash bridge before preserving the existing download lifecycle', async () => {
    const h = await fixture(), pending = h.load.onclick(); await turn();
    assert.deepEqual(h.calls, [h.blob]); assert.equal(h.load.disabled, true); assert.equal(h.urls.length, 0);
    h.complete(); await pending;
    const link = h.row.children.find(child => child.tagName === 'a');
    assert.ok(link); assert.equal(link.download, h.meta.name); assert.equal(link.href, h.urls[0]);
    assert.equal(h.row.children.includes(h.load), false); assert.equal(h.erased, 0, 'preparing a download does not delete local data');
    assert.equal(h.revoked.length, 0); link.listeners.get('click')();
    assert.equal(h.timers[0].ms, 60000); h.timers[0].fn(); assert.deepEqual(h.revoked, [link.href]);
});

test('wrong byte counts, file metadata size, and malformed or mismatched hashes never expose a download', async () => {
    for (const kind of ['bytes', 'metadata', 'malformed', 'mismatch']) {
        const h = await fixture(kind === 'metadata' ? { size: 999 } : {}), pending = h.load.onclick();
        await turn();
        h.job.resolve({ bytes: kind === 'bytes' ? h.bytes.length - 1 : h.bytes.length,
            sha256: kind === 'malformed' ? 'invalid-digest' : kind === 'mismatch' ? 'f'.repeat(64) : checksum(h.bytes), backend: 'worker' });
        await pending;
        assert.equal(h.calls.length, 1); assert.equal(h.urls.length, 0); assert.equal(h.load.disabled, false);
        assert.equal(h.erased, 0, 'failed verification must not silently erase the record');
        assert.match(h.events.at(-1).detail, /本机文件校验失败/);
    }
});

test('hash-worker failure re-enables local verification without releasing or deleting the stored file', async () => {
    const h = await fixture(), pending = h.load.onclick(); await turn();
    h.job.reject(Object.assign(Error('文件校验进程已中断，请重试'), { name: 'HashWorkerError' })); await pending;
    assert.equal(h.urls.length, 0); assert.equal(h.load.disabled, false); assert.equal(h.erased, 0);
    assert.match(h.events.at(-1).detail, /校验进程已中断/);
});

test('replacing a render cancels only its own verification and ignores a late result for the detached row', async () => {
    const h = await fixture(), pending = h.load.onclick(); await turn();
    await h.manage.onclick(); await h.manage.onclick();
    assert.equal(h.signals[0]?.aborted, true); assert.notEqual(h.records.children[0], h.row);
    h.complete(); await pending;
    assert.equal(h.urls.length, 0); assert.equal(h.row.children.some(child => child.tagName === 'a'), false);
    assert.equal(h.globalCancellations, 0); assert.equal(h.unrelated.signal.aborted, false);
    assert.equal(h.events.length, 0, 'stale completion must not show an error for a newer render');
});

test('delete revokes pending verification immediately rather than waiting for storage RPC completion', async () => {
    const h = await fixture({ delayedErase: true }), pending = h.load.onclick(); await turn();
    const del = h.row.children.find(child => child.textContent === '删除本机数据'), deleting = del.onclick();
    assert.equal(h.signals[0]?.aborted, true); h.complete(); await pending;
    assert.equal(h.urls.length, 0); assert.equal(h.row.children.some(child => child.tagName === 'a'), false);
    h.eraseGate.resolve(); await deleting;
    assert.equal(h.erased, 1); assert.equal(h.globalCancellations, 0); assert.equal(h.unrelated.signal.aborted, false);
});

test('render replacement preserves a clicked download grace period and immediately revokes only unclicked links', async () => {
    const h = await fixture(), pending = h.load.onclick(); await turn(); h.complete(); await pending;
    const link = h.row.children.find(child => child.tagName === 'a'); link.listeners.get('click')();
    await h.manage.onclick(); await h.manage.onclick();
    assert.deepEqual(h.revoked, []); assert.equal(h.timers[0].cleared, false, 'ordinary panel refresh must not interrupt download startup');
    const row = h.records.children[0], load = row.children.find(child => child.tagName === 'button');
    const next = load.onclick(); await turn(); h.complete(1); await next;
    assert.equal(h.urls.length, 2); await h.manage.onclick();
    assert.deepEqual(h.revoked, [h.urls[1]]); h.timers[0].fn();
    assert.deepEqual(h.revoked, [h.urls[1], h.urls[0]]); h.timers[0].fn();
    assert.deepEqual(h.revoked, [h.urls[1], h.urls[0]], 'an old timer cannot revoke a URL twice or touch a newer render');
    assert.equal(h.globalCancellations, 0);
});

test('an old clicked-link timer releases only its own URL while the replacement render remains usable', async () => {
    const h = await fixture(), first = h.load.onclick(); await turn(); h.complete(); await first;
    h.row.children.find(child => child.tagName === 'a').listeners.get('click')();
    await h.manage.onclick(); await h.manage.onclick();
    const row = h.records.children[0], load = row.children.find(child => child.tagName === 'button');
    const second = load.onclick(); await turn(); h.complete(1); await second;
    h.timers[0].fn(); assert.deepEqual(h.revoked, [h.urls[0]]);
    assert.equal(row.children.find(child => child.tagName === 'a').href, h.urls[1]);
    assert.equal(h.records.children[0], row, 'old cleanup must not retire the current panel');
    await h.manage.onclick(); assert.deepEqual(h.revoked, h.urls);
});

test('explicit deletion immediately releases clicked URLs from older renders as well as current unclicked links', async () => {
    const h = await fixture(), first = h.load.onclick(); await turn(); h.complete(); await first;
    h.row.children.find(child => child.tagName === 'a').listeners.get('click')();
    await h.manage.onclick(); await h.manage.onclick();
    const row = h.records.children[0], load = row.children.find(child => child.tagName === 'button');
    const second = load.onclick(); await turn(); h.complete(1); await second;
    await row.children.find(child => child.textContent === '删除本机数据').onclick();
    assert.deepEqual(h.revoked, h.urls); assert.equal(h.timers[0].cleared, true);
    h.timers[0].fn(); assert.deepEqual(h.revoked, h.urls);
});

test('repeated renders keep at most 20 download URLs without evicting a download inside its grace period', async () => {
    const h = await fixture();
    for (let index = 0; index < 20; index++) {
        const row = h.records.children[0], load = row.children.find(child => child.tagName === 'button');
        const pending = load.onclick(); await turn(); h.complete(index); await pending;
        row.children.find(child => child.tagName === 'a').listeners.get('click')();
        await h.manage.onclick(); await h.manage.onclick();
    }
    assert.equal(h.urls.length, 20); assert.equal(h.revoked.length, 0);
    const row = h.records.children[0], load = row.children.find(child => child.tagName === 'button');
    await load.onclick();
    assert.equal(h.urls.length, 20); assert.equal(h.revoked.length, 0, 'at capacity no active download may be silently evicted');
    assert.equal(h.calls.length, 20, 'known capacity exhaustion must not start another whole-file hash');
    assert.equal(h.completedReads, 20, 'known capacity exhaustion must not read another local file');
    assert.equal(load.disabled, false); assert.match(h.events.at(-1).detail, /20.*60.*重试/);
    h.timers[0].fn();
    const retried = load.onclick(); await turn(); h.complete(20); await retried;
    assert.equal(h.urls.length, 21); assert.deepEqual(h.revoked, [h.urls[0]]);
    assert.equal(h.urls.length - h.revoked.length, 20);
    h.pagehide(); assert.equal(new Set(h.revoked).size, 21); assert.equal(h.revoked.length, 21);
    assert.equal(h.globalCancellations, 0);
});

test('pagehide cancels pending row work and releases prepared downloads and their timers', async () => {
    const pending = await fixture(), verifying = pending.load.onclick(); await turn();
    pending.pagehide(); assert.equal(pending.signals[0]?.aborted, true);
    pending.complete(); await verifying; assert.equal(pending.urls.length, 0);
    const ready = await fixture(), preparing = ready.load.onclick(); await turn(); ready.complete(); await preparing;
    ready.row.children.find(child => child.tagName === 'a').listeners.get('click')();
    ready.pagehide(); assert.deepEqual(ready.revoked, ready.urls); assert.equal(ready.timers[0].cleared, true);
    ready.timers[0].fn(); assert.deepEqual(ready.revoked, ready.urls);
    assert.equal(pending.records.hidden, true); assert.equal(ready.records.hidden, true);
    assert.equal(pending.globalCancellations + ready.globalCancellations, 0);
});
