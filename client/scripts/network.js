'use strict';
window.isRtcSupported = !!window.RTCPeerConnection && !!window.crypto?.subtle;
class Events {
    static fire(type, detail) { window.dispatchEvent(new CustomEvent(type, { detail })); }
    static on(type, callback) { window.addEventListener(type, callback); }
    static off(type, callback) { window.removeEventListener(type, callback); }
}
function getIceServers() {
    if (!window.ZEYDROP_CONFIG?.enableStun) return [];
    return (window.ZEYDROP_CONFIG.iceServers || []).slice(0, 4).map(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        if (!urls.length || urls.some(url => typeof url !== 'string' || !/^stun:[a-z0-9.:[\]-]+(?::\d+)?$/i.test(url))) throw Error('Zeydrop 只允许 STUN 地址，不支持 TURN 中继');
        return { urls };
    });
}
function selectedPath(stats) {
    let pair;
    for (const stat of stats.values()) if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
    if (!pair) pair = [...stats.values()].find(stat => stat.type === 'candidate-pair' && stat.selected && stat.state === 'succeeded');
    if (!pair || pair.state !== 'succeeded') return { direct: false, status: 'unknown' };
    const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
    if (!local || !remote) return { direct: false, status: 'unknown' };
    if ([local.candidateType, remote.candidateType].includes('relay')) return { direct: false, status: 'relay' };
    const known = ['host', 'srflx', 'prflx'];
    const protocol = local.protocol || remote.protocol || 'unknown';
    // Never guess a selected route from a merely nominated candidate pair.
    return {
        direct: known.includes(local.candidateType) && known.includes(remote.candidateType) && ['udp', 'tcp'].includes(protocol),
        status: 'selected', protocol, localType: local.candidateType, remoteType: remote.candidateType,
        family: [local.address || local.ip, remote.address || remote.ip].some(address => address?.includes(':')) ? 'IPv6 / 双栈' : [local.address || local.ip, remote.address || remote.ip].some(address => /^\d+\.\d+\.\d+\.\d+$/.test(address || '')) ? 'IPv4' : '地址族未公开',
        rtt: Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null
    };
}
class ServerConnection {
    constructor() {
        this._desiredRoomId = null; this._peerId = null; this._resumeToken = null;
        this._closing = false; this._attempt = 0; this._ready = false;
        this._connect();
        Events.on('online', () => this._connect());
        Events.on('pagehide', event => { if (!event.persisted) this._disconnect(); });
        Events.on('pageshow', event => { if (event.persisted) { this._closing = false; this._connect(); } });
    }
    _connect() {
        if (this._closing || (this._socket && this._socket.readyState < 2)) return;
        clearTimeout(this._retry); this._ready = false;
        Events.fire('signal-state', { state: 'connecting' });
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host + '/server/webrtc');
        this._socket = ws;
        ws.onopen = () => this.send({ type: 'hello', ...(this._resumeToken ? { resumeToken: this._resumeToken } : {}) });
        ws.onmessage = event => { if (this._socket === ws) this._onMessage(event.data); };
        ws.onerror = () => {};
        ws.onclose = () => {
            if (this._socket !== ws) return;
            this._ready = false; this._socket = null;
            Events.fire('signal-state', { state: 'offline' });
            // Pairing must be revalidated; old peers must not survive a new WS session.
            Events.fire('peers', []);
            if (!this._closing) this._retry = setTimeout(() => this._connect(), Math.min(1000 * 2 ** this._attempt++, 15000) + Math.random() * 500);
        };
    }
    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') {
            this._peerId = msg.peerId; this._resumeToken = msg.resumeToken; this._ready = true; this._attempt = 0;
            Events.fire('display-name', { message: { deviceName: msg.deviceName } });
            Events.fire('signal-state', { state: 'connected' });
            if (this._desiredRoomId) this.send({ type: this._desiredType || 'join-room', roomId: this._desiredRoomId });
        } else if (msg.type === 'ping') this.send({ type: 'pong' });
        else if (msg.type === 'room-joined') { this._desiredType = 'join-room'; Events.fire(msg.type, msg); }
        else if (msg.type === 'room-error') {
            if (['expired', 'missing', 'invalid', 'exists'].includes(msg.code)) this._desiredRoomId = null;
            Events.fire(msg.type, msg);
        } else if (msg.type === 'room-expired') { this._desiredRoomId = null; Events.fire('room-expired', msg); }
        else if (msg.type === 'peer-left') Events.fire('peer-left', msg.peerId);
        else if (msg.type === 'peer-joined') Events.fire('peer-joined', msg.peer);
        else if (msg.type === 'peers') Events.fire('peers', msg.peers || []);
        else if (msg.type === 'signal') Events.fire('signal', msg);
    }
    send(message) {
        if (this._socket?.readyState !== WebSocket.OPEN) return false;
        this._socket.send(JSON.stringify(message)); return true;
    }
    joinRoom(roomId, create = false) {
        if (!/^[a-f0-9]{32}$/.test(roomId)) return false;
        if (this._desiredRoomId && this._desiredRoomId !== roomId) { this.send({ type: 'leave-room' }); Events.fire('peers', []); }
        this._desiredRoomId = roomId; this._desiredType = create ? 'create-room' : 'join-room';
        if (this._ready) this.send({ type: this._desiredType, roomId });
        return true;
    }
    leaveRoom() { this._desiredRoomId = null; this._desiredType = null; this.send({ type: 'leave-room' }); Events.fire('peers', []); }
    _disconnect() { this._closing = true; clearTimeout(this._retry); this._socket?.close(); }
}
class RTCPeer extends TransferPeer {
    constructor(server, peerId) {
        super(server, peerId);
        this._isCaller = server._peerId > peerId; this._closed = false; this._restarts = 0;
        this._state = 'connecting'; this._path = { direct: false }; this._candidateCounts = { host: 0, srflx: 0, prflx: 0 };
        this._signalChain = Promise.resolve(); this._pendingIce = [];
        this._conn = new RTCPeerConnection({ iceServers: getIceServers(), iceTransportPolicy: 'all' });
        this._conn.onicecandidate = event => {
            if (!event.candidate) return;
            const type = event.candidate.type || (event.candidate.candidate.match(/ typ (\w+)/) || [])[1];
            if (type === 'relay') return this._protocolError('检测到中继候选，已停止连接');
            if (type in this._candidateCounts) this._candidateCounts[type]++;
            this._server.send({ type: 'signal', to: peerId, ice: event.candidate.toJSON() });
        };
        this._conn.onicecandidateerror = () => { this._stunError = true; this._connectionEvent(); };
        this._conn.onconnectionstatechange = () => this._onConnectionStateChange();
        this._conn.oniceconnectionstatechange = () => this._onConnectionStateChange();
        this._conn.ondatachannel = event => {
            if ((this._channel && this._channel.readyState !== 'closed') || event.channel.label !== 'zeydrop-v2' || !event.channel.ordered || event.channel.maxRetransmits !== null || event.channel.maxPacketLifeTime !== null) return event.channel.close();
            this._bindChannel(event.channel);
        };
        if (this._isCaller) {
            this._bindChannel(this._conn.createDataChannel('zeydrop-v2', { ordered: true }));
            this._offer(false);
        }
        this._deadline = setTimeout(() => this._fail('直连超时。请尝试另一网络、启用 IPv6 或关闭阻止 UDP 的防火墙。严格 NAT 可能无法直连。'), 30000);
        this._online = () => this.restart(); Events.on('online', this._online);
        this._connectionEvent();
    }
    async _offer(restart) {
        try {
            if (this._closed || this._conn.signalingState !== 'stable') return;
            const offer = await this._conn.createOffer({ iceRestart: restart });
            await this._conn.setLocalDescription(offer);
            this._server.send({ type: 'signal', to: this._peerId, sdp: { type: offer.type, sdp: offer.sdp } });
        } catch (error) { if (!this._closed) this._fail(error.message); }
    }
    onServerMessage(msg) {
        this._signalChain = this._signalChain.then(async () => {
            if (this._closed) return;
            if (msg.sdp) {
                if (msg.sdp.type === 'offer' && this._isCaller) return; // Deterministic single offerer.
                if (msg.sdp.type === 'offer' && this._conn.remoteDescription) {
                    this.abortAll('连接正在重新协商，请在重连后重新选择文件');
                    this._verified = false;
                }
                await this._conn.setRemoteDescription(msg.sdp);
                if (msg.sdp.type === 'offer') {
                    const answer = await this._conn.createAnswer(); await this._conn.setLocalDescription(answer);
                    this._server.send({ type: 'signal', to: this._peerId, sdp: { type: answer.type, sdp: answer.sdp } });
                }
                for (const ice of this._pendingIce.splice(0)) await this._conn.addIceCandidate(ice);
                await this._securityCode();
            } else if (msg.ice) {
                if (this._conn.remoteDescription) await this._conn.addIceCandidate(msg.ice);
                else if (this._pendingIce.length < 64) this._pendingIce.push(msg.ice);
            }
        }).catch(error => { if (!this._closed) this._fail('连接协商失败：' + error.message); });
    }
    async _securityCode() {
        const sdps = [this._conn.localDescription?.sdp, this._conn.remoteDescription?.sdp];
        const fingerprints = sdps.map(sdp => (sdp?.match(/a=fingerprint:sha-256 ([A-Fa-f0-9:]+)/) || [])[1]);
        if (fingerprints.some(value => !value)) return;
        const bytes = new TextEncoder().encode(fingerprints.map(v => v.toUpperCase()).sort().join('|'));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        this._code = hex(digest).slice(0, 12).toUpperCase().match(/.{4}/g).join(' ');
        this._connectionEvent();
    }
    verify() {
        if (!this._code || !this._path.direct || !this._remoteHello) return;
        this._verified = true; this._connectionEvent();
    }
    _bindChannel(channel) {
        this._channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 128 * 1024;
        channel.onopen = () => {
            this.sendJSON({ type: 'hello', version: 2 });
            this._statsTimer = setInterval(() => this._samplePath(), 2000);
            this._samplePath(); this._securityCode();
        };
        channel.onmessage = event => this._receive(event.data);
        channel.onclose = () => { if (!this._closed) this._fail('文件通道已断开，请重试连接后重新选择文件'); };
        channel.onerror = () => { if (!this._closed) this._fail('文件通道发生错误'); };
    }
    _send(data) {
        if (!this._isConnected()) throw Error('文件通道尚未就绪');
        if (this._channel.bufferedAmount + (typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength) > 1024 * 1024) throw Error('发送缓冲超限');
        this._channel.send(data);
    }
    async _waitForDrain() {
        if (!this._isConnected()) throw Error('文件通道已断开');
        if (this._channel.bufferedAmount <= 256 * 1024) return;
        const channel = this._channel;
        await new Promise((resolve, reject) => {
            const done = error => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', low); channel.removeEventListener('close', closed); error ? reject(error) : resolve(); };
            const low = () => done(); const closed = () => done(Error('文件通道已关闭'));
            const timer = setTimeout(() => done(Error('发送背压等待超时')), 30000);
            channel.addEventListener('bufferedamountlow', low, { once: true }); channel.addEventListener('close', closed, { once: true });
            if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) done();
        });
    }
    async _samplePath() {
        const conn = this._conn;
        if (this._closed || !conn || !this._isConnected()) return;
        if (!['connected', 'completed'].includes(conn.iceConnectionState)) { this._path = { direct: false }; this._connectionEvent(); return; }
        try {
            const path = selectedPath(await conn.getStats());
            if (this._closed || conn !== this._conn) return;
            if (path.status === 'relay') return this._protocolError('检测到中继路径，已停止连接');
            this._path = path;
            if (path.direct) { this._reason = null; this._state = 'connected'; clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); }
            this._connectionEvent();
        } catch { this._connectionEvent(); }
    }
    _onConnectionStateChange() {
        if (this._closed) return;
        const state = this._conn.iceConnectionState;
        if (['connected', 'completed'].includes(state)) { clearTimeout(this._disconnectTimer); this._samplePath(); }
        else if (state === 'disconnected') {
            this.abortAll('网络中断，当前传输已停止，请重连后重新选择文件');
            this._state = 'disconnected'; this._path = { direct: false }; this._verified = false;
            clearTimeout(this._disconnectTimer); this._disconnectTimer = setTimeout(() => this.restart(), 5000); this._connectionEvent();
        } else if (state === 'failed') this.restart();
    }
    restart(manual = false) {
        if (this._closed || !this._isCaller) return;
        if (!manual && this._restartPending) return;
        if (manual) this._restarts = 0;
        if (this._restarts++ >= 2) return this._fail('无法建立直连。请尝试更换网络或启用 IPv6；此服务不会切换到文件中继。');
        this._reason = null; this._restartPending = true;
        if (this._channel?.readyState === 'closed') this._bindChannel(this._conn.createDataChannel('zeydrop-v2', { ordered: true }));
        clearInterval(this._statsTimer); this._statsTimer = setInterval(() => this._samplePath(), 2000);
        this._verified = false; this._path = { direct: false }; this._state = 'connecting';
        this.abortAll('网络变化，当前文件已停止；连接恢复后请重新选择文件');
        this._connectionEvent();
        this._offer(true).finally(() => { this._restartPending = false; });
        clearTimeout(this._deadline); this._deadline = setTimeout(() => this.restart(), 20000);
    }
    _fail(reason) {
        this._state = 'failed'; this._path = { direct: false }; this._verified = false;
        this.abortAll(reason); clearInterval(this._statsTimer); clearTimeout(this._deadline); clearTimeout(this._disconnectTimer);
        this._reason = reason; this._connectionEvent();
    }
    _connectionEvent() { Events.fire('connection-state', { peerId: this._peerId, state: this._state, path: this._path, verified: this._verified, code: this._code, ready: this._remoteHello, candidates: this._candidateCounts, stunError: this._stunError, reason: this._reason }); }
    _isConnected() { return !this._closed && this._channel?.readyState === 'open'; }
    close(reason = '连接已关闭，文件未完成') {
        if (this._closed) return;
        this._closed = true; this._state = 'closed'; this._path = { direct: false }; this._verified = false; this._reason = reason;
        this.abortAll(reason);
        clearInterval(this._statsTimer); clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); Events.off('online', this._online);
        if (this._channel) { this._channel.onmessage = null; this._channel.onclose = null; this._channel.onerror = null; this._channel.close(); }
        this._conn.close(); this._connectionEvent();
    }
}
class PeersManager {
    constructor(server) {
        this.peers = new Map(); this._server = server;
        Events.on('peers', event => {
            const ids = new Set(event.detail.map(peer => peer.id));
            for (const id of this.peers.keys()) if (!ids.has(id)) this._remove(id);
            event.detail.forEach(peer => this._ensure(peer));
        });
        Events.on('peer-joined', event => this._ensure(event.detail));
        Events.on('peer-left', event => this._remove(event.detail));
        Events.on('signal', event => this.peers.get(event.detail.sender)?.onServerMessage(event.detail));
        Events.on('files-selected', event => this.peers.get(event.detail.to)?.sendFiles(event.detail.files));
        Events.on('send-text', event => this.peers.get(event.detail.to)?.sendText(event.detail.text));
        Events.on('file-accepted', event => this.peers.get(event.detail.from)?.acceptIncoming(event.detail.id));
        Events.on('file-rejected', event => this.peers.get(event.detail.from)?.rejectIncoming(event.detail.id));
        Events.on('file-saved', event => { const peer = this.peers.get(event.detail.sender); if (peer?._isConnected()) peer.sendJSON({ type: 'ready-next', id: event.detail.id }); });
        Events.on('verify-peer', event => this.peers.get(event.detail)?.verify());
        Events.on('transfer-control', event => {
            const { peerId, id, action } = event.detail; const peer = this.peers.get(peerId);
            if (action === 'cancel') peer?.cancel(id); else peer?.pause(id, action === 'pause');
        });
        Events.on('retry-peer', event => {
            const old = this.peers.get(event.detail);
            if (old?._closed) { Events.fire('notify-user', '此连接已结束，请创建新邀请重新配对并核对安全码'); return; }
            if (old) { old.restart(true); Events.fire('notify-user', old._isCaller ? '正在重新协商直连' : '请让另一台设备点击重试，或创建新邀请'); }
        });
    }
    _ensure(peer) { if (peer?.id && !this.peers.has(peer.id) && window.isRtcSupported) this.peers.set(peer.id, new RTCPeer(this._server, peer.id)); }
    _remove(id) { this.peers.get(id)?.close(); this.peers.delete(id); }
}
