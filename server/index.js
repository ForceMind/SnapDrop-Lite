var process = require('process')
process.on('SIGINT', () => {
  console.info("收到 SIGINT 信号，正在退出...")
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.info("收到 SIGTERM 信号，正在退出...")
  process.exit(0)
})

const parser = require('ua-parser-js');
const { uniqueNamesGenerator, animals, colors } = require('unique-names-generator');

class SnapdropServer {

    constructor(port) {
        const WebSocket = require('ws');
        this._wss = new WebSocket.Server({ port: port, host: process.env.WS_HOST || '127.0.0.1', maxPayload: 64 * 1024 });
        this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request)));
        this._wss.on('headers', (headers, response) => this._onHeaders(headers, response));

        this._rooms = {};

        console.log('闪投服务已启动，端口:', port);
    }

    _onConnection(peer) {
        this._joinRoom(peer);
        peer.socket.on('message', message => this._onMessage(peer, message));
        peer.socket.on('error', console.error);
        this._keepAlive(peer);
        peer.socket.on('close', () => this._leaveRoom(peer, false));

        // 记录连接日志
        const roomPeers = this._rooms[peer.roomKey] ? Object.keys(this._rooms[peer.roomKey]).length : 0;
        console.log(`[连接] ${peer.name.deviceName} | IP: ${peer.ip} | 房间: ${peer.roomKey} | 房间人数: ${roomPeers}`);

        this._send(peer, {
            type: 'display-name',
            message: {
                displayName: peer.name.displayName,
                deviceName: peer.name.deviceName
            }
        });
    }

    _onHeaders(headers, response) {
        if (response.headers.cookie && response.headers.cookie.indexOf('peerid=') > -1) return;
        response.peerId = Peer.uuid();
        const secure = process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true' ? '; Secure' : '';
        headers.push('Set-Cookie: peerid=' + response.peerId + "; SameSite=Strict" + secure);
    }

    _onMessage(sender, message) {
        if (typeof message !== 'string' || message.length > 64 * 1024) return;
        try {
            message = JSON.parse(message);
        } catch (e) {
            return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        // Prevent the signaling server from becoming a general-purpose file relay.
        if (!['disconnect', 'pong', 'local-ip', 'join-room', 'signal'].includes(message.type)) return;

        switch (message.type) {
            case 'disconnect':
                this._leaveRoom(sender);
                break;
            case 'pong':
                sender.lastBeat = Date.now();
                break;
            case 'local-ip':
                // 客户端报告局域网 IP 列表，更新房间分组
                console.log(`[收到] ${sender.name.deviceName} 报告 IP:`, message.ips);
                if (!this._isLanMode()) {
                    console.log(`[局域网IP] 当前为公网模式，忽略客户端局域网 IP 报告`);
                    return;
                }
                if (!Array.isArray(message.ips) ||
                    message.ips.length > 16 ||
                    message.ips.some(ip => typeof ip !== 'string' || ip.length > 128)) return;
                if (message.ips.length > 0) {
                    // 优先使用 IPv4 局域网地址（192.168.x.x, 10.x.x.x, 172.16-31.x.x）
                    const localIP = this._selectLocalIP(message.ips, sender.ip);

                    const newRoomKey = this._getRoomKey(localIP, sender.id);
                    if (sender.roomKey !== newRoomKey) {
                        console.log(`[局域网IP] ${sender.name.deviceName} 切换房间: ${sender.roomKey} -> ${newRoomKey}`);
                        this._leaveRoom(sender, false); // 不终止连接
                        sender.ip = localIP;
                        sender.roomKey = newRoomKey;
                        this._joinRoom(sender);
                        this._keepAlive(sender);
                    } else {
                        console.log(`[局域网IP] ${sender.name.deviceName} 房间未变: ${newRoomKey}`);
                    }
                } else {
                    console.log(`[局域网IP] ${sender.name.deviceName} 未获取到局域网 IP，保持使用公网 IP 分组: ${sender.roomKey}`);
                }
                return;
            case 'join-room':
                // 用户手动加入房间
                if (typeof message.roomId !== 'string') return;
                const roomId = message.roomId.trim();
                const strongRoom = /^[a-f0-9]{32}$/i.test(roomId);
                // Support legacy local rooms in LAN mode only; public rooms require 128-bit invite IDs.
                const oldLanRoom = this._isLanMode() && /^[a-zA-Z0-9_-]{6,64}$/.test(roomId);
                if (!strongRoom && !oldLanRoom) {
                    this._send(sender, { type: 'room-error', message: '邀请码无效；公网配对请使用生成的邀请链接' });
                    return;
                }
                const now = Date.now();
                if (!sender.joinWindow || now - sender.joinWindow > 60000) {
                    sender.joinWindow = now; sender.joinAttempts = 0;
                }
                sender.joinAttempts++;
                if (sender.joinAttempts > 12) {
                    this._send(sender, { type: 'room-error', message: '尝试过于频繁，请稍后重试' });
                    return;
                }
                const newRoom = 'room:' + roomId;
                const occupants = this._rooms[newRoom] ? Object.keys(this._rooms[newRoom]).length : 0;
                if (sender.roomKey !== newRoom && occupants >= 2) {
                    this._send(sender, { type: 'room-error', message: '该邀请房间已满' });
                    return;
                }
                if (sender.roomKey !== newRoom) {
                    this._leaveRoom(sender, false); // Do not close the underlying WS socket.
                    sender.roomKey = newRoom;
                    this._joinRoom(sender);
                    this._keepAlive(sender);
                }
                this._send(sender, { type: 'room-joined', roomId });
                return;
        }

        // Only narrowly-validated ICE/SDP signaling is allowed between room members.
        if (message.type !== 'signal' || typeof message.to !== 'string') return;
        const members = this._rooms[sender.roomKey];
        const recipient = members && members[message.to];
        if (!recipient || recipient === sender) return;

        let forwarded;
        if (message.sdp && !message.ice && Object.keys(message).every(k => ['type','to','sdp'].includes(k))) {
            const sdp = message.sdp;
            if (!sdp || typeof sdp !== 'object' ||
                !['offer', 'answer'].includes(sdp.type) ||
                typeof sdp.sdp !== 'string' || sdp.sdp.length > 60000) return;
            forwarded = { type: 'signal', sender: sender.id, sdp: {type:sdp.type, sdp:sdp.sdp} };
        } else if (message.ice && !message.sdp && Object.keys(message).every(k => ['type','to','ice'].includes(k))) {
            const ice = message.ice;
            if (!ice || typeof ice !== 'object' || typeof ice.candidate !== 'string' ||
                ice.candidate.length > 4096) return;
            forwarded = { type: 'signal', sender: sender.id, ice: {
                candidate: ice.candidate,
                sdpMid: typeof ice.sdpMid === 'string' ? ice.sdpMid.slice(0, 128) : null,
                sdpMLineIndex: Number.isInteger(ice.sdpMLineIndex) ? ice.sdpMLineIndex : null,
                usernameFragment: typeof ice.usernameFragment === 'string' ? ice.usernameFragment.slice(0, 128) : undefined
            } };
        }
        if (forwarded) this._send(recipient, forwarded);
    }

    _joinRoom(peer) {
        const roomKey = peer.roomKey;
        if (!this._rooms[roomKey]) {
            this._rooms[roomKey] = {};
        }

        for (const otherPeerId in this._rooms[roomKey]) {
            const otherPeer = this._rooms[roomKey][otherPeerId];
            this._send(otherPeer, {
                type: 'peer-joined',
                peer: peer.getInfo()
            });
        }

        const otherPeers = [];
        for (const otherPeerId in this._rooms[roomKey]) {
            otherPeers.push(this._rooms[roomKey][otherPeerId].getInfo());
        }

        this._send(peer, {
            type: 'peers',
            peers: otherPeers
        });

        this._rooms[roomKey][peer.id] = peer;
    }

    _leaveRoom(peer, terminate = true) {
        const roomKey = peer.roomKey;
        if (!this._rooms[roomKey] || !this._rooms[roomKey][peer.id]) return;
        this._cancelKeepAlive(this._rooms[roomKey][peer.id]);

        delete this._rooms[roomKey][peer.id];

        if (terminate) {
            peer.socket.terminate();
        }

        if (!Object.keys(this._rooms[roomKey]).length) {
            delete this._rooms[roomKey];
        } else {
            for (const otherPeerId in this._rooms[roomKey]) {
                const otherPeer = this._rooms[roomKey][otherPeerId];
                this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
            }
        }
    }

    _send(peer, message) {
        if (!peer) return;
        if (peer.socket.readyState !== 1) return; // 1 = WebSocket.OPEN
        message = JSON.stringify(message);
        peer.socket.send(message, error => '');
    }

    _keepAlive(peer) {
        this._cancelKeepAlive(peer);
        var timeout = 30000;
        if (!peer.lastBeat) {
            peer.lastBeat = Date.now();
        }
        if (Date.now() - peer.lastBeat > 2 * timeout) {
            this._leaveRoom(peer);
            return;
        }

        this._send(peer, { type: 'ping' });

        peer.timerId = setTimeout(() => this._keepAlive(peer), timeout);
    }

    _cancelKeepAlive(peer) {
        if (peer && peer.timerId) {
            clearTimeout(peer.timerId);
        }
    }

    _isLanMode() {
        return process.env.LAN_MODE !== 'false';
    }

    _selectLocalIP(ips, fallbackIP) {
        const fallback = Peer.normalizeIP(fallbackIP);
        if (Peer.canUseForLanRoom(fallback)) {
            return fallback;
        }

        const normalized = ips
            .map(ip => Peer.normalizeIP(ip))
            .filter(ip => !!ip && Peer.canUseForLanRoom(ip));

        // If the server only sees localhost, use the browser-reported LAN IP as a dev fallback.
        if (fallback === '127.0.0.1') {
            return normalized[0] || fallback;
        }

        return fallback;
    }

    _isPrivateIP(ip) {
        return Peer.isPrivateIP(ip);
    }

    _getRoomKey(ip, peerId) {
        ip = Peer.normalizeIP(ip);
        if (!this._isLanMode() || !Peer.canUseForLanRoom(ip)) return 'session:' + peerId;
        return this._getSubnet(ip);
    }

    _getSubnet(ip) {
        return Peer.getSubnet(ip);
    }
}



class Peer {

    constructor(socket, request) {
        this.socket = socket;
        this._setPeerId(request);
        this._setIP(request);
        this.rtcSupported = request.url.indexOf('webrtc') > -1;
        this._setName(request);
        this.timerId = 0;
        this.lastBeat = Date.now();
    }

    _setIP(request) {
        const remote = request.connection.remoteAddress;
        const fromLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
        const forwarded = request.headers['x-forwarded-for'];
        if (process.env.TRUST_PROXY === 'true' && fromLoopback && typeof forwarded === 'string') {
            this.ip = forwarded.split(/\s*,\s*/)[0];
        } else {
            this.ip = remote;
        }
        this.ip = Peer.normalizeIP(this.ip);

        // 局域网模式按 IPv4 私网 /24 或 IPv6 /64 分组；公网模式按精确 IP 分组。
        this.roomKey = process.env.LAN_MODE === 'false' || !Peer.canUseForLanRoom(this.ip)
            ? 'session:' + this.id
            : this._getSubnet(this.ip);
    }

    _getSubnet(ip) {
        return Peer.getSubnet(ip);
    }

    _setPeerId(request) {
        // 优先从 URL 参数获取（客户端 localStorage 生成的唯一 ID）
        const url = new URL(request.url, 'http://localhost');
        const peerId = url.searchParams.get('peerId');
        if (peerId && /^[a-zA-Z0-9_-]{1,64}$/.test(peerId)) {
            this.id = peerId;
            return;
        }
        // 其次从 cookie 获取
        if (request.headers.cookie) {
            const match = request.headers.cookie.match(/peerid=([^;]+)/);
            if (match) {
                this.id = match[1];
                return;
            }
        }
        // 最后生成新的 UUID
        this.id = Peer.uuid();
    }

    toString() {
        return `<Peer id=${this.id} ip=${this.ip} roomKey=${this.roomKey} rtcSupported=${this.rtcSupported}>`
    }

    _setName(req) {
        let ua = parser(req.headers['user-agent']);

        let deviceName = '';

        if (ua.os && ua.os.name) {
            deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
        }

        if (ua.device.model) {
            deviceName += ua.device.model;
        } else {
            deviceName += ua.browser.name;
        }

        if(!deviceName)
            deviceName = '未知设备';

        this.name = {
            model: ua.device.model,
            os: ua.os.name,
            browser: ua.browser.name,
            type: ua.device.type,
            deviceName,
            displayName: deviceName
        };
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            rtcSupported: this.rtcSupported
        }
    }

    static uuid() {
        let uuid = '',
            ii;
        for (ii = 0; ii < 32; ii += 1) {
            switch (ii) {
                case 8:
                case 20:
                    uuid += '-';
                    uuid += (Math.random() * 16 | 0).toString(16);
                    break;
                case 12:
                    uuid += '-';
                    uuid += '4';
                    break;
                case 16:
                    uuid += '-';
                    uuid += (Math.random() * 4 | 8).toString(16);
                    break;
                default:
                    uuid += (Math.random() * 16 | 0).toString(16);
            }
        }
        return uuid;
    };

    static normalizeIP(ip) {
        if (!ip) return '';
        ip = ip.toLowerCase();
        if (ip === '::1') return '127.0.0.1';
        if (ip.startsWith('::ffff:')) return ip.substring(7);
        return ip;
    }

    static isPrivateIP(ip) {
        ip = Peer.normalizeIP(ip);
        if (!ip || !ip.includes('.')) return false;
        if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
        if (ip.startsWith('172.')) {
            const second = parseInt(ip.split('.')[1]);
            return second >= 16 && second <= 31;
        }
        return false;
    }

    static isLikelyVirtualIP(ip) {
        ip = Peer.normalizeIP(ip);
        return /^172\.(1[6-9]|2\d|3[01])\.0\.1$/.test(ip);
    }

    static isUsableIPv6ForLan(ip) {
        ip = Peer.normalizeIP(ip);
        return ip.includes(':') && !ip.startsWith('fe80:') && ip !== '::';
    }

    static canUseForLanRoom(ip) {
        ip = Peer.normalizeIP(ip);
        return (Peer.isPrivateIP(ip) && !Peer.isLikelyVirtualIP(ip)) || Peer.isUsableIPv6ForLan(ip);
    }

    static getSubnet(ip) {
        ip = Peer.normalizeIP(ip);
        if (ip.includes('.')) {
            const parts = ip.split('.');
            if (parts.length === 4) {
                return parts.slice(0, 3).join('.') + '.0/24';
            }
        }
        if (ip.includes(':')) {
            const parts = Peer.expandIPv6(ip);
            if (parts.length >= 4) {
                return parts.slice(0, 4).join(':') + '::/64';
            }
        }
        return ip;
    }

    static expandIPv6(ip) {
        ip = Peer.normalizeIP(ip);
        const pieces = ip.split('::');
        if (pieces.length === 1) return ip.split(':').filter(part => part.length);

        const left = pieces[0] ? pieces[0].split(':') : [];
        const right = pieces[1] ? pieces[1].split(':') : [];
        const missing = 8 - left.length - right.length;
        return left
            .concat(Array(Math.max(missing, 0)).fill('0'))
            .concat(right)
            .map(part => part || '0');
    }
}

Object.defineProperty(String.prototype, 'hashCode', {
  value: function() {
    var hash = 0, i, chr;
    for (i = 0; i < this.length; i++) {
      chr   = this.charCodeAt(i);
      hash  = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  }
});

const server = new SnapdropServer(process.env.PORT || 3000);
