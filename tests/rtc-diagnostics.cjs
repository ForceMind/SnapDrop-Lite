'use strict';

// These functions run inside the browser. Keep them closure-free for evaluate /
// addInitScript, and never return raw SDP, ICE strings, addresses or identifiers.
function installRtcTrace() {
    const traces = new WeakMap();
    const original = RTCPeerConnection.prototype.addIceCandidate;
    RTCPeerConnection.prototype.addIceCandidate = async function (...args) {
        let trace = traces.get(this);
        if (!trace) {
            trace = { attempted: 0, applied: 0, failures: [], mdns: 0, mdnsUuidV4: 0, ipv4: 0, ipv6: 0, otherAddress: 0 };
            traces.set(this, trace);
        }
        trace.attempted++;
        const candidate = args[0]?.candidate;
        if (typeof candidate === 'string' && candidate) {
            const address = candidate.trim().split(/\s+/)[4] || '';
            if (/\.local\.?$/i.test(address)) {
                trace.mdns++;
                if (/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.local$/i.test(address)) trace.mdnsUuidV4++;
            }
            else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) trace.ipv4++;
            else if (/^[a-f\d:]+$/i.test(address) && address.includes(':')) trace.ipv6++;
            else trace.otherAddress++;
        }
        try { const result = await original.apply(this, args); trace.applied++; return result; }
        catch (error) {
            const name = ['TypeError','OperationError','InvalidStateError','NotSupportedError',
                'NetworkError','SyntaxError','SecurityError'].includes(error?.name) ? error.name : 'Error';
            if (trace.failures.length < 10) trace.failures.push(name);
            throw error;
        }
    };
    window.__rtcTraceFor = pc => {
        const trace = traces.get(pc);
        return trace ? JSON.parse(JSON.stringify(trace)) : { attempted: 0, applied: 0, failures: [], mdns: 0, mdnsUuidV4: 0, ipv4: 0, ipv6: 0, otherAddress: 0 };
    };
}

async function rtcEndpointSnapshot(engine) {
    const allowed = (value, values) => values.includes(value) ? value : 'unknown';
    const peer = typeof zeydrop === 'undefined' ? null : [...zeydrop.peers.peers.values()][0];
    const pc = window.__primitivePeer || peer?._conn;
    if (!pc) return { engine: allowed(engine, ['chromium','firefox','webkit']), peerPresent: false };
    const sdpSummary = description => {
        if (!description?.sdp) return { present: false, media: [] };
        const sections = description.sdp.split(/\r?\nm=/).slice(1, 5);
        // The first section may itself start with m= if a deliberately malformed
        // fixture omits session lines. Such input is not treated as a valid SDP.
        const sessionLines=description.sdp.split(/\r?\nm=/)[0].split(/\r?\n/);
        return { present: true,
            sessionHasIceUfrag:sessionLines.some(line=>line.startsWith('a=ice-ufrag:')),
            sessionHasIcePwd:sessionLines.some(line=>line.startsWith('a=ice-pwd:')),
            sessionHasSha256Fingerprint:sessionLines.some(line=>/^a=fingerprint:sha-256 /i.test(line)),
            media: sections.map(section => {
            const lines = section.split(/\r?\n/), header = lines[0].split(/\s+/);
            return {
                kind: allowed(header[0], ['application','audio','video']),
                rejected: header[1] === '0',
                protocol: allowed(header[2], ['UDP/DTLS/SCTP','DTLS/SCTP','TCP/DTLS/SCTP','UDP/TLS/RTP/SAVPF']),
                hasMid: lines.some(line => line.startsWith('a=mid:')),
                hasIceUfrag: lines.some(line => line.startsWith('a=ice-ufrag:')),
                hasIcePwd: lines.some(line => line.startsWith('a=ice-pwd:')),
                hasSha256Fingerprint: lines.some(line => /^a=fingerprint:sha-256 /i.test(line)),
                hasSctpPort: lines.some(line => /^a=(sctp-port|sctpmap):/.test(line)),
                candidateLines:lines.filter(line=>line.startsWith('a=candidate:')).length,
                endOfCandidates:lines.includes('a=end-of-candidates'),
                setup: allowed(lines.find(line => line.startsWith('a=setup:'))?.slice(8), ['active','passive','actpass','holdconn'])
            };
        }) };
    };
    let records = [];
    try { records = [...(await pc.getStats()).values()]; } catch {}
    const ice = pc.sctp?.transport?.iceTransport;
    let selected;
    try { selected = ice?.getSelectedCandidatePair?.(); } catch {}
    const kinds = ['host','srflx','prflx','relay'];
    return {
        engine: allowed(engine, ['chromium','firefox','webkit']), peerPresent: true,
        rtc: allowed(pc.connectionState, ['new','connecting','connected','disconnected','failed','closed']),
        ice: allowed(pc.iceConnectionState, ['new','checking','connected','completed','disconnected','failed','closed']),
        gathering: allowed(pc.iceGatheringState, ['new','gathering','complete']),
        signaling: allowed(pc.signalingState, ['stable','have-local-offer','have-remote-offer','have-local-pranswer','have-remote-pranswer','closed']),
        channelState: allowed((window.__primitiveChannel || peer?._channel)?.readyState, ['connecting','open','closing','closed']),
        appDirect: peer?._path?.direct === true,
        codeAvailable: !!peer?._code, remoteHello: peer?._remoteHello === true,
        protocolReady: typeof peer?._protocolReady === 'function' ? peer._protocolReady() === true : peer?._remoteHello === true,
        helloHandshakeTimedOut: peer?._helloTimedOut === true,
        candidateApplication: window.__rtcTraceFor?.(pc) || null,
        sctpPresent: !!pc.sctp,
        dtls: allowed(pc.sctp?.transport?.state, ['new','connecting','connected','closed','failed']),
        iceTransport: allowed(ice?.state, ['new','checking','connected','completed','disconnected','failed','closed']),
        selectedPairAPI: selected ? {
            localType: allowed(selected.local?.type, kinds), remoteType: allowed(selected.remote?.type, kinds),
            localProtocol: allowed(selected.local?.protocol, ['udp','tcp']), remoteProtocol: allowed(selected.remote?.protocol, ['udp','tcp'])
        } : null,
        selectedStatsPresent: records.some(s => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string'),
        succeededPairs: records.filter(s => s.type === 'candidate-pair' && s.state === 'succeeded').length,
        localCandidates: records.filter(s => s.type === 'local-candidate').length,
        remoteCandidates: records.filter(s => s.type === 'remote-candidate').length,
        localSdp: sdpSummary(pc.localDescription), remoteSdp: sdpSummary(pc.remoteDescription)
    };
}

module.exports = { installRtcTrace, rtcEndpointSnapshot };
