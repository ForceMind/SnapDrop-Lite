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

async function fixture({ size, sha256 } = {}) {
    const bytes = Buffer.from('已完成的本机暂存'), blob = new Blob([bytes]);
    const meta = { name: '中文文件.bin', size: size ?? bytes.length, completeSha256: checksum(bytes) };
    const job = gate(), calls = [], events = [], urls = [], revoked = [], timers = [];
    let erased = 0;
    class Element {
        constructor(tag = 'section') { this.tagName = tag; this.children = []; this.hidden = true; this.listeners = new Map(); }
        append(child) { child.parent = this; this.children.push(child); }
        replaceChildren() { this.children = []; }
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
        addEventListener(name, fn) { this.listeners.set(name, fn); }
    }
    const elements = new Map(), $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const window = {
        ZeydropRecovery: { supported: true, available: async () => true,
            list: async () => [{ id: 'local-file', phase: 'complete', name: meta.name, offset: bytes.length, size: meta.size }],
            completed: async id => { assert.equal(id, 'local-file'); return { blob, meta }; }, erase: async () => { erased++; } },
        ZeydropFileHash: { hash: async value => { calls.push(value); return job.promise; } },
        ZeydropHash: { create() { throw Error('UI must not hash the file on its own main-thread loop'); } },
        addEventListener() {}
    };
    const context = vm.createContext({ window, $, Blob, document: { createElement: tag => new Element(tag) },
        Events: { fire: (type, detail) => events.push({ type, detail }) }, fmt: value => value + ' B',
        URL: { createObjectURL: value => { assert.equal(value, blob); const url = 'blob:verified-' + urls.length; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url) },
        setInterval: () => 1, clearInterval() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
    vm.runInContext(controller, context); await turn();
    await $('localStorageManage').onclick();
    const row = $('localStorageRecords').children[0], load = row.children.find(child => child.tagName === 'button');
    return { bytes, blob, meta, job, calls, events, urls, revoked, timers, row, load,
        complete: () => job.resolve({ bytes: bytes.length, sha256: sha256 ?? checksum(bytes), backend: 'worker' }), get erased() { return erased; } };
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
