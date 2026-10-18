'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function makeSignaling() {
    const fakeProcess = { env: { LAN_MODE: 'false', PORT: '3001' }, on() {} };
    class WSS {
        constructor(options) { this.options = options; this.handlers = {}; }
        on(type, handler) { this.handlers[type] = handler; }
    }
    const fakeRequire = id => {
        if (id === 'process') return fakeProcess;
        if (id === 'ws') return { Server: WSS };
        if (id === 'ua-parser-js') {
            return () => ({ os: { name: 'Linux' }, device: {}, browser: { name: 'Chrome' } });
        }
        if (id === 'unique-names-generator') return {};
        throw Error('Unexpected dependency: ' + id);
    };
    const context = {
        require: fakeRequire,
        URL,
        setTimeout: () => 1,
        clearTimeout: () => {},
        console: { log() {}, info() {}, warn() {}, error() {} },
        Buffer
    };
    vm.createContext(context);
    vm.runInContext(read('server/index.js') + '\n;globalThis.__exposed = {Peer, server};', context);
    const { Peer, server } = context.__exposed;

    class FakeSocket {
        constructor(ip) { this.sent = []; this.handlers = {}; this.readyState = 1; this.ip = ip; }
        on(type, handler) { this.handlers[type] = handler; }
        send(json) { this.sent.push(JSON.parse(json)); }
        terminate() { this.readyState = 3; }
    }
    function connect(id, ip) {
        const socket = new FakeSocket(ip);
        const request = {
            url: '/server/webrtc?peerId=' + id,
            headers: { 'user-agent': 'SmokeTest' },
            connection: { remoteAddress: ip }
        };
        const peer = new Peer(socket, request);
        server._onConnection(peer);
        return peer;
    }
    return { server, connect };
}

test('public peers stay private until invited into a strong room', () => {
    const { server, connect } = makeSignaling();
    const a = connect('peer-a', '198.18.0.1');
    const b = connect('peer-b', '198.18.0.2');
    assert.ok(a.roomKey.startsWith('session:'));
    assert.ok(b.roomKey.startsWith('session:'));
    assert.equal(a.socket.sent.find(m => m.type === 'peers').peers.length, 0);
    assert.equal(b.socket.sent.find(m => m.type === 'peers').peers.length, 0);

    const roomId = 'fedcba98765432100123456789abcdef';
    for (const peer of [a, b]) {
        server._onMessage(peer, JSON.stringify({ type: 'join-room', roomId }));
        assert.ok(peer.socket.sent.some(m => m.type === 'room-joined'));
    }
    assert.equal(Object.keys(server._rooms['room:' + roomId]).length, 2);

    const c = connect('peer-c', '198.18.0.3');
    server._onMessage(c, JSON.stringify({ type: 'join-room', roomId }));
    assert.ok(c.socket.sent.some(m => m.type === 'room-error'));
    assert.equal(Object.keys(server._rooms['room:' + roomId]).length, 2);
});

test('non-signaling payloads never go through the websocket relay', () => {
    const { server, connect } = makeSignaling();
    const a = connect('peer-a', '198.18.0.1');
    const b = connect('peer-b', '198.18.0.2');
    const roomId = 'fedcba98765432100123456789abcdef';
    for (const peer of [a, b]) server._onMessage(peer, JSON.stringify({ type: 'join-room', roomId }));

    const n = b.socket.sent.length;
    server._onMessage(a, JSON.stringify({ type: 'file-chunk', to: b.id, content: 'secret' }));
    server._onMessage(a, JSON.stringify({ type: 'signal', to: b.id, payload: 'secret' }));
    server._onMessage(a, JSON.stringify({ type: 'signal', to: b.id, sdp: { type: 'offer', sdp: 'v=0', file: 'secret' }, foo: 'bar' }));
    assert.equal(b.socket.sent.length, n);

    server._onMessage(a, JSON.stringify({ type: 'signal', to: b.id, sdp: { type: 'offer', sdp: 'v=0' } }));
    assert.equal(b.socket.sent.length, n + 1);
    assert.equal(b.socket.sent.at(-1).type, 'signal');
    assert.equal(b.socket.sent.at(-1).sdp.sdp, 'v=0');
});

test('UI can create a room without a signaling roundtrip race', () => {
    const net = read('client/scripts/network.js');
    const ui = read('client/scripts/ui.js');
    const html = read('client/index.html');
    const config = read('client/config.js');

    assert.match(net, /this\._desiredRoomId = roomId\.trim\(\)/);
    assert.match(net, /if \(this\._desiredRoomId\)/);
    assert.match(ui, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
    assert.match(config, /SNAPDROP_ENABLE_STUN\s*=\s*true/);
    for (const id of ['roomInput', 'roomBtn', 'createRoomBtn', 'inviteUrl', 'signalStatus', 'peerCount']) {
        assert.match(html, new RegExp('id="' + id + '"'));
    }
});

test('browser scripts parse without bundlers', () => {
    const vm = require('node:vm');
    for (const path of ['client/scripts/network.js', 'client/scripts/ui.js', 'client/scripts/clipboard.js']) {
        assert.doesNotThrow(() => new vm.Script(read(path), { filename: path }));
    }
});
