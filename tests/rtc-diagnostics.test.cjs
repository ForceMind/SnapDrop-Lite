'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { installRtcTrace, rtcEndpointSnapshot } = require('./rtc-diagnostics.cjs');
test('browser RTC probes retain candidate categories and SDP flags without private raw values', async () => {
    class FakePeer { async addIceCandidate() {} }
    const context = vm.createContext({ window: {}, RTCPeerConnection: FakePeer });
    vm.runInContext('(' + installRtcTrace.toString() + ')()', context);
    const pc = new FakePeer();
    pc.connectionState = 'new'; pc.iceConnectionState = 'new'; pc.iceGatheringState = 'complete'; pc.signalingState = 'stable';
    pc.localDescription = pc.remoteDescription = { sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:SECRET_MID\r\na=ice-ufrag:SECRET_UFRAG\r\na=ice-pwd:SECRET_PWD\r\na=fingerprint:sha-256 SECRET_FINGERPRINT\r\na=setup:active\r\na=sctp-port:5000\r\n' };
    pc.getStats = async () => new Map([['private',{type:'local-candidate',address:'192.0.2.4',candidateType:'host'}]]);
    pc.sctp = { transport: { state:'new', iceTransport: {state:'new', getSelectedCandidatePair:()=>null} } };
    context.window.__primitivePeer = pc;
    await pc.addIceCandidate({candidate:'candidate:PRIVATE 1 udp 1 PRIVATE_HOST.local 12345 typ host'});
    await pc.addIceCandidate({candidate:'candidate:PRIVATE 1 udp 1 192.0.2.4 12345 typ host'});
    await pc.addIceCandidate({candidate:'candidate:PRIVATE 1 udp 1 12345678-1234-4234-8234-123456789abc.local 12345 typ host'});
    const result = await vm.runInContext('(' + rtcEndpointSnapshot.toString() + ')(' + JSON.stringify('webkit') + ')', context);
    const json = JSON.stringify(result);
    assert.ok(!/SECRET|PRIVATE|192\.0\.2|12345/.test(json));
    assert.equal(result.candidateApplication.applied,3); assert.equal(result.candidateApplication.mdns,2); assert.equal(result.candidateApplication.ipv4,1); assert.equal(result.candidateApplication.mdnsUuidV4,1);
    assert.ok(!json.includes('12345678-1234-4234-8234-123456789abc'));
    assert.equal(result.localSdp.media[0].hasSha256Fingerprint,true); assert.equal(result.localSdp.media[0].hasSctpPort,true); assert.equal(result.localSdp.media[0].rejected,false);
});
test('browser RTC probe failure names and unknown SDP tokens are strictly allowlisted', async () => {
    class FakePeer { async addIceCandidate() { const error = Error('SECRET message'); error.name='SECRET_ERROR'; throw error; } }
    const context = vm.createContext({window:{},RTCPeerConnection:FakePeer});
    vm.runInContext('(' + installRtcTrace.toString() + ')()',context);
    const pc=new FakePeer();pc.localDescription={sdp:'v=0\r\nm=SECRET_KIND 0 SECRET_PROTOCOL SECRET_FORMAT\r\na=setup:SECRET_SETUP\r\n'};
    pc.getStats=async()=>new Map();context.window.__primitivePeer=pc;
    await assert.rejects(pc.addIceCandidate({candidate:'SECRET CANDIDATE'}));
    const result=await vm.runInContext('('+rtcEndpointSnapshot.toString()+')()',context);
    assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.localSdp.media[0].rejected,true);
    assert.equal(result.candidateApplication.failures[0],'Error');
});
