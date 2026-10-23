'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function directStats() {
    return new Map([
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
        ['local', { candidateType: 'host', protocol: 'udp' }],
        ['remote', { candidateType: 'srflx', protocol: 'udp' }]
    ]);
}
function harness() {
    const timers = new Map(), events = [], sent = [], aborted = [];
    let nextTimer = 0;
    const schedule = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
    const target = Object.assign(new EventTarget(), {
        RTCPeerConnection: function () {}, crypto: { subtle: {} }, ZEYDROP_CONFIG: { enableStun: false }
    });
    target.addEventListener('connection-state', event => events.push(event.detail));
    const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC:DD\r\n';
    class Connection {
        constructor() {
            this.iceConnectionState = 'connected'; this.connectionState = 'connected'; this.signalingState = 'stable';
            this.localDescription = { type: 'answer', sdp }; this.remoteDescription = { type: 'offer', sdp };
            this.offers = 0;
        }
        async getStats() { return directStats(); }
        async createOffer() { this.offers++; return { type: 'offer', sdp }; }
        async createAnswer() { return { type: 'answer', sdp }; }
        async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
        async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
        async addIceCandidate() {}
        close() { this.iceConnectionState = 'closed'; this.connectionState = 'closed'; }
    }
    const context = {
        window: target, CustomEvent, TextEncoder, RTCPeerConnection: Connection,
        crypto: { subtle: { digest: (...args) => webcrypto.subtle.digest(...args) } },
        hex: bytes => Buffer.from(bytes).toString('hex'),
        setTimeout: schedule, clearTimeout: id => timers.delete(id),
        setInterval: schedule, clearInterval: id => timers.delete(id),
        TransferPeer: class {
            constructor(server, id) { this._server = server; this._peerId = id; }
            abortAll(reason) { aborted.push(reason); }
            sendJSON(message) { this._send(JSON.stringify(message)); }
            _protocolError(reason) { this.close(reason); }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.RTC = RTCPeer;', context);
    const peer = new context.RTC({ _peerId: 'a', send: msg => { sent.push(msg); return true; } }, 'z');
    const channel = { readyState: 'open', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; } };
    peer._channel = channel; peer._state = 'connected'; peer._path = { direct: true }; peer._verified = true;
    peer._code = 'AABB CCDD EEFF'; peer._remoteHello = true;
    return { peer, conn: peer._conn, context, events, sent, aborted, timers, runTimer(id) {
        const timer = timers.get(id); assert.ok(timer, 'timer exists'); timers.delete(id); timer.fn();
    } };
}

// These fixtures exercise the actual RTCPeer methods, not browser or NAT reachability.
test('ICE failure revokes directness and consent on the non-offerer', () => {
    const h = harness(); h.conn.iceConnectionState = 'failed'; h.peer._onConnectionStateChange();
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false);
    assert.notEqual(h.peer._state, 'connected'); assert.ok(h.aborted.length);
});
test('a pre-disconnect stats result cannot authorize the recovered transport', async () => {
    const h = harness(), pending = deferred(); h.conn.getStats = () => pending.promise;
    const sample = h.peer._samplePath();
    h.conn.iceConnectionState = 'disconnected'; h.peer._onConnectionStateChange();
    h.conn.iceConnectionState = 'connected'; pending.resolve(directStats()); await sample;
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false);
});
test('a late stats success cannot overwrite a terminal failure', async () => {
    const h = harness(), pending = deferred(); h.conn.getStats = () => pending.promise;
    const sample = h.peer._samplePath(); h.peer._fail('deadline');
    pending.resolve(directStats()); await sample;
    assert.equal(h.peer._state, 'failed'); assert.equal(h.peer._reason, 'deadline');
    assert.equal(h.peer._path.direct, false);
});
test('older stats cannot overwrite a newer unverified route', async () => {
    const h = harness(), first = deferred(), second = deferred(); let calls = 0;
    h.conn.getStats = () => (++calls === 1 ? first.promise : second.promise);
    const a = h.peer._samplePath(), b = h.peer._samplePath();
    second.resolve(new Map()); await b; first.resolve(directStats()); await a;
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false);
});
test('a current stats failure revokes previous authorization instead of retaining it', async () => {
    const h = harness(); h.conn.getStats = async () => { throw Error('stats unavailable'); };
    await h.peer._samplePath();
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false); assert.ok(h.aborted.length);
});
test('ICE checking revokes the old route and cancels the in-progress file', () => {
    const h = harness(); h.conn.iceConnectionState = 'checking'; h.peer._onConnectionStateChange();
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false); assert.ok(h.aborted.length);
});
test('DTLS transport failure is not hidden by a connected ICE state', () => {
    const h = harness(); h.conn.connectionState = 'failed'; h.peer._onConnectionStateChange();
    assert.equal(h.peer._state, 'failed'); assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false);
});
test('remote renegotiation invalidates the route before awaiting SDP processing', async () => {
    const h = harness(), pending = deferred(); const original = h.conn.setRemoteDescription.bind(h.conn);
    h.conn.setRemoteDescription = async sdp => { await pending.promise; await original(sdp); };
    h.peer.onServerMessage({ sdp: { type: 'offer', sdp: h.conn.remoteDescription.sdp } });
    await Promise.resolve();
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false); assert.equal(h.peer._code, null);
    pending.resolve(); await h.peer._signalChain;
});
test('a pending fingerprint digest cannot publish after the peer closes', async () => {
    const h = harness(), pending = deferred(); h.context.crypto.subtle.digest = () => pending.promise;
    const code = h.peer._securityCode(); h.peer.close(); const count = h.events.length;
    pending.resolve(new Uint8Array(32).buffer); await code;
    assert.equal(h.events.length, count); assert.equal(h.peer._code, null); assert.equal(h.peer._state, 'closed');
});
test('duplicate failure notifications do not consume separate restart attempts', async () => {
    const h = harness(); h.peer._isCaller = true;
    h.peer.restart(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const deadline = h.peer._deadline; h.peer.restart();
    assert.equal(h.peer._restarts, 1); assert.equal(h.peer._deadline, deadline); assert.equal(h.conn.offers, 1);
    h.conn.signalingState = 'stable'; h.runTimer(deadline); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.peer._restarts, 2);
    h.runTimer(h.peer._deadline); assert.equal(h.peer._state, 'failed');
});
test('fresh remote renegotiation recovers a failed callee without restoring consent', async () => {
    const h = harness(); h.peer._fail('old failure');
    h.peer.onServerMessage({ sdp: { type: 'offer', sdp: h.conn.remoteDescription.sdp } });
    await h.peer._signalChain; await h.peer._samplePath();
    assert.equal(h.peer._state, 'connected'); assert.equal(h.peer._path.direct, true);
    assert.equal(h.peer._verified, false); assert.ok(h.peer._code);
    h.peer.verify(); assert.equal(h.peer._verified, true);
});
test('verify checks current transport health rather than a stale direct flag', () => {
    const h = harness(); h.peer._verified = false; h.conn.iceConnectionState = 'failed';
    h.peer.verify(); assert.equal(h.peer._verified, false);
});
test('a valid current sample records directness but never auto-confirms identity', async () => {
    const h = harness(); h.peer._verified = false; h.peer._state = 'connecting'; h.peer._path = { direct: false };
    await h.peer._samplePath();
    assert.equal(h.peer._path.direct, true); assert.equal(h.peer._state, 'connected'); assert.equal(h.peer._verified, false);
});
test('a currently selected relay is still rejected and closes the peer', async () => {
    const h = harness(); const stats = directStats(); stats.get('local').candidateType = 'relay';
    h.conn.getStats = async () => stats; await h.peer._samplePath();
    assert.equal(h.peer._closed, true); assert.equal(h.peer._path.direct, false);
});
test('stats are not sampled from an SDP negotiation still in progress', async () => {
    const h = harness(); let calls = 0;
    h.peer._negotiating = true; h.conn.getStats = async () => { calls++; return directStats(); };
    await h.peer._samplePath(); assert.equal(calls, 0);
});
test('duplicate callee failures cannot extend the remote recovery deadline', () => {
    const h = harness(); h.conn.iceConnectionState = 'failed'; h.peer._onConnectionStateChange();
    const deadline = h.peer._deadline; h.peer._onConnectionStateChange();
    assert.equal(h.peer._deadline, deadline); h.runTimer(deadline);
    assert.equal(h.peer._state, 'failed'); assert.equal(h.peer._verified, false);
});
test('repeated missing-path samples cannot extend the verification deadline', async () => {
    const h = harness(); h.conn.getStats = async () => new Map();
    await h.peer._samplePath(); const deadline = h.peer._pathWaitTimer;
    assert.ok(deadline); await h.peer._samplePath(); assert.equal(h.peer._pathWaitTimer, deadline);
    h.runTimer(deadline); assert.equal(h.peer._state, 'failed');
});
test('an old fingerprint digest cannot overwrite the code from a newer negotiation', async () => {
    const h = harness(), pending = deferred(); h.context.crypto.subtle.digest = () => pending.promise;
    const old = h.peer._securityCode();
    h.peer._revokePath('connecting', 'new negotiation', true); h.peer._code = '1111 2222 3333';
    pending.resolve(new Uint8Array(32).buffer); await old;
    assert.equal(h.peer._code, '1111 2222 3333'); assert.equal(h.peer._verified, false);
});
test('closing during createOffer prevents a late SDP from entering signaling', async () => {
    const h = harness(), pending = deferred(); h.conn.createOffer = () => pending.promise;
    const offer = h.peer._offer(true); h.peer.close();
    pending.resolve({ type: 'offer', sdp: 'v=0' }); await offer;
    assert.equal(h.sent.length, 0);
});
test('both browser failure callbacks still produce only one outstanding restart', async () => {
    const h = harness(); h.peer._isCaller = true; h.conn.iceConnectionState = 'failed';
    h.peer._onConnectionStateChange(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.peer._onConnectionStateChange();
    assert.equal(h.peer._restarts, 1); assert.equal(h.conn.offers, 1);
    assert.equal(h.peer._path.direct, false); assert.equal(h.peer._verified, false);
});
