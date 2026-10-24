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
            // Suspend only within this page; a new server identity drops the checkpoint.
            Events.fire('peer-session-paused');
            Events.fire('peers', []);
            if (!this._closing) this._retry = setTimeout(() => this._connect(), Math.min(1000 * 2 ** this._attempt++, 15000) + Math.random() * 500);
        };
    }
    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') {
            if (this._peerId && this._peerId !== msg.peerId) Events.fire('resume-clear', '服务端身份已变更，不能续传旧会话');
            this._peerId = msg.peerId; this._resumeToken = msg.resumeToken; this._ready = true; this._attempt = 0;
            Events.fire('display-name', { message: { deviceName: msg.deviceName } });
            Events.fire('signal-state', { state: 'connected' });
            if (this._desiredRoomId) this.send({ type: this._desiredType || 'join-room', roomId: this._desiredRoomId });
        } else if (msg.type === 'ping') this.send({ type: 'pong' });
        else if (msg.type === 'room-joined') { this._desiredType = 'join-room'; Events.fire(msg.type, msg); }
        else if (msg.type === 'room-error') {
            if (['expired', 'missing', 'invalid', 'exists'].includes(msg.code)) {
                this._desiredRoomId = null;
                Events.fire('resume-clear', '房间不再有效，不能续传旧文件');
            }
            Events.fire(msg.type, msg);
        } else if (msg.type === 'room-expired') {
            this._desiredRoomId = null;
            Events.fire('resume-clear', '会话过期，不能续传');
            Events.fire('room-expired', msg);
        }
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
        if (this._desiredRoomId && this._desiredRoomId !== roomId) {
            Events.fire('resume-clear', '切换邀请后不能续传旧会话');
            this.send({ type: 'leave-room' }); Events.fire('peers', []);
        }
        this._desiredRoomId = roomId; this._desiredType = create ? 'create-room' : 'join-room';
        if (this._ready) this.send({ type: this._desiredType, roomId });
        return true;
    }
    leaveRoom() {
        Events.fire('resume-clear', '主动退出会话，已丢弃未完成文件');
        this._desiredRoomId = null; this._desiredType = null;
        this.send({ type: 'leave-room' }); Events.fire('peers', []);
    }
    _disconnect() { this._closing = true; clearTimeout(this._retry); this._socket?.close(); }
}
class RTCPeer extends TransferPeer {
    constructor(server, peerId) {
        super(server, peerId);
        this._isCaller = server._peerId > peerId; this._closed = false; this._restarts = 0;
        this._state = 'connecting'; this._path = { direct: false }; this._candidateCounts = { host: 0, srflx: 0, prflx: 0 };
        this._signalChain = Promise.resolve(); this._pendingIce = [];
        this._pathEpoch = 0; this._statsRequest = 0; this._identityEpoch = 0; this._negotiating = false;
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
            this._negotiating = true;
            const offer = await this._conn.createOffer({ iceRestart: restart });
            if (this._closed || this._state === 'failed') return;
            await this._conn.setLocalDescription(offer);
            if (this._closed || this._state === 'failed') return;
            this._server.send({ type: 'signal', to: this._peerId, sdp: { type: offer.type, sdp: offer.sdp } });
        } catch (error) { if (!this._closed) this._fail(error.message); }
    }
    onServerMessage(msg) {
        this._signalChain = this._signalChain.then(async () => {
            if (this._closed) return;
            if (msg.sdp) {
                if (msg.sdp.type === 'offer' && this._isCaller) return; // Deterministic single offerer.
                if (msg.sdp.type === 'offer') {
                    this._revokePath('connecting', '连接正在重新协商，请在重连后重新选择文件', true);
                    this._reason = null; this._waitingForRemote = false;
                    clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); clearTimeout(this._pathWaitTimer);
                    this._disconnectTimer = null; this._pathWaitTimer = null;
                    this._deadline = setTimeout(() => this._fail('重新协商直连超时，请重试或创建新邀请'), 30000);
                    clearInterval(this._statsTimer);
                    if (this._isConnected()) this._statsTimer = setInterval(() => this._samplePath(), 2000);
                    this._connectionEvent();
                }
                this._negotiating = true;
                await this._conn.setRemoteDescription(msg.sdp);
                if (this._closed || this._state === 'failed') return;
                if (msg.sdp.type === 'offer') {
                    const answer = await this._conn.createAnswer();
                    if (this._closed || this._state === 'failed') return;
                    await this._conn.setLocalDescription(answer);
                    if (this._closed || this._state === 'failed') return;
                    this._server.send({ type: 'signal', to: this._peerId, sdp: { type: answer.type, sdp: answer.sdp } });
                }
                for (const ice of this._pendingIce.splice(0)) await this._conn.addIceCandidate(ice);
                this._negotiating = false;
                await this._securityCode();
                await this._samplePath();
            } else if (msg.ice) {
                if (this._conn.remoteDescription) await this._conn.addIceCandidate(msg.ice);
                else if (this._pendingIce.length < 64) this._pendingIce.push(msg.ice);
            }
        }).catch(error => { if (!this._closed) this._fail('连接协商失败：' + error.message); });
    }
    async _securityCode() {
        const conn = this._conn, epoch = this._identityEpoch;
        const sdps = [conn.localDescription?.sdp, conn.remoteDescription?.sdp];
        const fingerprints = sdps.map(sdp => (sdp?.match(/a=fingerprint:sha-256 ([A-Fa-f0-9:]+)/) || [])[1]);
        if (fingerprints.some(value => !value)) return;
        const bytes = new TextEncoder().encode(fingerprints.map(v => v.toUpperCase()).sort().join('|'));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        if (this._closed || this._state === 'failed' || conn !== this._conn || epoch !== this._identityEpoch
            || conn.localDescription?.sdp !== sdps[0] || conn.remoteDescription?.sdp !== sdps[1]) return;
        this._code = hex(digest).slice(0, 12).toUpperCase().match(/.{4}/g).join(' ');
        this._connectionEvent();
    }
    verify() {
        if (!this._code || !this._path.direct || !this._remoteHello || !this._canInspectPath()) return;
        this._verified = true; this._connectionEvent();
        this.restoreTransfers?.();
    }
    _bindChannel(channel) {
        this._remoteHello = false;
        this._channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 128 * 1024;
        channel.onopen = () => {
            if (this._closed || this._channel !== channel) return;
            this.sendJSON({ type: 'hello', version: 2 });
            clearInterval(this._statsTimer); this._statsTimer = setInterval(() => this._samplePath(), 2000);
            this._samplePath(); this._securityCode();
        };
        channel.onmessage = event => this._receive(event.data);
        channel.onclose = () => {
            if (this._closed || this._state === 'failed' || this._channel !== channel) return;
            this._revokePath('disconnected', '文件通道断开，正在尝试恢复未完成文件', true);
            this._connectionEvent();
            if (this._isCaller) this.restart();
            else this._waitForRemoteRestart();
        };
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
    _canInspectPath() {
        return !this._closed && this._state !== 'failed' && !this._negotiating && this._isConnected()
            && this._conn?.signalingState === 'stable'
            && ['connected', 'completed'].includes(this._conn.iceConnectionState)
            && !['failed', 'disconnected', 'closed'].includes(this._conn.connectionState);
    }
    _revokePath(state, reason, resetIdentity = false) {
        // Invalidate every outstanding stats request before aborting asynchronous file work.
        this._pathEpoch = (this._pathEpoch || 0) + 1;
        this._state = state; this._path = { direct: false }; this._verified = false;
        if (resetIdentity) { this._identityEpoch = (this._identityEpoch || 0) + 1; this._code = null; }
        if (reason) {
            // Transient loss retains a bounded local checkpoint; terminal failure aborts.
            if (['connecting', 'disconnected'].includes(state) && typeof this.suspendTransfers === 'function') this.suspendTransfers(reason);
            else this.abortAll(reason);
        }
    }
    _pathUnavailable(reason) {
        this._revokePath('connecting', reason); this._reason = reason;
        // Polling failures cannot keep the UI in "connecting" forever or extend this deadline.
        if (!this._pathWaitTimer) this._pathWaitTimer = setTimeout(() => this._fail('无法核验直连路径，请重试连接'), 30000);
        this._connectionEvent();
    }
    async _samplePath() {
        if (!this._canInspectPath()) return;
        const conn = this._conn, epoch = this._pathEpoch, request = ++this._statsRequest;
        const current = () => conn === this._conn && epoch === this._pathEpoch
            && request === this._statsRequest && this._canInspectPath();
        try {
            const stats = await conn.getStats();
            if (!current()) return;
            const path = selectedPath(stats);
            if (path.status === 'relay') return this._protocolError('检测到中继路径，已停止连接');
            if (!path.direct) return this._pathUnavailable('直连路径暂时无法核验，当前文件已停止；恢复后请重新核对安全码');
            this._path = path; this._reason = null; this._state = 'connected';
            this._restartPending = false; this._waitingForRemote = false;
            clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); clearTimeout(this._pathWaitTimer);
            this._disconnectTimer = null; this._pathWaitTimer = null;
            this._connectionEvent();
        } catch {
            if (current()) this._pathUnavailable('无法读取直连路径，当前文件已停止；恢复后请重新核对安全码');
        }
    }
    _waitForRemoteRestart() {
        if (this._waitingForRemote) return;
        this._waitingForRemote = true;
        clearTimeout(this._deadline);
        this._deadline = setTimeout(() => this._fail('对端未能恢复直连，请让另一台设备重试或创建新邀请'), 30000);
    }
    _onConnectionStateChange() {
        if (this._closed || this._state === 'failed') return;
        const state = this._conn.iceConnectionState, transport = this._conn.connectionState;
        if (state === 'closed' || transport === 'closed') return this.close();
        // DTLS can fail while ICE still reports connected; it is not a usable file channel.
        if (transport === 'failed' && state !== 'failed') return this._fail('安全传输通道失败，请重新建立连接');
        if (['connected', 'completed'].includes(state) && transport !== 'disconnected') {
            clearTimeout(this._disconnectTimer); this._disconnectTimer = null; this._samplePath();
        } else if (state === 'failed') {
            this._revokePath('disconnected', '直连失败，当前文件已停止；恢复后请重新选择文件');
            this._connectionEvent();
            if (this._isCaller) this.restart(); else this._waitForRemoteRestart();
        } else if (state === 'disconnected' || transport === 'disconnected') {
            this._revokePath('disconnected', '网络中断，当前传输已停止，请重连后重新选择文件');
            if (!this._disconnectTimer) this._disconnectTimer = setTimeout(() => {
                this._disconnectTimer = null;
                if (this._isCaller) this.restart(); else this._waitForRemoteRestart();
            }, 5000);
            this._connectionEvent();
        } else if (state === 'checking' || state === 'new') {
            this._revokePath('connecting', '直连路径正在重新核验，当前文件已停止');
            this._connectionEvent();
        }
    }
    restart(manual = false) {
        if (this._closed || !this._isCaller || this._restartPending) return;
        if (manual) this._restarts = 0;
        if (this._restarts++ >= 2) return this._fail('无法建立直连。请尝试更换网络或启用 IPv6；此服务不会切换到文件中继。');
        this._reason = null; this._restartPending = true; this._waitingForRemote = false; this._negotiating = true;
        this._revokePath('connecting', '网络变化，当前文件已停止；连接恢复后请重新选择文件', true);
        if (this._channel?.readyState === 'closed') this._bindChannel(this._conn.createDataChannel('zeydrop-v2', { ordered: true }));
        clearInterval(this._statsTimer); this._statsTimer = setInterval(() => this._samplePath(), 2000);
        clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); clearTimeout(this._pathWaitTimer);
        this._disconnectTimer = null; this._pathWaitTimer = null;
        // Keep one attempt pending until a fresh selected route succeeds or this deadline expires.
        this._deadline = setTimeout(() => { this._restartPending = false; this.restart(); }, 20000);
        this._connectionEvent(); this._offer(true);
    }
    _fail(reason) {
        this._revokePath('failed', reason, true);
        this._restartPending = false; this._waitingForRemote = false; this._negotiating = false;
        clearInterval(this._statsTimer); clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); clearTimeout(this._pathWaitTimer);
        this._disconnectTimer = null; this._pathWaitTimer = null;
        this._reason = reason; this._connectionEvent();
    }
    _connectionEvent() { Events.fire('connection-state', { peerId: this._peerId, state: this._state, path: this._path, verified: this._verified, code: this._code, ready: this._remoteHello, candidates: this._candidateCounts, stunError: this._stunError, reason: this._reason }); }
    _isConnected() { return !this._closed && this._channel?.readyState === 'open'; }
    close(reason = '连接已关闭，文件未完成', preserve = false) {
        if (this._closed) return null;
        if (preserve) this.suspendTransfers?.(reason);
        this._closed = true; this._reason = reason; this._restartPending = false;
        this._revokePath('closed', preserve ? null : reason, true);
        clearInterval(this._statsTimer); clearTimeout(this._deadline); clearTimeout(this._disconnectTimer); clearTimeout(this._pathWaitTimer); Events.off('online', this._online);
        if (this._channel) { this._channel.onopen = null; this._channel.onmessage = null; this._channel.onclose = null; this._channel.onerror = null; this._channel.close(); }
        this._conn.close(); this._connectionEvent();
        return preserve ? this.takeHeldTransfers?.() : null;
    }
}
class PeersManager {
    constructor(server) {
        this.peers = new Map(); this._server = server; this._earlySignals = []; this._earlySignalBytes = 0;
        this._resumeSlots = new Map(); this._preserveOnNextPeers = false;
        Events.on('peer-session-paused', () => { this._preserveOnNextPeers = true; });
        Events.on('resume-clear', event => this._clearResumeSlots(event.detail));
        Events.on('peers', event => {
            const ids = new Set(event.detail.map(peer => peer.id));
            this._earlySignals = this._earlySignals.filter(item => ids.has(item.message.sender));
            this._earlySignalBytes = this._earlySignals.reduce((sum, item) => sum + item.bytes, 0);
            for (const id of this.peers.keys()) if (!ids.has(id)) this._remove(id, this._preserveOnNextPeers);
            this._preserveOnNextPeers = false;
            event.detail.forEach(peer => this._ensure(peer));
        });
        Events.on('peer-joined', event => this._ensure(event.detail));
        Events.on('peer-left', event => this._remove(event.detail, true));
        Events.on('signal', event => this._onSignal(event.detail));
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
    _onSignal(message) {
        if (!message || typeof message.sender !== 'string') return;
        const peer = this.peers.get(message.sender);
        if (peer) return peer.onServerMessage(message);
        // The other socket may deliver its offer before our discovery frame.
        // Buffer briefly, but only create a peer after authorized discovery.
        const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
        if (this._earlySignals.length >= 64 || this._earlySignalBytes + bytes > 256 * 1024) return;
        this._earlySignals.push({ message, bytes, expires: Date.now() + 10000 });
        this._earlySignalBytes += bytes;
    }
    _clearResumeSlots(reason) {
        for (const [id, slot] of this._resumeSlots) {
            clearTimeout(slot.timer); slot.peer._dropHeld?.(reason || '已结束旧会话');
            this._resumeSlots.delete(id);
        }
    }
    _ensure(info) {
        if (!info?.id || !window.isRtcSupported) return;
        if (!this.peers.has(info.id)) {
            const peer = new RTCPeer(this._server, info.id);
            this.peers.set(info.id, peer);
            const slot = this._resumeSlots.get(info.id);
            if (slot) {
                this._resumeSlots.delete(info.id); clearTimeout(slot.timer);
                if (slot.localId === this._server._peerId && slot.roomId === this._server._desiredRoomId
                    && Date.now() < slot.hold.deadline) {
                    peer.adoptHeldTransfers?.(slot.hold);
                } else slot.peer._dropHeld?.('身份或会话不匹配，旧文件不能续传');
            }
        }
        const waiting = this._earlySignals.filter(item => item.message.sender === info.id);
        this._earlySignals = this._earlySignals.filter(item => item.message.sender !== info.id);
        this._earlySignalBytes = this._earlySignals.reduce((sum, item) => sum + item.bytes, 0);
        for (const item of waiting) if (item.expires > Date.now()) this.peers.get(info.id).onServerMessage(item.message);
    }
    _remove(id, preserve = false) {
        const peer = this.peers.get(id);
        const held = peer?.close('连接中断，等待原设备恢复', preserve);
        this.peers.delete(id);
        if (held && preserve) {
            const old = this._resumeSlots.get(id);
            if (old) { clearTimeout(old.timer); old.peer._dropHeld?.('旧续传请求已被替换'); }
            const slot = { peer, hold: held, roomId: this._server._desiredRoomId, localId: this._server._peerId };
            slot.timer = setTimeout(() => {
                if (this._resumeSlots.get(id) !== slot) return;
                this._resumeSlots.delete(id);
                peer._dropHeld?.('原设备未及时恢复，续传已取消');
            }, Math.max(0, held.deadline - Date.now()));
            this._resumeSlots.set(id, slot);
        }
        this._earlySignals = this._earlySignals.filter(item => item.message.sender !== id);
        this._earlySignalBytes = this._earlySignals.reduce((sum, item) => sum + item.bytes, 0);
    }
}
