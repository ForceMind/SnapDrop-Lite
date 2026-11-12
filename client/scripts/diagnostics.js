'use strict';
// Local, bounded, allowlisted evidence. Never serialize RTCStatsReport / SDP or
// events wholesale: they may contain addresses, credentials and file metadata.
class ConnectionDiagnostics {
    constructor({ version = '', revision = '', now = Date.now } = {}) {
        this.version = /^[\w.+-]{1,40}$/.test(version) ? version : 'unknown';
        this.revision = /^[a-f0-9]{16}$/.test(revision) ? revision : 'development';
        this.now = now; this.events = []; this.peers = new Map(); this.nextPeer = 1;
    }
    _append(event) {
        this.events.push({ at: new Date(this.now()).toISOString(), ...event });
        if (this.events.length > 120) this.events.shift();
    }
    recordSignal(state) {
        if (['connected', 'connecting', 'offline'].includes(state)) this._append({ kind: 'signaling', state });
    }
    recordConnection(info) {
        if (!info || typeof info.peerId !== 'string') return;
        if (!this.peers.has(info.peerId)) {
            if (this.peers.size >= 30) this.peers.delete(this.peers.keys().next().value);
            this.peers.set(info.peerId, this.nextPeer++);
        }
        const allowed = (value, choices) => choices.includes(value) ? value : 'unknown';
        const count = value => Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : 0;
        const path = info.path || {};
        this._append({
            kind: 'connection', peer: this.peers.get(info.peerId),
            state: allowed(info.state, ['connecting', 'connected', 'disconnected', 'failed', 'closed']),
            ready: info.ready === true, identityConfirmed: info.verified === true,
            path: {
                direct: path.direct === true,
                status: allowed(path.status, ['unknown', 'selected', 'relay']),
                protocol: allowed(path.protocol, ['udp', 'tcp']),
                localType: allowed(path.localType, ['host', 'srflx', 'prflx', 'relay']),
                remoteType: allowed(path.remoteType, ['host', 'srflx', 'prflx', 'relay']),
                family: allowed(path.family, ['IPv4', 'IPv6 / 双栈', '地址族未公开']),
                rttMs: Number.isFinite(path.rtt) && path.rtt >= 0 && path.rtt <= 600000 ? Math.round(path.rtt) : null
            },
            candidates: { host: count(info.candidates?.host), srflx: count(info.candidates?.srflx), prflx: count(info.candidates?.prflx) },
            stunErrorObserved: info.stunError === true
        });
    }
    snapshot(capabilities) {
        return {
            schema: 1, product: 'Zeydrop', version: this.version, revision: this.revision,
            exportedAt: new Date(this.now()).toISOString(),
            scope: 'local connection diagnostics; no network-success-rate or file-delivery claim',
            capabilities: {
                secureContext: capabilities?.secureContext === true,
                webRTC: capabilities?.webRTC === true,
                streamingSave: capabilities?.streamingSave === true
            },
            events: this.events.map(event => JSON.parse(JSON.stringify(event)))
        };
    }
}
