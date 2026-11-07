'use strict';
// The actual local-storage controller, with only page events/timers/storage at
// the boundary controlled. This establishes lifecycle logic, not native BFCache.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('client/scripts/ui.js', 'utf8');
const start = source.indexOf('const localRecovery = window.ZeydropRecovery;');
const end = source.indexOf('\nconst zeydrop =', start);
assert.ok(start >= 0 && end > start);
const controller = source.slice(start, end);
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(options = {}) {
    const events = new Map(), timers = new Map(), elements = new Map(), notices = [];
    let sequence = 0, lists = 0, probes = 0, hashes = 0, urls = 0;
    class Element {
        constructor() { this.hidden = true; this.children = []; this.checked = false; }
        replaceChildren() { this.children = []; }
        append(child) { this.children.push(child); }
    }
    const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const window = { ZeydropRecovery: options.missing ? undefined : {
        supported: options.supported !== false,
        async available() { probes++; return options.available !== false; },
        async list() { lists++; if (options.rejectList) throw Error('synthetic local list failure'); return []; }
    }, ZeydropFileHash: { hash() { hashes++; throw Error('restoring cleanup must not restore verification'); } },
        addEventListener(type, callback) { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); }
    };
    const context = vm.createContext({ window, $, document: { createElement: () => new Element() },
        Events: { fire(type, detail) { notices.push({ type, detail }); } },
        setInterval(fn, ms) { const id = sequence++; timers.set(id, { fn, ms }); return id; },
        clearInterval(id) { timers.delete(id); }, clearTimeout() {},
        URL: { createObjectURL() { urls++; throw Error('cleanup cannot create a file URL'); }, revokeObjectURL() {} }
    });
    vm.runInContext(controller, context); await turn();
    const dispatch = async (type, persisted) => {
        for (const callback of events.get(type) || []) callback({ persisted });
        await turn();
    };
    return { $, timers, events, notices, dispatch,
        get lists() { return lists; }, get probes() { return probes; },
        get hashes() { return hashes; }, get urls() { return urls; } };
}

test('a restored cached page immediately resumes one expiry sweep without reopening or reauthorizing files', async () => {
    const h = await fixture();
    assert.equal(h.lists, 1); assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, 3600000);
    assert.equal(h.$('localStorageRecords').hidden, true);
    await h.dispatch('pageshow', false);
    assert.equal(h.lists, 1); assert.equal(h.timers.size, 1, 'ordinary initial pageshow cannot duplicate startup work');
    await h.dispatch('pagehide', true);
    assert.equal(h.timers.size, 0);
    await h.dispatch('pageshow', true);
    assert.equal(h.lists, 2, 'restoration must inspect records that may have expired while cached');
    assert.equal(h.timers.size, 1);
    await h.dispatch('pageshow', true);
    assert.equal(h.lists, 2); assert.equal(h.timers.size, 1, 'duplicate restore events cannot add timers or cleanup jobs');
    const interval = [...h.timers.values()][0]; interval.fn(); await turn();
    assert.equal(h.lists, 3);
    assert.equal(h.$('localStorageRecords').hidden, true);
    assert.deepEqual(h.$('localStorageRecords').children, []);
    assert.equal(h.hashes, 0); assert.equal(h.urls, 0); assert.deepEqual(h.notices, []);
    await h.dispatch('pagehide', false); assert.equal(h.timers.size, 0);
});

test('repeated hide/restore cycles never multiply sweep timers, including a zero-valued first timer id', async () => {
    const h = await fixture();
    assert.equal(h.timers.has(0), true);
    for (let count = 0; count < 5; count++) {
        await h.dispatch('pagehide', true); await h.dispatch('pagehide', true);
        assert.equal(h.timers.size, 0);
        await h.dispatch('pageshow', true); await h.dispatch('pageshow', true);
        assert.equal(h.timers.size, 1); assert.equal(h.lists, count + 2);
    }
    await h.dispatch('pagehide', false); assert.equal(h.timers.size, 0);
});

test('storage-list failures are consumed at startup, periodic cleanup and cached-page restoration', async () => {
    const h = await fixture({ rejectList: true });
    assert.equal(h.lists, 1); assert.equal(h.timers.size, 1);
    [...h.timers.values()][0].fn(); await turn();
    await h.dispatch('pagehide', true); await h.dispatch('pageshow', true);
    assert.equal(h.lists, 3); assert.equal(h.timers.size, 1);
    assert.deepEqual(h.notices, []); assert.equal(h.hashes, 0); assert.equal(h.urls, 0);
    await h.dispatch('pagehide', false);
});

test('missing, unsupported or unavailable storage never starts cleanup or restoration listeners', async () => {
    for (const options of [{ missing: true }, { supported: false }, { available: false }]) {
        const h = await fixture(options);
        assert.equal(h.lists, 0); assert.equal(h.timers.size, 0);
        assert.equal(h.events.size, 0); assert.equal(h.probes, options.available === false ? 1 : 0);
        await h.dispatch('pagehide', true); await h.dispatch('pageshow', true);
        assert.equal(h.lists, 0); assert.equal(h.timers.size, 0);
    }
});
