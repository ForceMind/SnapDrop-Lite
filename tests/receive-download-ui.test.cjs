'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('client/scripts/ui.js', 'utf8');
const controller = source.slice(source.indexOf('class ReceiveDialog extends Dialog'), source.indexOf('class PeersUI'));
function fixture() {
    const elements = new Map(), events = [], handlers = new Map(), page = [], urls = [], revoked = [], timers = [];
    const $ = id => { if (!elements.has(id)) elements.set(id, { listeners: [], addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture }); }, removeAttribute(name) { delete this[name]; } }); return elements.get(id); };
    let shown = 0, failURL = false;
    class Dialog { constructor() { $('download').addEventListener('click', () => this.hide()); } show() { shown++; } hide() {} }
    const context = vm.createContext({ Dialog, $, fmt: String, window: { addEventListener(type, fn) { page.push({ type, fn }); } },
        Events: { on: (type, fn) => handlers.set(type, fn), fire: (type, detail) => events.push({ type, detail }) },
        URL: { createObjectURL(blob) { if (failURL) throw Error('allocation failed'); const url = 'blob:file-' + urls.length; urls.push({ url, blob }); return url; }, revokeObjectURL: url => revoked.push(url) },
        setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length; }, clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; } });
    vm.runInContext(controller + '\nglobalThis.dialog = new ReceiveDialog();', context);
    const dialog = context.dialog, link = $('download');
    function click() { const e = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
        for (const listener of [...link.listeners].sort((a, b) => Number(!!b.capture) - Number(!!a.capture))) { listener.fn(e); if (e.stopped) break; } return e; }
    function run(ms) { for (const timer of [...timers]) if (!timer.cleared && timer.ms === ms) { timer.cleared = true; timer.fn(); } }
    function receive(id, locallyStored = true) { const file = { id, sender: 'peer', name: id, size: 1, sha256: 'a'.repeat(64), locallyStored, blob: { id }, releases: 0, release() { this.releases++; } };
        handlers.get('file-received')({ detail: file }); return file; }
    return { dialog, link, receive, click, run, urls, revoked, events, timers, page, get shown() { return shown; }, failURL() { failURL = true; } };
}
test('dismissing locally stored files allocates no URL and never deletes their source', () => {
    const h = fixture(), file = h.receive('first'); h.dialog.hide();
    assert.equal(h.urls.length, 0); assert.equal(file.releases, 0);
    assert.equal(h.page.filter(x => x.type === 'pagehide').length, 1);
});
test('save keeps the clicked URL stable until the browser default action, then retires it after a bounded grace', () => {
    const h = fixture(), first = h.receive('first'); h.receive('second');
    const click = h.click(); assert.equal(click.prevented, false); assert.equal(click.stopped, true);
    assert.equal(h.link.href, h.urls[0].url); assert.equal(h.dialog.active.id, 'first');
    h.run(0); assert.equal(h.dialog.active.id, 'second'); assert.equal(h.link.href, '#');
    assert.equal(first.releases, 0); assert.equal(h.revoked.length, 0);
    h.run(60000); assert.deepEqual(h.revoked, [h.urls[0].url]);
});
test('rapid duplicate clicks do not allocate or download the same local file twice', () => {
    const h = fixture(); h.receive('first'); h.click();
    assert.equal(h.click().prevented, true); assert.equal(h.urls.length, 1);
    h.run(0); assert.equal(h.events.filter(x => x.type === 'file-saved').length, 1);
});
test('twenty pending downloads refuse new allocation without dropping live URLs, then capacity recovers', () => {
    const h = fixture();
    for (let i = 0; i < 20; i++) { h.receive(String(i)); assert.equal(h.click().prevented, false); h.run(0); }
    h.receive('waiting'); assert.equal(h.click().prevented, true); assert.equal(h.urls.length, 20); assert.equal(h.revoked.length, 0);
    assert.equal(h.dialog.active.id, 'waiting'); assert.match(h.events.at(-1).detail, /60/);
    h.run(60000); assert.equal(h.revoked.length, 20);
    assert.equal(h.click().prevented, false); assert.equal(h.urls.length, 21);
});
test('page exit releases every local URL and timer; cached-page return can save the still-visible file again', () => {
    const h = fixture(); h.receive('first'); h.click();
    h.page.find(x => x.type === 'pagehide').fn({ persisted: true });
    assert.deepEqual(h.revoked, [h.urls[0].url]); assert.equal(h.link.href, '#');
    assert.ok(h.timers.every(x => x.cleared));
    assert.equal(h.click().prevented, false); assert.equal(h.urls.length, 2);
    h.run(0); h.run(60000); assert.equal(h.revoked.length, 2);
});
test('URL allocation failure keeps a local file available for retry without closing or releasing it', () => {
    const h = fixture(), file = h.receive('first'); h.failURL();
    assert.equal(h.click().prevented, true); assert.equal(h.dialog.active.id, 'first');
    assert.equal(file.releases, 0); assert.equal(h.link.href, '#'); assert.ok(h.events.some(x => x.type === 'notify-user'));
});
test('ordinary in-memory files retain their existing short URL grace and release their sink exactly once', () => {
    const h = fixture(), file = h.receive('first', false); h.receive('second', false);
    assert.equal(h.click().prevented, false); assert.equal(h.link.href, h.urls[0].url); h.run(0);
    assert.equal(file.releases, 1); h.run(1000); assert.deepEqual(h.revoked, [h.urls[0].url]);
    assert.equal(h.dialog.active.id, 'second');
});
