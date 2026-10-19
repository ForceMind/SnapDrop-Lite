'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('../server/node_modules/ws');
const { ZeydropServer, RESUME_TTL } = require('../server');
const origin = 'http://localhost:8080';
const roomId = 'fedcba98765432100123456789abcdef';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, options = {}) {
    const server = new ZeydropServer({ port: 0, origins: origin, ...options });
    await new Promise(resolve => server._wss.on('listening', resolve));
    t.after(() => server.close());
    const url = 'ws://127.0.0.1:' + server._wss.address().port + '/server/webrtc';
    async function connect(resumeToken) {
        const ws = new WebSocket(url, { origin }); const messages = [];
        ws.on('message', bytes => messages.push(JSON.parse(bytes)));
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        ws.send(JSON.stringify({ type: 'hello', ...(resumeToken ? { resumeToken } : {}) }));
        const wait = async predicate => { for (let i = 0; i < 100; i++) { const value = messages.find(predicate); if (value) return value; await delay(5); } throw Error('WS message timeout: ' + JSON.stringify(messages)); };
        const hello = await wait(msg => msg.type === 'hello');
        return { ws, messages, hello, send: msg => ws.send(JSON.stringify(msg)), wait };
    }
    return { server, connect, url };
}
test('server IDs, private discovery, create/join, two-person cap and cross-room isolation', async t => {
    const { connect } = await setup(t);
    const [a, b, c] = await Promise.all([connect(), connect(), connect()]);
    assert.notEqual(a.hello.peerId, b.hello.peerId); assert.equal(a.hello.resumeToken.length, 64);
    assert.ok(!a.messages.some(msg => msg.type === 'peer-joined'));
    a.send({ type: 'create-room', roomId }); await a.wait(msg => msg.type === 'room-joined');
    b.send({ type: 'join-room', roomId }); await b.wait(msg => msg.type === 'room-joined');
    c.send({ type: 'join-room', roomId }); assert.equal((await c.wait(msg => msg.type === 'room-error')).code, 'full');
    c.send({ type: 'signal', to: a.hello.peerId, sdp: { type: 'offer', sdp: 'v=0\r\n' } });
    await delay(20); assert.ok(!a.messages.some(msg => msg.type === 'signal'));
    a.send({ type: 'signal', to: b.hello.peerId, sdp: { type: 'offer', sdp: 'v=0\r\n' } });
    assert.equal((await b.wait(msg => msg.type === 'signal')).sender, a.hello.peerId);
});
test('file payloads, invalid nested signaling and TURN candidates are never relayed', async t => {
    const { connect } = await setup(t); const a = await connect(), b = await connect();
    a.send({ type: 'create-room', roomId }); await a.wait(msg => msg.type === 'room-joined');
    b.send({ type: 'join-room', roomId }); await b.wait(msg => msg.type === 'room-joined');
    for (const message of [
        { type: 'file-chunk', to: b.hello.peerId, data: 'FILE_SENTINEL' },
        { type: 'signal', to: b.hello.peerId, sdp: { type: 'offer', sdp: 'v=0', file: 'FILE_SENTINEL' } },
        { type: 'signal', to: b.hello.peerId, ice: { candidate: 'candidate:1 1 udp 1 1.1.1.1 3478 typ relay', sdpMid: '0', sdpMLineIndex: 0 } },
        { type: 'signal', to: b.hello.peerId, sdp: { type: 'offer', sdp: 'v=0' }, extra: true }
    ]) a.send(message);
    await delay(25); assert.ok(!b.messages.some(msg => msg.type === 'signal'));
    a.ws.send(Buffer.from('FILE_SENTINEL'));
    await new Promise(resolve => a.ws.on('close', resolve)); assert.equal(a.ws._closeCode, 1008);
});
test('expired/missing invitations cannot be resurrected by joining', async t => {
    let now = 100000;
    const { connect, server } = await setup(t, { now: () => now, roomTTL: 100 });
    const a = await connect(); a.send({ type: 'create-room', roomId }); await a.wait(msg => msg.type === 'room-joined');
    now += 101; server.sweep(); await a.wait(msg => msg.type === 'room-expired');
    const b = await connect(); b.send({ type: 'join-room', roomId }); assert.equal((await b.wait(msg => msg.type === 'room-error')).code, 'missing');
    assert.equal(server.rooms.size, 0);
});
test('short reconnect restores server identity and reserves room slot; expiry drops authority', async t => {
    let now = 100000;
    const { connect, server } = await setup(t, { now: () => now });
    const a = await connect(); a.send({ type: 'create-room', roomId }); await a.wait(msg => msg.type === 'room-joined');
    a.ws.close(); await new Promise(resolve => a.ws.on('close', resolve)); await delay(5);
    const resumed = await connect(a.hello.resumeToken);
    assert.equal(resumed.hello.peerId, a.hello.peerId); await resumed.wait(msg => msg.type === 'room-joined');
    resumed.ws.close(); await new Promise(resolve => resumed.ws.on('close', resolve)); await delay(5);
    now += RESUME_TTL + 1; server.sweep();
    const fresh = await connect(a.hello.resumeToken); assert.notEqual(fresh.hello.peerId, a.hello.peerId);
});
test('Origin/path checks and message-rate limits reject invalid clients', async t => {
    const { connect, url } = await setup(t);
    for (const [target, value] of [[url, 'https://evil.example'], [url.replace('/server/webrtc', '/wrong'), origin]]) {
        const socket = new WebSocket(target, { origin: value });
        const error = await new Promise(resolve => socket.once('error', resolve)); assert.match(error.message, /401/);
    }
    const a = await connect();
    for (let i = 0; i < 250; i++) a.send({ type: 'pong' });
    await new Promise(resolve => a.ws.on('close', resolve)); assert.equal(a.ws._closeCode, 1008);
});
