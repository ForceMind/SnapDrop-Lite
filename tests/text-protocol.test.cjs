'use strict';
// Exercise the shipped DataChannel protocol with exact text values, including
// JSON expansion. These tests do not substitute a more permissive decoder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
    const events = [], sent = [], failures = [], serverCalls = [];
    const context = vm.createContext({
        window: {}, Events: { fire: (type, detail) => events.push({ type, detail }) },
        TextEncoder, performance, Uint8Array, setTimeout, clearTimeout
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer = TransferPeer;', context);
    const peer = new context.Peer({ send: value => serverCalls.push(value) }, 'paired-peer');
    Object.assign(peer, { _verified: true, _remoteHello: true, _path: { direct: true } });
    peer._isConnected = () => true;
    peer._send = value => sent.push(value);
    peer._protocolError = reason => failures.push(reason);
    return { peer, events, sent, failures, serverCalls };
}
const texts = h => h.events.filter(event => event.type === 'text-received').map(event => event.detail.text);

test('4096 newline and control-character texts survive JSON expansion without closing a valid channel', async () => {
    for (const text of ['\n'.repeat(4096), '\0'.repeat(4096), '\u0001'.repeat(4096), '\\"'.repeat(2048)]) {
        const h = harness(), frame = JSON.stringify({ type: 'text', text });
        assert.ok(frame.length > 8192, 'fixture must cross the old general-control boundary');
        h.peer._receive(frame); await h.peer._messageChain;
        assert.deepEqual(h.failures, []); assert.deepEqual(texts(h), [text]);
        assert.equal(h.peer._queuedBytes, 0); assert.deepEqual(h.serverCalls, []);
    }
});

test('sendText returns true only after sending exact Unicode, markup and escaped values over its DataChannel', async () => {
    for (const text of ['x', 'a'.repeat(4096), '😀'.repeat(2048), '<script>alert("x")</script> & 中文\n\t', '\n'.repeat(4096), '\ud800'.repeat(4096)]) {
        const sender = harness(), receiver = harness();
        assert.equal(sender.peer.sendText(text), true);
        assert.equal(sender.sent.length, 1); assert.deepEqual(JSON.parse(sender.sent[0]), { type: 'text', text });
        await receiver.peer._onMessage(sender.sent[0]);
        assert.deepEqual(texts(receiver), [text]); assert.deepEqual(sender.serverCalls, []);
    }
});

test('sendText rejects empty, non-string and over-limit inputs without truncation or channel writes', () => {
    for (const value of ['', undefined, null, 0, false, {}, ['text'], new String('text'), 'a'.repeat(4097), '😀'.repeat(2048) + 'x']) {
        const h = harness(); assert.equal(h.peer.sendText(value), false);
        assert.deepEqual(h.sent, []); assert.deepEqual(h.serverCalls, []);
        assert.equal(h.events.filter(event => event.type === 'notify-user').length, 1);
    }
    const h = harness(); assert.equal(h.peer.sendText(' \t\n'), true);
    assert.equal(JSON.parse(h.sent[0]).text, ' \t\n', 'whitespace is content and must remain unchanged');
});

test('unverified, unknown, relay, disconnected and pre-handshake peers cannot send text', () => {
    for (const configure of [
        h => { h.peer._verified = false; },
        h => { h.peer._path = { direct: false, status: 'unknown' }; },
        h => { h.peer._path = { direct: false, status: 'relay' }; },
        h => { h.peer._path = null; },
        h => { h.peer._isConnected = () => false; },
        h => { h.peer._remoteHello = false; }
    ]) {
        const h = harness(); configure(h); assert.equal(h.peer.sendText('private text'), false);
        assert.deepEqual(h.sent, []); assert.deepEqual(h.serverCalls, []);
        assert.equal(h.events.filter(event => event.type === 'notify-user').length, 1);
    }
});

test('a synchronous DataChannel send failure is false with a fixed private-error-free notification', () => {
    const h = harness(); h.peer._send = () => { throw Error('PRIVATE_NATIVE_CHANNEL_DETAIL'); };
    assert.equal(h.peer.sendText('keep this draft'), false);
    assert.equal(h.events.filter(event => event.type === 'notify-user').length, 1);
    assert.ok(!JSON.stringify(h.events).includes('PRIVATE_NATIVE_CHANNEL_DETAIL'));
    assert.deepEqual(h.serverCalls, []);
});

test('only exact bounded nonempty string text messages receive the larger frame allowance', async () => {
    for (const message of [
        { type: 'text', text: '' }, { type: 'text' }, { type: 'text', text: null },
        { type: 'text', text: 123 }, { type: 'text', text: ['value'] },
        { type: 'text', text: 'a'.repeat(4097) },
        { type: 'text', text: '\0'.repeat(4096), extra: true },
        { type: 'text', text: 'small', file: 'forbidden' }
    ]) {
        const h = harness(); await assert.rejects(h.peer._onMessage(JSON.stringify(message)), /文本|控制消息/);
        assert.deepEqual(texts(h), []); assert.deepEqual(h.serverCalls, []);
    }
    const h = harness();
    await assert.rejects(h.peer._onMessage('{"type":"text","text":"'), /无效/);
    await assert.rejects(h.peer._onMessage('{"type":"text","text":"small","__proto__":{"file":"forbidden"}}'), /文本/);
});

test('non-text control frames retain the 8192 boundary and every text frame is capped at 32768', async () => {
    const control = JSON.stringify({ type: 'unknown-control' }), text = JSON.stringify({ type: 'text', text: 'valid' });
    const padded = (value, size) => value + ' '.repeat(size - value.length);
    const h = harness(); await h.peer._onMessage(padded(control, 8192));
    await assert.rejects(h.peer._onMessage(padded(control, 8193)), /控制消息超限/);
    await h.peer._onMessage(padded(text, 32768)); assert.deepEqual(texts(h), ['valid']);
    await assert.rejects(h.peer._onMessage(padded(text, 32769)), /控制消息超限/);
    await assert.rejects(h.peer._onMessage(' '.repeat(32769)), /控制消息超限/);
});

test('receiving text requires the verified current direct connection and completed hello protocol', async () => {
    const frame = JSON.stringify({ type: 'text', text: 'private' });
    for (const configure of [
        h => { h.peer._verified = false; },
        h => { h.peer._path = { direct: false, status: 'unknown' }; },
        h => { h.peer._path = { direct: false, status: 'relay' }; },
        h => { h.peer._path = null; },
        h => { h.peer._isConnected = () => false; }
    ]) {
        const h = harness(); configure(h); await h.peer._onMessage(frame);
        assert.deepEqual(texts(h), []);
    }
    const h = harness(); h.peer._remoteHello = false;
    await assert.rejects(h.peer._onMessage(frame), /协议尚未就绪/); assert.deepEqual(texts(h), []);
});
