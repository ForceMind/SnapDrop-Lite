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
        this._wss = new WebSocket.Server({ port: port });
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
        try {
            message = JSON.parse(message);
        } catch (e) {
            return;
        }

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
                if (message.ips && message.ips.length > 0) {
                    // 优先使用 IPv4 局域网地址（192.168.x.x, 10.x.x.x, 172.16-31.x.x）
                    const localIP = this._selectLocalIP(message.ips, sender.ip);

                    const newRoomKey = this._getRoomKey(localIP);
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
                if (message.roomId) {
                    const newRoom = 'room:' + message.roomId;
                    if (sender.roomKey !== newRoom) {
                        console.log(`[房间] ${sender.name.deviceName} 加入房间: ${message.roomId}`);
                        this._leaveRoom(sender, false); // 不终止连接
                        sender.roomKey = newRoom;
                        this._joinRoom(sender);
                        this._keepAlive(sender);
                    }
                }
                return;
        }

        // 转发消息给目标设备
        if (message.to && this._rooms[sender.roomKey]) {
            const recipientId = message.to; // TODO: sanitize
            const recipient = this._rooms[sender.roomKey][recipientId];
            delete message.to;
            // add sender id
            message.sender = sender.id;
            this._send(recipient, message);
            return;
        }
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
        const normalized = ips
            .map(ip => Peer.normalizeIP(ip))
            .filter(ip => !!ip);
        return normalized.find(ip => this._isPrivateIP(ip)) || Peer.normalizeIP(fallbackIP);
    }

    _isPrivateIP(ip) {
        if (!ip || !ip.includes('.')) return false;
        if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
        if (ip.startsWith('172.')) {
            const second = parseInt(ip.split('.')[1]);
            return second >= 16 && second <= 31;
        }
        return false;
    }

    _getRoomKey(ip) {
        ip = Peer.normalizeIP(ip);
        return this._isLanMode() ? this._getSubnet(ip) : ip;
    }

    _getSubnet(ip) {
        ip = Peer.normalizeIP(ip);
        if (ip.includes('.')) {
            const parts = ip.split('.');
            if (parts.length === 4) {
                return parts.slice(0, 3).join('.') + '.0/24';
            }
        }
        if (ip.includes(':')) {
            const parts = ip.split(':');
            return parts.slice(0, 4).join(':') + '::/64';
        }
        return ip;
    }
}



class Peer {

    constructor(socket, request) {
        this.socket = socket;
        this._setIP(request);
        this._setPeerId(request)
        this.rtcSupported = request.url.indexOf('webrtc') > -1;
        this._setName(request);
        this.timerId = 0;
        this.lastBeat = Date.now();
    }

    _setIP(request) {
        if (request.headers['x-forwarded-for']) {
            this.ip = request.headers['x-forwarded-for'].split(/\s*,\s*/)[0];
        } else {
            this.ip = request.connection.remoteAddress;
        }
        this.ip = Peer.normalizeIP(this.ip);

        // 局域网模式默认按子网分组；公网模式保留按远端 IP 分组。
        this.roomKey = process.env.LAN_MODE === 'false' ? this.ip : this._getSubnet(this.ip);
    }

    _getSubnet(ip) {
        if (ip.includes('.')) {
            const parts = ip.split('.');
            if (parts.length === 4) {
                return parts.slice(0, 3).join('.') + '.0/24';
            }
        }
        if (ip.includes(':')) {
            const parts = ip.split(':');
            return parts.slice(0, 4).join(':') + '::/64';
        }
        return ip;
    }

    _setPeerId(request) {
        // 优先从 URL 参数获取（客户端 localStorage 生成的唯一 ID）
        const url = new URL(request.url, 'http://localhost');
        const peerId = url.searchParams.get('peerId');
        if (peerId) {
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
        if (ip === '::1') return '127.0.0.1';
        if (ip.startsWith('::ffff:')) return ip.substring(7);
        return ip;
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
