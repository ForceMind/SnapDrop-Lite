'use strict';
// Exercise the real server expiry order against the browser peer/transfer
// state machines. Ending a signaling session must not delete local opt-in data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const { ZeydropServer } = require('../server/index.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture({ delayedWrite = false, durable = true } = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const events = [], timers = new Set(), prefix = Buffer.alloc(16384, 7), tail = Buffer.alloc(16384, 9);
    class Window extends EventTarget {
        dispatchEvent(event) { events.push({ type: event.type, detail: event.detail }); return super.dispatchEvent(event); }
    }
    class Socket {
        static OPEN = 1;
        constructor() { this.readyState = 1; this.sent = []; }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.readyState = 3; }
    }
    class RTC {
        constructor() { this.signalingState = 'stable'; this.iceConnectionState = 'new'; this.connectionState = 'new'; }
        close() { this.connectionState = 'closed'; }
    }
    const window = Object.assign(new Window(), { RTCPeerConnection: RTC, crypto: { subtle: {} }, ZeydropHash: { create: () => sha256.create() } });
    const timeout = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
    const context = { window, RTCPeerConnection: RTC, WebSocket: Socket, CustomEvent, TextEncoder, Uint8Array,
        location: { protocol: 'https:', host: 'zeydrop.example' }, performance,
        setTimeout: timeout, clearTimeout, setInterval: timeout, clearInterval: clearTimeout };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\n'
        + fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.Server = ServerConnection; this.Manager = PeersManager;', context);
    const server = new context.Server(), manager = new context.Manager(server), roomId = 'a'.repeat(32);
    server._peerId = 'a'; server._desiredRoomId = roomId;
    server._onMessage(JSON.stringify({ type: 'peers', peers: [{ id: 'z' }] }));
    const peer = manager.peers.get('z'), entered = gate(), writeGate = gate(), frames = [];
    peer._send = data => frames.push(typeof data === 'string' ? JSON.parse(data) : data);
    const disk = { body: Buffer.from(prefix), committed: { offset: prefix.length, sha256: digest(prefix) }, deleted: false, aborts: 0, parks: [] };
    const sink = {
        async write(bytes) { entered.resolve(); if (delayedWrite) await writeGate.promise; disk.body = Buffer.concat([disk.body, Buffer.from(bytes)]); },
        async abort() { disk.aborts++; disk.deleted = true; }
    };
    if (durable) sink.park = async sha256 => { disk.parks.push(sha256); disk.committed = { offset: disk.body.length, sha256 }; };
    const state = { meta: { id: 'b'.repeat(32), size: prefix.length + tail.length, name: 'important.bin', mime: 'application/octet-stream' },
        offset: prefix.length, acked: prefix.length, hash: sha256.create().update(prefix), start: performance.now(), sink };
    peer._incoming = state;
    const expire = () => {
        const messages = [];
        // Use the production expiry method rather than fabricating a reordered
        // browser-only shortcut: peers=[] is emitted before room-expired.
        const session = { peer: {}, room: roomId };
        const signaling = { rooms: new Map([[roomId, { members: new Map([['a', session]]) }]]),
            send(_peer, message) { messages.push(message); server._onMessage(JSON.stringify(message)); } };
        ZeydropServer.prototype.expire.call(signaling, roomId);
        assert.deepEqual(messages.map(message => message.type), ['peers', 'room-expired']);
        assert.equal(signaling.rooms.size, 0); assert.equal(session.room, null);
    };
    const cleanup = () => { for (const timer of timers) clearTimeout(timer); for (const current of manager.peers.values()) current.close(); };
    return { server, manager, peer, state, disk, prefix, tail, events, frames, expire, entered, writeGate, cleanup };
}

function assertRetired(h) {
    assert.equal(h.manager.peers.size, 0); assert.equal(h.manager._resumeSlots.size, 0);
    assert.equal(h.peer._incoming, null); assert.equal(h.peer._held, null);
    assert.equal(h.peer._closed, true); assert.equal(h.peer._verified, false);
    assert.equal(h.peer._path.direct, false); assert.equal(h.server._desiredRoomId, null);
    assert.equal(h.events.some(event => event.type === 'file-received' || event.type === 'transfer-state' && event.detail.phase === 'complete'), false);
    assert.equal(h.frames.some(message => ['ack', 'complete'].includes(message.type)), false);
}

test('natural server session expiry parks durable data without retaining an old peer identity', async () => {
    const h = await fixture();
    try {
        h.expire(); await turn();
        assert.equal(h.disk.deleted, false, 'session expiry must not delete an opt-in durable checkpoint');
        assert.deepEqual(h.disk.parks, [digest(h.prefix)]); assertRetired(h);
        h.server._onMessage(JSON.stringify({ type: 'hello', peerId: 'new-local', resumeToken: 'new-token' }));
        h.server._onMessage(JSON.stringify({ type: 'peers', peers: [{ id: 'z' }] }));
        const replacement = h.manager.peers.get('z');
        assert.notEqual(replacement, h.peer); assert.equal(replacement._incoming, null); assert.equal(replacement._held, null);
        assert.equal(replacement._verified, false, 'new pairing must obtain fresh user authorization');
    } finally { h.cleanup(); }
});

test('session expiry waits for an already-started write before publishing its durable checkpoint', async () => {
    const h = await fixture({ delayedWrite: true });
    try {
        h.peer._receive(h.tail.buffer.slice(h.tail.byteOffset, h.tail.byteOffset + h.tail.length), () => true);
        await h.entered.promise;
        h.expire(); await turn();
        assert.equal(h.disk.deleted, false); assert.equal(h.disk.parks.length, 0, 'park must wait for native write completion');
        assertRetired(h);
        h.writeGate.resolve(); await h.peer._messageChain; await turn();
        const expected = Buffer.concat([h.prefix, h.tail]);
        assert.equal(h.state.offset, expected.length);
        assert.deepEqual(h.disk.parks, [digest(expected)]);
        assert.deepEqual(h.disk.committed, { offset: expected.length, sha256: digest(expected) });
        assertRetired(h);
    } finally { h.writeGate.resolve(); h.cleanup(); }
});

test('explicit file cancellation and protocol corruption still delete durable data', async () => {
    for (const corruption of [false, true]) {
        const h = await fixture();
        try {
            if (corruption) h.peer._protocolError('SHA-256 校验失败');
            else h.peer.cancel(h.state.meta.id, '用户取消', false);
            await turn(); assert.equal(h.disk.aborts, 1); assert.equal(h.disk.parks.length, 0);
        } finally { h.cleanup(); }
    }
});

test('session expiry still aborts an ordinary non-durable receive sink', async () => {
    const h = await fixture({ durable: false });
    try { h.expire(); await turn(); assert.equal(h.disk.aborts, 1); assertRetired(h); }
    finally { h.cleanup(); }
});
