'use strict';
// Execute the shipped controllers. The DOM/canvas doubles expose state and
// scheduling only; native browser tests independently render and decode QR PNGs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('client/scripts/ui.js', 'utf8');
const end = source.indexOf('class FileOfferDialog extends Dialog');
assert.ok(end > 0, 'the actual dialog controllers must precede file offers');
const controller = source.slice(0, end);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
    const elements = new Map(), events = [], subscriptions = new Map(), windowEvents = new Map(), qrCalls = [];
    let document;
    class Element {
        constructor(tag, id = '', parent = null) {
            Object.assign(this, { tagName: tag, id, parent, children: [], attrs: new Map(), handlers: new Map(),
                hidden: false, disabled: false, value: '', textContent: '', dataset: {}, tabIndex: ['button', 'textarea'].includes(tag) ? 0 : -1,
                width: 512, height: 512, clearCount: 0, drawCount: 0, rendered: null });
            if (parent) parent.children.push(this);
            if (id) { assert.ok(!elements.has(id)); elements.set(id, this); }
        }
        setAttribute(name, value) { this.attrs.set(name, String(value)); }
        hasAttribute(name) { return this.attrs.has(name); }
        removeAttribute(name) { this.attrs.delete(name); }
        get href() { return this.attrs.get('href') || ''; }
        set href(value) { this.attrs.set('href', String(value)); }
        addEventListener(name, listener) { const list = this.handlers.get(name) || []; list.push(listener); this.handlers.set(name, list); }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        querySelector(selector) { assert.equal(selector, 'h3'); return this.descendants().find(child => child.tagName === 'h3') || null; }
        querySelectorAll(selector) {
            if (selector === '[close]') return this.descendants().filter(child => child.hasAttribute('close'));
            assert.ok(selector.startsWith('button:not([disabled]), a[href], input:not([disabled])'), 'unexpected focus selector');
            return this.descendants().filter(child => ['button', 'textarea'].includes(child.tagName) || child.tagName === 'a' && child.hasAttribute('href') || child.hasAttribute('tabindex'));
        }
        matches(selector) { assert.equal(selector, ':disabled'); return this.disabled; }
        closest(selector) {
            assert.equal(selector, '[hidden], [inert]');
            for (let node = this; node; node = node.parent) if (node.hidden || node.hasAttribute('inert')) return node;
            return null;
        }
        visible() {
            for (let node = this; node; node = node.parent)
                if (node.hidden || node.tagName === 'x-dialog' && !node.hasAttribute('show')) return false;
            return true;
        }
        getClientRects() { return this.visible() ? [{}] : []; }
        focus() { if (this.visible() && !this.disabled) document.activeElement = this; }
        getContext(type) {
            assert.equal(type, '2d');
            return { clearRect: () => { this.clearCount++; this.rendered = null; },
                drawImage: canvas => { this.drawCount++; this.rendered = canvas.rendered; } };
        }
        toDataURL(type) { assert.equal(type, 'image/png'); return 'data:image/png;base64,' + Buffer.from(String(this.rendered)).toString('base64'); }
    }
    const el = (tag, id, parent) => new Element(tag, id, parent);
    const opener = el('button', 'openTextTools'), toast = el('div', 'toast');
    const dialogs = [];
    const dialog = id => { const root = el('x-dialog', id); dialogs.push(root); el('h3', '', root); return root; };
    const qrRoot = dialog('textQrDialog'), input = el('textarea', 'qrTextInput', qrRoot);
    input.setAttribute('autofocus', '');
    el('p', 'qrTextStatus', qrRoot);
    el('button', 'generateTextQR', qrRoot); el('button', 'clearTextQR', qrRoot);
    el('button', 'closeTextQR', qrRoot).setAttribute('close', '');
    const preview = el('div', 'textQRPreview', qrRoot); preview.hidden = true;
    el('canvas', 'textQR', preview).hidden = true;
    const save = el('a', 'saveTextQR', preview); save.hidden = true; save.tabIndex = 0;
    const receiveRoot = dialog('receiveTextDialog');
    el('div', 'text', receiveRoot); el('button', 'copy', receiveRoot).setAttribute('autofocus', '');
    el('button', 'receiveTextClose', receiveRoot).setAttribute('close', '');
    const fileRoot = dialog('queuedFileDialog'); el('button', 'fileAccept', fileRoot).setAttribute('autofocus', '');
    el('button', 'fileClose', fileRoot).setAttribute('close', '');
    document = { activeElement: opener,
        getElementById(id) { assert.ok(elements.has(id), 'unknown DOM id: ' + id); return elements.get(id); },
        createElement(tag) { assert.equal(tag, 'canvas'); return el(tag); },
        querySelector(selector) { assert.equal(selector, 'x-dialog[show]'); return dialogs.find(node => node.hasAttribute('show')) || null; } };
    const window = {
        addEventListener(name, listener) { windowEvents.set(name, listener); },
        ZeydropQR: { toCanvas(canvas, segments, options) {
            const job = deferred(); qrCalls.push({ canvas, segments, options, ...job }); return job.promise;
        } }
    };
    const Events = {
        on(name, listener) { subscriptions.set(name, listener); },
        fire(type, detail) { events.push({ type, detail }); subscriptions.get(type)?.({ detail }); }
    };
    const context = vm.createContext({ window, document, Events, TextEncoder, queueMicrotask,
        getComputedStyle: () => ({ visibility: 'visible' }), setTimeout: () => 1, clearTimeout() {} });
    vm.runInContext(controller + '\nthis.Controllers = { Dialog, TextQRDialog, ReceiveTextDialog };', context);
    const { Dialog, TextQRDialog, ReceiveTextDialog } = context.Controllers;
    const qr = new TextQRDialog(), receive = new ReceiveTextDialog(), file = new Dialog('queuedFileDialog');
    const $ = id => document.getElementById(id);
    const click = id => {
        const node = $(id); assert.ok(node.visible(), 'click target must be visible'); assert.equal(node.disabled, false);
        node.focus(); node.onclick?.(); for (const listener of node.handlers.get('click') || []) listener();
    };
    const change = value => { input.value = value; input.oninput(); };
    const complete = (index, marker) => { const job = qrCalls[index]; job.canvas.rendered = marker; job.resolve(); };
    return { qr, receive, file, Dialog, $, click, change, complete, qrCalls, events, document, windowEvents,
        visibleDialogs: () => dialogs.filter(node => node.hasAttribute('show')).map(node => node.id) };
}

test('editing a draft retires an older QR job even if it completes after the new image', async () => {
    const h = fixture(); h.click('openTextTools'); h.change('old private draft');
    const old = h.qr.generate(); h.change('新的原文 😀\nhttps://example.test/?a=1&b=2');
    const current = h.qr.generate(); h.complete(1, 'new-image'); await current;
    const href = h.$('saveTextQR').href, status = h.$('qrTextStatus').textContent;
    h.complete(0, 'obsolete-image'); await old;
    assert.equal(h.$('textQR').rendered, 'new-image'); assert.equal(h.$('textQR').drawCount, 1);
    assert.equal(h.$('saveTextQR').href, href); assert.equal(h.$('qrTextStatus').textContent, status);
    assert.equal(h.$('qrTextInput').value, '新的原文 😀\nhttps://example.test/?a=1&b=2');
});

test('closing or leaving the page clears private QR state and late completion cannot repopulate it', async () => {
    for (const leave of [false, true]) {
        const h = fixture(); h.qr.open('private text'); const pending = h.qr.generate();
        if (leave) h.windowEvents.get('pagehide')(); else h.click('closeTextQR');
        assert.equal(h.$('qrTextInput').value, ''); assert.equal(h.$('textQR').hidden, true);
        assert.equal(h.$('saveTextQR').hasAttribute('href'), false); assert.deepEqual(h.visibleDialogs(), []);
        h.complete(0, 'late-private-image'); await pending;
        assert.equal(h.$('textQR').drawCount, 0); assert.equal(h.$('textQRPreview').hidden, true);
        assert.equal(h.$('saveTextQR').hasAttribute('href'), false);
        h.click('openTextTools'); assert.equal(h.$('qrTextInput').value, '');
    }
});

test('QR input enforces the UTF-8 byte boundary and rejects incomplete characters without truncation', async () => {
    for (const [value, valid] of [
        ['a'.repeat(800), true], ['a'.repeat(801), false], ['中'.repeat(266), true], ['中'.repeat(267), false],
        ['😀'.repeat(200), true], ['😀'.repeat(201), false], ['', false], [' \n\t ', true],
        ['\ud800', false], ['\udc00', false], ['ok\ud800end', false], ['ok\udc00end', false]
    ]) {
        const h = fixture(); h.click('openTextTools'); h.change(value);
        assert.equal(h.$('qrTextInput').value, value); assert.equal(h.$('generateTextQR').disabled, !valid, JSON.stringify(value.slice(0, 12)));
        if (!valid) { await h.qr.generate(); assert.equal(h.qrCalls.length, 0); }
        if (value.includes('\ud800') || value.includes('\udc00')) assert.match(h.$('qrTextStatus').textContent, /不完整/);
    }
});

test('the local encoder receives the exact draft and a successful preview is immediately revoked on edit or clear', async () => {
    const h = fixture(), text = '  中文 😀\n<script>literal</script>\nhttps://example.test/?a=1&b=2  ';
    h.click('openTextTools'); h.change(text); const first = h.qr.generate();
    assert.equal(h.qrCalls.length, 1); assert.equal(h.qrCalls[0].segments[0].data, text);
    assert.equal(h.qrCalls[0].segments[0].mode, 'byte'); assert.equal(h.qrCalls[0].options.margin, 4);
    h.complete(0, 'first'); await first;
    assert.equal(h.$('textQRPreview').hidden, false); assert.equal(h.$('textQR').hidden, false);
    assert.equal(h.$('saveTextQR').hidden, false); assert.match(h.$('saveTextQR').href, /^data:image\/png;base64,/);
    h.change('edited'); assert.equal(h.$('textQRPreview').hidden, true); assert.equal(h.$('textQR').rendered, null);
    assert.equal(h.$('saveTextQR').hasAttribute('href'), false);
    const second = h.qr.generate(); h.complete(1, 'second'); await second;
    h.click('clearTextQR'); assert.equal(h.$('qrTextInput').value, ''); assert.equal(h.$('textQR').rendered, null);
    assert.equal(h.$('saveTextQR').hasAttribute('href'), false); assert.equal(h.$('generateTextQR').disabled, true);
    assert.equal(h.document.activeElement, h.$('qrTextInput'));
});

test('a failed or stale encoder cannot expose an old image and current failures remain retryable', async () => {
    const h = fixture(); h.qr.open('first'); const stale = h.qr.generate();
    h.change('current'); const current = h.qr.generate();
    h.qrCalls[0].reject(Error('OBSOLETE_NATIVE_DETAIL')); await stale;
    assert.equal(h.$('generateTextQR').disabled, true, 'stale cleanup must not enable the current in-flight action');
    h.qrCalls[1].reject(Error('PRIVATE_NATIVE_DETAIL')); await current;
    assert.equal(h.$('textQRPreview').hidden, true); assert.equal(h.$('saveTextQR').hasAttribute('href'), false);
    assert.equal(h.$('generateTextQR').disabled, false); assert.match(h.$('qrTextStatus').textContent, /重试/);
    assert.ok(!h.$('qrTextStatus').textContent.includes('PRIVATE_NATIVE_DETAIL'));
});

test('incoming text and file dialogs queue behind QR without stealing focus and appear one at a time', async () => {
    const h = fixture(); h.click('openTextTools'); const focus = h.document.activeElement;
    h.receive.enqueue('first'); h.receive.enqueue('second'); h.file.show(); h.file.show();
    assert.deepEqual(h.visibleDialogs(), ['textQrDialog']); assert.equal(h.document.activeElement, focus);
    h.click('closeTextQR'); await turn();
    assert.deepEqual(h.visibleDialogs(), ['receiveTextDialog']); assert.equal(h.$('text').textContent, 'first');
    assert.equal(h.document.activeElement, h.$('copy'));
    h.click('receiveTextClose'); await turn();
    assert.deepEqual(h.visibleDialogs(), ['receiveTextDialog']); assert.equal(h.$('text').textContent, 'second');
    h.click('receiveTextClose'); await turn(); assert.deepEqual(h.visibleDialogs(), ['queuedFileDialog']);
    assert.equal(h.document.activeElement, h.$('fileAccept'));
    h.click('fileClose'); await turn(); assert.deepEqual(h.visibleDialogs(), [], 'a duplicate show must not leave a ghost queued dialog');
});

test('text to QR and back preserves its active message ahead of unrelated queued dialogs', async () => {
    const h = fixture(); h.receive.enqueue('active message'); h.receive.enqueue('next message');
    h.Dialog.prototype.hide.call(h.receive); h.qr.open(h.$('text').textContent, h.receive); h.file.show();
    await turn(); assert.deepEqual(h.visibleDialogs(), ['textQrDialog']); assert.equal(h.receive.active, 'active message');
    h.click('closeTextQR'); await turn();
    assert.deepEqual(h.visibleDialogs(), ['receiveTextDialog']); assert.equal(h.$('text').textContent, 'active message');
    h.click('receiveTextClose'); await turn(); assert.equal(h.$('text').textContent, 'next message');
    h.click('receiveTextClose'); await turn(); assert.deepEqual(h.visibleDialogs(), ['queuedFileDialog']);
});

test('canceling a waiting dialog removes it without disturbing the visible QR window', async () => {
    const h = fixture(); h.click('openTextTools'); h.file.show(); h.file.hide(); await turn();
    assert.deepEqual(h.visibleDialogs(), ['textQrDialog']); assert.equal(h.document.activeElement, h.$('qrTextInput'));
    h.click('closeTextQR'); await turn(); assert.deepEqual(h.visibleDialogs(), []);
});

test('the receive-text queue keeps twenty messages in order and explicitly reports overflow', async () => {
    const h = fixture(); h.click('openTextTools');
    for (let index = 0; index < 21; index++) h.receive.enqueue('message-' + index);
    assert.equal(h.receive.queue.length, 19); assert.equal(h.receive.active, 'message-0');
    assert.ok(h.events.some(event => event.type === 'notify-user' && /20 条.*未显示.*重发/.test(event.detail)));
    h.click('closeTextQR'); await turn();
    for (let index = 0; index < 20; index++) {
        assert.deepEqual(h.visibleDialogs(), ['receiveTextDialog']); assert.equal(h.$('text').textContent, 'message-' + index);
        h.click('receiveTextClose'); await turn();
    }
    assert.equal(h.receive.active, null); assert.equal(h.receive.queue.length, 0); assert.deepEqual(h.visibleDialogs(), []);
});
