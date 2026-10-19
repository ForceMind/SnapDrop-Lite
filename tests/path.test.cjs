'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function load() { const context = { CustomEvent: class { constructor(type, init) { this.type=type; this.detail=init.detail; } }, window: { removeEventListener() {}, dispatchEvent() {}, crypto: { subtle: {} }, ZEYDROP_CONFIG: { enableStun: true, iceServers: [] } }, TransferPeer: class {}, clearTimeout, clearInterval, Events: {fire() {}, off() {}} }; vm.createContext(context); vm.runInContext(fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.path = selectedPath; this.ice = getIceServers; this.RTC = RTCPeer;', context); return context; }
function stats(type, transport = true) { return new Map([['t', { type: 'transport', ...(transport ? { selectedCandidatePairId: 'p' } : {}) }], ['p', { id: 'p', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: .017 }], ['l', { candidateType: type, protocol: 'udp', address: '2001:db8::1' }], ['r', { candidateType: 'host', protocol: 'udp' }]]); }
test('only selected non-relay paths count as direct; nomination alone cannot prove selection', () => { const c = load(); assert.equal(c.path(stats('srflx')).direct, true); assert.equal(c.path(stats('srflx')).rtt, 17); assert.equal(c.path(stats('relay')).status, 'relay'); assert.equal(c.path(stats('host', false)).direct, false); assert.equal(c.path(new Map()).direct, false); });
test('TURN configuration is rejected; STUN can be explicitly disabled', () => { const c = load(); c.window.ZEYDROP_CONFIG.iceServers = [{ urls: 'turn:example.com:3478' }]; assert.throws(() => c.ice(), /TURN/); c.window.ZEYDROP_CONFIG.enableStun = false; assert.equal(c.ice().length, 0); });

test('closing a transport clears previously verified direct status', () => {
    const c = load(); const peer = Object.create(c.RTC.prototype); let closed = 0;
    Object.assign(peer, { _closed:false, _state:'connected', _path:{direct:true}, _verified:true, abortAll(){}, _conn:{close(){closed++;}} });
    peer.close('protocol error'); assert.equal(closed,1); assert.equal(peer._state,'closed'); assert.equal(peer._path.direct,false); assert.equal(peer._verified,false);
});
