'use strict';
// Old DataChannel frames may arrive or be dequeued after ICE restart. Never
// allow their control messages to affect a newer transfer session.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function transferHarness() {
    const events = [];
    const context = {
        window: { ZeydropHash: {}, ZEYDROP_CONFIG: {} },
        Events: { fire: (type, detail) => events.push({ type, detail }) },
        TextEncoder, performance, Uint8Array, setTimeout, clearTimeout
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer = TransferPeer;', context);
    const peer = new context.Peer({}, 'paired-peer');
    peer._remoteHello = true; peer._verified = true; peer._path = { direct: true };
    peer._isConnected = () => true; peer._send = () => {};
    return { peer, events };
}
test('a stale text or cancel frame queued behind a disk write is discarded', async () => {
    const { peer, events } = transferHarness(), blocked = gate();
    peer._messageChain = blocked.promise;
    let originalWire = true;
    peer._receive(JSON.stringify({ type: 'text', text: 'old-session' }), () => originalWire);
    peer._receive(JSON.stringify({ type: 'cancel', id: 'a'.repeat(32) }), () => originalWire);
    originalWire = false;
    blocked.resolve(); await peer._messageChain;
    assert.equal(events.filter(e => e.type === 'text-received').length, 0);
    // A legitimate message from the new, live wire still works.
    peer._receive(JSON.stringify({ type: 'text', text: 'new-session' }), () => true);
    await peer._messageChain;
    const messages = events.filter(e => e.type === 'text-received').map(e => e.detail.text);
    assert.deepEqual(messages, ['new-session']);
});
test('discarding stale frames always releases bounded receive queue accounting', async () => {
    const { peer } = transferHarness(), blocked = gate();
    peer._messageChain = blocked.promise;
    let alive = true;
    const frame = JSON.stringify({ type: 'text', text: 'old' });
    peer._receive(frame, () => alive);
    assert.equal(peer._queuedBytes, frame.length);
    alive = false; blocked.resolve(); await peer._messageChain;
    assert.equal(peer._queuedBytes, 0);
});
test('obsolete channel callbacks cannot enqueue messages after rebind', () => {
    class FakeRTC {
        constructor() { this.iceConnectionState = 'new'; this.connectionState = 'new'; }
        close() {}
    }
    const context = {
        window: { RTCPeerConnection: FakeRTC, crypto: { subtle: {} }, ZEYDROP_CONFIG: { enableStun: false },
            addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
        RTCPeerConnection: FakeRTC,
        crypto: require('node:crypto').webcrypto,
        TransferPeer: class { constructor(server,id) { this._peerId=id; } },
        Events: { fire() {}, on() {}, off() {} },
        CustomEvent, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/network.js','utf8') + '\nthis.RTC = RTCPeer;', context);
    const peer = new context.RTC({ _peerId: 'a', send() {} }, 'z');
    const first = { readyState: 'open', close() {} };
    const second = { readyState: 'open', close() {} };
    let received = 0;
    peer._receive = () => { received++; };
    peer._bindChannel(first);
    const oldCallback = first.onmessage;
    peer._bindChannel(second);
    peer._state = 'connecting';
    oldCallback({ data: JSON.stringify({ type:'cancel', id:'a'.repeat(32) }) });
    assert.equal(received, 0, 'old callback must not run transfer control');
    second.onmessage({ data: JSON.stringify({ type:'hello', version:2 }) });
    assert.equal(received, 1, 'current channel must still deliver protocol');
    second.readyState = 'closed';
    second.onmessage({ data: JSON.stringify({ type:'hello', version:2 }) });
    assert.equal(received, 1, 'closing channel must reject frames');
    second.readyState = 'open';
    let queuedGuard;
    peer._receive = (_, guard) => { queuedGuard = guard; };
    second.onmessage({ data: JSON.stringify({ type: 'cancel', id:'a'.repeat(32) }) });
    assert.equal(queuedGuard(), true);
    peer._pathEpoch++;
    assert.equal(queuedGuard(), false, 'ICE path epoch change rejects an already queued same-channel control');
    clearTimeout(peer._deadline);
    peer._clearHelloHandshake(); clearInterval(peer._statsTimer);
});
