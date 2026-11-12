'use strict';
// Actual RTCPeer code with controllable native promise boundaries. These tests
// prove app-generation ownership, not browser timing, WAN or NAT reachability.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const sdp = (type, fragment) => ({ type, sdp: 'v=0\r\na=ice-ufrag:' + fragment
    + '\r\na=fingerprint:sha-256 AA:BB:CC:DD\r\n' });
const directStats = () => new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { candidateType: 'host', protocol: 'udp' }],
    ['remote', { candidateType: 'srflx', protocol: 'udp' }]
]);
function fixture() {
    const timers = new Map(), events = [], sent = [], retired = [], offers = [];
    let sequence = 0;
    const schedule = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; };
    const target = Object.assign(new EventTarget(), { RTCPeerConnection: function () {},
        crypto: webcrypto, ZEYDROP_CONFIG: { enableStun: false } });
    target.addEventListener('connection-state', event => events.push(event.detail));
    class Connection {
        constructor() {
            this.signalingState = 'stable'; this.iceConnectionState = 'connected'; this.connectionState = 'connected';
            this.localDescription = sdp('answer', 'initial-local'); this.remoteDescription = sdp('offer', 'initial-remote');
        }
        async getStats() { return directStats(); }
        async createOffer() { return sdp('offer', 'default-local'); }
        async createAnswer() { return sdp('answer', 'default-local'); }
        async setLocalDescription(value) { this.localDescription = value; this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable'; }
        async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable'; }
        async addIceCandidate() {}
        close() { this.connectionState = this.iceConnectionState = 'closed'; }
    }
    const context = vm.createContext({ window: target, CustomEvent, TextEncoder, crypto: webcrypto,
        RTCPeerConnection: Connection, hex: bytes => Buffer.from(bytes).toString('hex'),
        setTimeout: schedule, setInterval: schedule,
        clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
        TransferPeer: class {
            constructor(server, id) { this._server = server; this._peerId = id; }
            abortAll(reason) { retired.push(reason); }
            sendJSON(value) { this._send(JSON.stringify(value)); }
            _protocolError(reason) { this.close(reason); }
        }
    });
    vm.runInContext(fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.RTC = RTCPeer;', context);
    const originalOffer = context.RTC.prototype._offer;
    context.RTC.prototype._offer = function(...args) {
        const operation = originalOffer.apply(this, args); offers.push(operation); return operation;
    };
    // Begin as callee to avoid a constructor offer, then explicitly exercise
    // the production offerer restart/deadline methods from a healthy old path.
    const peer = new context.RTC({ _peerId: 'a', send: value => { sent.push(value); return true; } }, 'z');
    peer._isCaller = true;
    peer._channel = { readyState: 'open', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; } };
    peer._state = 'connected'; peer._path = { direct: true }; peer._verified = true;
    peer._code = 'AABB CCDD EEFF'; peer._remoteHello = true;
    return { peer, conn: peer._conn, context, timers, events, sent, retired, offers,
        runDeadline() { const id = peer._deadline, value = timers.get(id); assert.equal(value.ms, 20000); timers.delete(id); value.fn(); },
        cleanup() { peer.close(); }
    };
}
async function establishCurrent(h, fragment = 'fresh-remote') {
    h.peer.onServerMessage({ sdp: sdp('answer', fragment) }); await h.peer._signalChain;
    assert.equal(h.peer._state, 'connected'); assert.equal(h.peer._path.direct, true);
    assert.ok(h.peer._code); assert.equal(h.peer._verified, false, 'a fresh path must still require manual confirmation');
    h.peer.verify(); assert.equal(h.peer._verified, true);
}

for (const boundary of ['createOffer', 'setLocalDescription']) for (const outcome of ['reject', 'resolve']) {
    test('obsolete ' + boundary + ' ' + outcome + ' cannot change the successfully recovered generation', async () => {
        const h = fixture(), old = deferred(), entered = deferred(), first = sdp('offer', 'obsolete-local'), fresh = sdp('offer', 'fresh-local');
        let calls = 0;
        if (boundary === 'createOffer') h.conn.createOffer = () => ++calls === 1 ? old.promise : Promise.resolve(fresh);
        else {
            h.conn.createOffer = async () => ++calls === 1 ? first : fresh;
            const local = h.conn.setLocalDescription.bind(h.conn);
            h.conn.setLocalDescription = async value => {
                if (value === first) { entered.resolve(); await old.promise; }
                await local(value);
            };
        }
        try {
            h.peer.restart();
            if (boundary === 'setLocalDescription') await entered.promise;
            h.runDeadline(); // The actual first attempt's 20 s callback starts the next attempt.
            await h.offers[1]; await establishCurrent(h);
            const before = { code: h.peer._code, events: h.events.length, retired: h.retired.length,
                sent: h.sent.length, state: h.peer._state, verified: h.peer._verified, direct: h.peer._path.direct };
            if (outcome === 'reject') old.reject(Error('obsolete native operation failed'));
            else old.resolve(first);
            await h.offers[0];
            assert.deepEqual({ code: h.peer._code, events: h.events.length, retired: h.retired.length,
                sent: h.sent.length, state: h.peer._state, verified: h.peer._verified, direct: h.peer._path.direct }, before,
                'old native completion must neither signal stale SDP nor retire/publish the current app generation');
            assert.equal(h.sent.filter(value => value.sdp?.sdp.includes('obsolete-local')).length, 0);
        } finally { h.cleanup(); }
    });
}

for (const outcome of ['resolve', 'reject']) test('old answer ICE flush ' + outcome + ' leaves a newer restart pending until its own answer', async () => {
    const h = fixture(), entered = deferred(), add = deferred(), offer = deferred();
    const oldIce = { candidate: 'candidate:old', usernameFragment: 'old-remote' };
    const futureIce = { candidate: 'candidate:future', usernameFragment: 'fresh-remote' }, added = [];
    h.conn.remoteDescription = null;
    await h.peer._acceptRemoteIce(oldIce); await h.peer._acceptRemoteIce(futureIce);
    h.conn.addIceCandidate = async value => { added.push(value); if (value === oldIce) { entered.resolve(); await add.promise; } };
    try {
        h.peer.onServerMessage({ sdp: sdp('answer', 'old-remote') }); await entered.promise;
        h.conn.createOffer = () => offer.promise; h.peer.restart();
        const deadline = h.peer._deadline, events = h.events.length;
        if (outcome === 'reject') add.reject(Error('old ICE application failed late'));
        else add.resolve();
        await h.peer._signalChain;
        assert.equal(h.peer._state, 'connecting'); assert.equal(h.peer._negotiating, true);
        assert.equal(h.peer._restartPending, true); assert.equal(h.peer._path.direct, false);
        assert.equal(h.peer._code, null); assert.equal(h.peer._verified, false);
        assert.equal(h.peer._deadline, deadline); assert.ok(h.timers.has(deadline));
        assert.equal(h.events.length, events, 'retired signaling must not advertise a fresh path or emit a terminal failure');
        offer.resolve(sdp('offer', 'fresh-local')); await h.offers[0];
        // The already buffered new ufrag must survive without retransmission.
        assert.ok(h.peer._pendingIce.some(item => item.ice === futureIce));
        await establishCurrent(h);
        assert.ok(added.includes(futureIce)); assert.equal(h.peer._pendingIce.length, 0);
    } finally { h.cleanup(); }
});

test('an old addIceCandidate rejection cannot poison the queued answer for the next restart', async () => {
    const h = fixture(), entered = deferred(), add = deferred(), offer = deferred();
    h.conn.addIceCandidate = () => { entered.resolve(); return add.promise; };
    try {
        h.peer.onServerMessage({ ice: { candidate: 'candidate:old', usernameFragment: 'initial-remote' } }); await entered.promise;
        h.conn.createOffer = () => offer.promise; h.peer.restart();
        add.reject(Error('obsolete candidate application failed')); await h.peer._signalChain;
        assert.equal(h.peer._state, 'connecting'); assert.equal(h.peer._negotiating, true);
        offer.resolve(sdp('offer', 'fresh-local')); await h.offers[0];
        await establishCurrent(h);
    } finally { h.cleanup(); }
});

test('an old remote-description completion cannot publish its code or consume the next restart deadline', async () => {
    const h = fixture(), entered = deferred(), remote = deferred(), offer = deferred();
    const apply = h.conn.setRemoteDescription.bind(h.conn);
    h.conn.setRemoteDescription = async value => { if (value.sdp.includes('old-remote')) { entered.resolve(); await remote.promise; } await apply(value); };
    try {
        h.peer.onServerMessage({ sdp: sdp('answer', 'old-remote') }); await entered.promise;
        h.conn.createOffer = () => offer.promise; h.peer.restart(); const deadline = h.peer._deadline;
        remote.resolve(); await h.peer._signalChain;
        assert.equal(h.peer._negotiating, true); assert.equal(h.peer._restartPending, true);
        assert.equal(h.peer._path.direct, false); assert.equal(h.peer._code, null);
        assert.equal(h.peer._deadline, deadline); assert.ok(h.timers.has(deadline));
        offer.resolve(sdp('offer', 'fresh-local')); await h.offers[0]; await establishCurrent(h);
    } finally { h.cleanup(); }
});

for (const boundary of ['createOffer', 'setLocalDescription']) test('a current ' + boundary + ' failure still fails closed', async () => {
    const h = fixture(); h.conn[boundary] = async () => { throw Error('current native failure'); };
    try {
        h.peer.restart(); await h.offers[0];
        assert.equal(h.peer._state, 'failed'); assert.equal(h.peer._path.direct, false);
        assert.equal(h.peer._verified, false); assert.equal(h.peer._code, null);
        assert.equal(h.peer._reason, 'current native failure');
    } finally { h.cleanup(); }
});

test('a current ICE application failure still fails the negotiation rather than bypassing validation', async () => {
    const h = fixture(); h.conn.addIceCandidate = async () => { throw Error('current ICE failure'); };
    try {
        h.peer.onServerMessage({ ice: { candidate: 'candidate:current', usernameFragment: 'initial-remote' } });
        await h.peer._signalChain;
        assert.equal(h.peer._state, 'failed'); assert.equal(h.peer._path.direct, false);
        assert.equal(h.peer._verified, false); assert.match(h.peer._reason, /current ICE failure/);
    } finally { h.cleanup(); }
});

for (const outcome of ['resolve', 'reject']) test('a closed peer never regains an old flush batch after native ' + outcome, async () => {
    const h = fixture(), entered = deferred(), add = deferred();
    h.conn.remoteDescription = null;
    await h.peer._acceptRemoteIce({ candidate: 'candidate:old', usernameFragment: 'old-remote' });
    await h.peer._acceptRemoteIce({ candidate: 'candidate:future', usernameFragment: 'fresh-remote' });
    h.conn.addIceCandidate = () => { entered.resolve(); return add.promise; };
    h.peer.onServerMessage({ sdp: sdp('answer', 'old-remote') }); await entered.promise;
    h.peer.close(); const eventCount = h.events.length;
    if (outcome === 'resolve') add.resolve(); else add.reject(Error('closed native operation failed'));
    await h.peer._signalChain;
    assert.equal(h.peer._pendingIce.length, 0, 'retired native work must not resurrect queued candidate references');
    assert.equal(h.peer._state, 'closed'); assert.equal(h.peer._code, null); assert.equal(h.peer._path.direct, false);
    assert.equal(h.events.length, eventCount); assert.equal(h.timers.size, 0);
});

test('a failed callee still retains early next-generation ICE until its new offer arrives', async () => {
    const h = fixture(), added = [];
    h.peer._isCaller = false; h.conn.addIceCandidate = async value => added.push(value);
    const future = { candidate: 'candidate:future', usernameFragment: 'fresh-remote' };
    try {
        h.peer._fail('previous negotiation expired');
        h.peer.onServerMessage({ ice: future }); await h.peer._signalChain;
        assert.equal(h.peer._state, 'failed'); assert.equal(h.peer._path.direct, false);
        assert.equal(h.peer._code, null); assert.equal(h.peer._verified, false);
        assert.equal(h.peer._pendingIce.length, 1); assert.equal(added.length, 0);
        h.peer.onServerMessage({ sdp: sdp('offer', 'fresh-remote') }); await h.peer._signalChain;
        assert.equal(added.length, 1); assert.equal(added[0], future); assert.equal(h.peer._pendingIce.length, 0);
        assert.equal(h.peer._state, 'connected'); assert.equal(h.peer._path.direct, true);
        assert.equal(h.peer._verified, false); assert.ok(h.peer._code);
    } finally { h.cleanup(); }
});
