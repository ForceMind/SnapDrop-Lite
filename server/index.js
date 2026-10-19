'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { WebSocketServer } = require('ws');
const MAX_MESSAGE = 64 * 1024;
const ROOM_TTL = 15 * 60 * 1000;
const RESUME_TTL = 2 * 60 * 1000;
const token = () => randomBytes(32).toString('hex');
const validRoom = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

class ZeydropServer {
    constructor(options = {}) {
        this.now = options.now || Date.now;
        this.rooms = new Map();
        this.sessions = new Map();
        this.connections = new Map();
        this.origins = new Set((options.origins || process.env.ALLOWED_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080').split(',').map(v => v.trim()));
        this.roomTTL = options.roomTTL || ROOM_TTL;
        this._wss = new WebSocketServer({
            ...(options.noServer ? { noServer: true } : { host: options.host || process.env.WS_HOST || '127.0.0.1', port: options.port ?? Number(process.env.PORT || 3001) }),
            maxPayload: MAX_MESSAGE, perMessageDeflate: false,
            verifyClient: info => this.origins.has(info.origin)
                && new URL(info.req.url, 'http://localhost').pathname === '/server/webrtc'
                && this.sessions.size < 1000 && this.connections.size < 1000
        });
        this._wss.on('connection', (socket, request) => this.connect(socket, request));
        this.timer = setInterval(() => this.sweep(), 5000);
        this.timer.unref();
    }

    connect(socket, request) {
        const now = this.now();
        socket._zeydropUA = String(request.headers['user-agent'] || '').slice(0, 512);
        // Tokens are sent as the first WS message, never in access-log query strings.
        const peer = { socket, id: null, session: null, lastBeat: now, count: 0, bytes: 0, window: now, connected: now };
        this.connections.set(socket, peer);
        socket.on('message', (bytes, binary) => {
            if (binary) { socket.close(1008, 'Signaling only'); return; }
            this.message(peer, bytes.toString());
        });
        socket.on('close', () => this.detach(peer));
        socket.on('error', () => {});
        this.send(peer, { type: 'hello-required' });
    }

    send(peer, message) {
        if (peer?.socket.readyState !== 1) return;
        if (peer.socket.bufferedAmount > 128 * 1024) { peer.socket.close(1008, 'Slow signaling client'); return; }
        peer.socket.send(JSON.stringify(message));
    }

    message(peer, raw) {
        const now = this.now();
        if (now - peer.window >= 60000) { peer.window = now; peer.count = 0; peer.bytes = 0; }
        peer.count++; peer.bytes += Buffer.byteLength(raw);
        if (peer.count > 240 || peer.bytes > 512 * 1024 || Buffer.byteLength(raw) > MAX_MESSAGE) {
            peer.socket.close(1008, 'Signaling limit'); return;
        }
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
        if (msg.type === 'hello' && !peer.session && onlyKeys(msg, ['type', 'resumeToken'])) {
            let session = typeof msg.resumeToken === 'string' && this.sessions.get(msg.resumeToken);
            if (session && (!session.peer && now - session.detached > RESUME_TTL)) session = null;
            if (session?.peer) { peer.socket.close(1008, 'Session already online'); return; }
            if (!session) {
                const ua = String(this._userAgent(peer) || '');
                session = { id: randomUUID(), token: token(), room: null, detached: now, name: this.deviceName(ua) };
                this.sessions.set(session.token, session);
            }
            peer.session = session; peer.id = session.id; session.peer = peer;
            this.send(peer, { type: 'hello', peerId: peer.id, resumeToken: session.token, deviceName: session.name });
            if (session.room) {
                const room = this.rooms.get(session.room);
                if (room && room.expires > now) this.joinActive(peer, session.room, room);
                else session.room = null;
            }
            return;
        }
        if (!peer.session) return;
        if (msg.type === 'pong') { peer.lastBeat = now; return; }
        if (msg.type === 'leave-room') { this.leave(peer); return; }
        if (msg.type === 'create-room' || msg.type === 'join-room') {
            if (!onlyKeys(msg, ['type', 'roomId']) || !validRoom(msg.roomId)) return this.error(peer, 'invalid', '请使用完整的 Zeydrop 邀请链接');
            const existing = this.rooms.get(msg.roomId);
            if (existing && existing.expires <= now) { this.expire(msg.roomId); return this.error(peer, 'expired', '邀请已过期，请创建新邀请'); }
            if (msg.type === 'create-room') {
                if (existing) return this.error(peer, 'exists', '邀请已存在，请创建新邀请');
                if (this.rooms.size >= 1000) return this.error(peer, 'capacity', '服务繁忙，请稍后重试');
                // Rate limit creation independently from ICE/pong traffic.
                if (peer.lastCreate && now - peer.lastCreate < 5000) return this.error(peer, 'rate', '请稍后再创建邀请');
                peer.lastCreate = now;
                this.rooms.set(msg.roomId, { expires: now + this.roomTTL, members: new Map() });
            } else if (!existing) return this.error(peer, 'missing', '邀请不存在或已过期，请让对方创建新邀请');
            const room = this.rooms.get(msg.roomId);
            if (!room.members.has(peer.id) && room.members.size >= 2) return this.error(peer, 'full', '此邀请已配对其他设备');
            if (peer.session.room !== msg.roomId) this.leave(peer);
            peer.session.room = msg.roomId;
            room.members.set(peer.id, peer.session);
            this.joinActive(peer, msg.roomId, room);
            return;
        }
        if (msg.type !== 'signal') return; // No binary, text, files or arbitrary WS forwarding.
        const room = this.rooms.get(peer.session.room);
        if (!room || room.expires <= now || !room.members.has(peer.id)) return;
        const recipient = room.members.get(msg.to)?.peer;
        if (!recipient || recipient === peer) return;
        let payload;
        if (onlyKeys(msg, ['type', 'to', 'sdp']) && onlyKeys(msg.sdp, ['type', 'sdp'])
            && ['offer', 'answer'].includes(msg.sdp.type) && typeof msg.sdp.sdp === 'string'
            && msg.sdp.sdp.startsWith('v=0') && msg.sdp.sdp.length <= 60000) {
            payload = { sdp: { type: msg.sdp.type, sdp: msg.sdp.sdp } };
        } else if (onlyKeys(msg, ['type', 'to', 'ice']) && onlyKeys(msg.ice, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'])
            && typeof msg.ice.candidate === 'string' && msg.ice.candidate.startsWith('candidate:') && msg.ice.candidate.length <= 4096
            && / typ (host|srflx|prflx)( |$)/.test(msg.ice.candidate)
            && (msg.ice.sdpMid === null || (typeof msg.ice.sdpMid === 'string' && msg.ice.sdpMid.length <= 128))
            && (msg.ice.sdpMLineIndex === null || (Number.isInteger(msg.ice.sdpMLineIndex) && msg.ice.sdpMLineIndex >= 0 && msg.ice.sdpMLineIndex <= 16))
            && (msg.ice.usernameFragment === undefined || (typeof msg.ice.usernameFragment === 'string' && msg.ice.usernameFragment.length <= 128))) {
            payload = { ice: msg.ice };
        }
        if (payload) this.send(recipient, { type: 'signal', sender: peer.id, ...payload });
    }

    _userAgent(peer) { return peer.socket._zeydropUA; }
    deviceName(ua) {
        const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Linux';
        const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
        return os + ' · ' + browser;
    }
    info(session) { return { id: session.id, name: { deviceName: session.name, displayName: session.name }, rtcSupported: true }; }
    joinActive(peer, id, room) {
        const others = [...room.members.values()].filter(s => s.id !== peer.id && s.peer);
        for (const other of others) this.send(other.peer, { type: 'peer-joined', peer: this.info(peer.session) });
        this.send(peer, { type: 'peers', peers: others.map(s => this.info(s)) });
        this.send(peer, { type: 'room-joined', roomId: id, expiresAt: room.expires });
    }
    error(peer, code, message) { this.send(peer, { type: 'room-error', code, message }); }
    leave(peer) {
        if (!peer.session?.room) return;
        const room = this.rooms.get(peer.session.room);
        room?.members.delete(peer.id);
        for (const session of room?.members.values() || []) this.send(session.peer, { type: 'peer-left', peerId: peer.id });
        peer.session.room = null;
        this.send(peer, { type: 'peers', peers: [] });
    }
    detach(peer) {
        this.connections.delete(peer.socket);
        if (!peer.session || peer.session.peer !== peer) return;
        peer.session.peer = null; peer.session.detached = this.now();
        const room = this.rooms.get(peer.session.room);
        for (const session of room?.members.values() || []) this.send(session.peer, { type: 'peer-left', peerId: peer.id });
    }
    expire(id) {
        const room = this.rooms.get(id);
        for (const session of room?.members.values() || []) {
            session.room = null;
            this.send(session.peer, { type: 'peers', peers: [] });
            this.send(session.peer, { type: 'room-expired' });
        }
        this.rooms.delete(id);
    }
    sweep() {
        const now = this.now();
        for (const [id, room] of this.rooms) if (room.expires <= now) this.expire(id);
        for (const [key, session] of this.sessions) if (!session.peer && now - session.detached > RESUME_TTL) {
            this.rooms.get(session.room)?.members.delete(session.id); this.sessions.delete(key);
        }
        for (const peer of this.connections.values()) {
            if ((!peer.session && now - peer.connected > 10000) || now - peer.lastBeat > 60000) peer.socket.terminate();
            else this.send(peer, { type: 'ping' });
        }
    }
    async close() {
        clearInterval(this.timer);
        for (const peer of this.connections.values()) peer.socket.terminate();
        await new Promise(resolve => this._wss.close(resolve));
    }
}
module.exports = { ZeydropServer, validRoom, ROOM_TTL, RESUME_TTL };
if (require.main === module) {
    if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS) throw Error('ALLOWED_ORIGINS is required in production');
    const server = new ZeydropServer();
    console.info('Zeydrop signaling listening on loopback; file relay disabled');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close().then(() => process.exit(0)));
}
