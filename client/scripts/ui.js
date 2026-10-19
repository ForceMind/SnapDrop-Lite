'use strict';
const $ = id => document.getElementById(id);
const fmt = bytes => bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GiB' : bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : bytes + ' B';
const labels = { offered: '等待对方同意', sending: '正在发送', receiving: '正在接收', paused: '已暂停', verifying: '正在校验并保存', complete: 'SHA-256 校验通过', cancelled: '传输已停止' };
let toastTimer;
Events.on('notify-user', event => {
    $('toast').textContent = event.detail; $('toast').setAttribute('show', '1');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').removeAttribute('show'), 5000);
});
class Dialog {
    constructor(id) {
        this.el = $(id); this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-modal', 'true'); this.el.setAttribute('aria-hidden', 'true');
        const heading = this.el.querySelector('h3'); if (heading) { heading.id ||= id + 'Title'; this.el.setAttribute('aria-labelledby', heading.id); }
        this.el.querySelectorAll('[close]').forEach(button => button.addEventListener('click', () => this.hide()));
        this.el.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); this.dismiss(); }
            if (event.key !== 'Tab') return;
            const items = [...this.el.querySelectorAll('button:not([disabled]), a[href], input, [tabindex="0"], [contenteditable]')].filter(el => !el.hidden);
            if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
        });
    }
    show() { this.previous = document.activeElement; this.el.setAttribute('show', '1'); this.el.setAttribute('aria-hidden', 'false'); this.el.querySelector('[autofocus], button, a[href], [contenteditable]')?.focus(); }
    hide() { this.el.removeAttribute('show'); this.el.setAttribute('aria-hidden', 'true'); this.previous?.focus(); }
    dismiss() { this.hide(); }
}
class FileOfferDialog extends Dialog {
    constructor() {
        super('fileOfferDialog'); this.queue = [];
        Events.on('file-offer', event => { this.queue.push(event.detail); this.next(); });
        Events.on('file-offer-cancelled', event => {
            this.queue = this.queue.filter(offer => offer.id !== event.detail.id);
            if (this.active?.id === event.detail.id) { this.active = null; this.hide(); this.next(); }
        });
        $('acceptFileOffer').addEventListener('click', () => this.decide(true));
        $('rejectFileOffer').addEventListener('click', () => this.decide(false));
    }
    next() {
        if (this.active || !this.queue.length) return;
        this.active = this.queue.shift(); $('offerFileName').textContent = this.active.name;
        $('offerFileSize').textContent = fmt(this.active.size) + (window.showSaveFilePicker ? ' · 直接写入你选择的文件' : ' · 此浏览器最多合计 64 MiB');
        this.show();
    }
    decide(accept) {
        if (!this.active) return;
        const offer = this.active; this.active = null;
        // Synchronous event preserves activation for showSaveFilePicker.
        Events.fire(accept ? 'file-accepted' : 'file-rejected', { from: offer.sender, id: offer.id });
        this.hide(); this.next();
    }
    dismiss() { this.decide(false); }
}
class ReceiveDialog extends Dialog {
    constructor() {
        super('receiveDialog'); this.queue = [];
        Events.on('file-received', event => {
            if (event.detail.saved) return Events.fire('notify-user', 'SHA-256 校验通过，文件已保存：' + event.detail.name);
            this.queue.push(event.detail); this.next();
        });
    }
    next() {
        if (this.active || !this.queue.length) return;
        this.active = this.queue.shift(); this.url = URL.createObjectURL(this.active.blob);
        const link = $('download'); link.href = this.url; link.download = this.active.name;
        $('fileName').textContent = this.active.name; $('fileSize').textContent = fmt(this.active.size) + ' · SHA-256 ' + this.active.sha256;
        this.show();
    }
    hide() {
        super.hide();
        if (this.url) { const url = this.url; setTimeout(() => URL.revokeObjectURL(url), 1000); }
        this.active?.release?.(); this.active = null; this.url = null; this.next();
    }
}
class PeersUI {
    constructor() {
        Events.on('peers', event => {
            const ids = new Set(event.detail.map(peer => peer.id));
            document.querySelectorAll('x-peer').forEach(el => { if (!ids.has(el.id)) el.remove(); });
            event.detail.forEach(peer => this.add(peer)); this.count();
        });
        Events.on('peer-joined', event => { this.add(event.detail); this.count(); });
        Events.on('peer-left', event => { $(event.detail)?.remove(); this.count(); });
        Events.on('connection-state', event => this.state(event.detail));
    }
    count() { $('peerCount').textContent = document.querySelectorAll('x-peer').length + ' 台设备'; }
    add(peer) {
        if ($(peer.id)) return;
        const el = document.createElement('x-peer'); el.id = peer.id;
        el.innerHTML = '<div class="peer-device"><svg class="icon"><use href="#desktop-mac"/></svg><strong class="name"></strong></div><div class="status" role="status">正在建立直连…</div><div class="path-detail"></div><div class="peer-verification"><small>在两台设备核对相同的安全码</small><strong class="security-code">等待协商</strong><button type="button" class="verify-peer" disabled>安全码一致，允许传输</button></div><label class="select-files button" tabindex="0">选择文件<input type="file" multiple disabled></label><div class="peer-actions"><button type="button" class="send-text">发送文字</button><button type="button" class="retry-peer">重试连接</button></div>';
        el.querySelector('.name').textContent = peer.name.deviceName;
        const input = el.querySelector('input');
        input.addEventListener('change', () => { Events.fire('files-selected', { to: peer.id, files: input.files }); input.value = ''; });
        el.querySelector('.select-files').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
        el.querySelector('.verify-peer').onclick = () => Events.fire('verify-peer', peer.id);
        el.querySelector('.retry-peer').onclick = () => Events.fire('retry-peer', peer.id);
        el.querySelector('.send-text').onclick = () => Events.fire('text-recipient', peer.id);
        el.addEventListener('dragover', event => event.preventDefault());
        el.addEventListener('drop', event => { event.preventDefault(); Events.fire('files-selected', { to: peer.id, files: event.dataTransfer.files }); });
        document.querySelector('x-peers').append(el);
    }
    state(info) {
        const el = $(info.peerId); if (!el) return;
        el.querySelector('.status').textContent = info.state === 'failed' ? '无法直连' : info.state === 'disconnected' ? '连接断开，正在恢复' : info.path?.direct ? (info.path.protocol.toUpperCase() + ' P2P 已连接') : '正在建立并核验直连…';
        el.querySelector('.path-detail').textContent = info.reason || (info.path?.direct ? `${info.path.family} · ${info.path.localType} ↔ ${info.path.remoteType}${info.path.rtt !== null ? ' · ' + info.path.rtt + ' ms' : ''}` : `候选：host ${info.candidates?.host || 0} / srflx ${info.candidates?.srflx || 0}${info.stunError ? ' · 部分 STUN 探测失败' : ''}`);
        el.querySelector('.security-code').textContent = info.code || '等待协商';
        const verify = el.querySelector('.verify-peer'); verify.disabled = !info.code || !info.path?.direct || !info.ready || info.verified;
        verify.textContent = info.verified ? '安全码已核对' : '安全码一致，允许传输';
        el.querySelector('input').disabled = !info.verified || !info.path?.direct || !info.ready;
        el.querySelector('.send-text').disabled = !info.verified || !info.path?.direct;
        el.dataset.state = info.state;
    }
}
class TransfersUI {
    constructor() {
        this.rows = new Map();
        Events.on('transfer-state', event => this.update(event.detail));
    }
    update(info) {
        let row = this.rows.get(info.id);
        if (!row) {
            // Keep history bounded; active transfers are never removed.
            if (this.rows.size >= 30) for (const [id, old] of this.rows) if (old.dataset.done === 'true') { old.remove(); this.rows.delete(id); break; }
            row = document.createElement('article'); row.className = 'transfer-row';
            row.innerHTML = '<div class="transfer-heading"><strong class="transfer-name"></strong><span class="transfer-phase"></span></div><progress max="1" value="0"></progress><div class="transfer-detail"></div><div class="transfer-actions"><button type="button" class="pause-transfer">暂停</button><button type="button" class="cancel-transfer">取消</button></div>';
            this.rows.set(info.id, row); $('transfers').prepend(row); $('transferSection').hidden = false;
        }
        row.querySelector('.transfer-name').textContent = info.name;
        row.querySelector('.transfer-phase').textContent = labels[info.phase] || info.phase;
        row.querySelector('progress').value = info.phase === 'complete' ? 1 : info.progress;
        row.querySelector('.transfer-detail').textContent = fmt(info.bytes) + ' / ' + fmt(info.size) + (['sending', 'receiving'].includes(info.phase) ? ' · ' + fmt(Math.round(info.speed)) + '/s' + (info.eta !== null ? ' · 约 ' + Math.ceil(info.eta) + ' 秒' : '') : '');
        const paused = info.phase === 'paused', done = ['complete', 'cancelled'].includes(info.phase);
        row.dataset.done = String(done);
        row.querySelector('.transfer-actions').hidden = done;
        const pause = row.querySelector('.pause-transfer'); pause.disabled = !['sending', 'receiving', 'paused'].includes(info.phase); pause.textContent = paused ? '继续' : '暂停';
        pause.onclick = () => Events.fire('transfer-control', { peerId: info.peerId, id: info.id, action: paused ? 'resume' : 'pause' });
        row.querySelector('.cancel-transfer').onclick = () => Events.fire('transfer-control', { peerId: info.peerId, id: info.id, action: 'cancel' });
    }
}
class Zeydrop {
    constructor() {
        new PeersUI(); this.server = new ServerConnection(); this.peers = new PeersManager(this.server);
        new FileOfferDialog(); new ReceiveDialog(); new TransfersUI(); this.rooms(); this.text();
        Events.on('display-name', event => $('displayName').textContent = '你的设备：' + event.detail.message.deviceName);
        Events.on('offline', () => Events.fire('notify-user', '网络已断开'));
        Events.on('dragover', event => event.preventDefault()); Events.on('drop', event => event.preventDefault());
        if (!window.isRtcSupported) Events.fire('notify-user', '请通过 HTTPS 或 localhost 打开，并使用支持 WebRTC 的浏览器');
    }
    rooms() {
        let currentRoom = null, expires = null;
        const status = (message, state = '') => { $('roomStatus').textContent = message; $('roomStatus').dataset.state = state; };
        const clearInvite = () => { currentRoom = null; expires = null; $('inviteCreated').hidden = true; $('inviteUrl').value = ''; $('inviteQR').getContext('2d').clearRect(0, 0, 200, 200); $('roomInput').value = ''; $('roomBtn').hidden = true; history.replaceState({}, '', location.pathname); };
        const showInvite = async id => {
            const url = new URL(location.pathname, location.origin); url.hash = 'room=' + id;
            $('inviteUrl').value = url.href; $('inviteCreated').hidden = false;
            try { await window.ZeydropQR.toCanvas($('inviteQR'), url.href, { width: 160, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#163f31', light: '#ffffff' } }); } catch { $('inviteQR').hidden = true; }
        };
        const normalize = raw => {
            try {
                const value = raw.trim();
                if (/^https?:\/\//i.test(value)) {
                    const url = new URL(value);
                    if (url.origin !== location.origin) return '';
                    return new URLSearchParams(url.hash.slice(1)).get('room') || url.searchParams.get('room') || '';
                }
                return value;
            } catch { return ''; }
        };
        const join = (raw, create = false) => {
            const id = normalize(raw);
            if (!/^[a-f0-9]{32}$/.test(id)) return status('邀请码无效，请使用本站生成的完整邀请链接', 'error');
            currentRoom = id; expires = null; $('inviteCreated').hidden = true;
            this.server.joinRoom(id, create); status(create ? '正在创建邀请…' : '正在加入邀请…', 'waiting');
        };
        $('createRoomBtn').onclick = () => { if (!crypto.getRandomValues) return; join(hex(crypto.getRandomValues(new Uint8Array(16))), true); };
        $('roomInput').oninput = () => { $('roomBtn').hidden = !$('roomInput').value.trim(); };
        $('roomBtn').onclick = () => join($('roomInput').value);
        $('roomInput').onkeydown = event => { if (event.key === 'Enter') join($('roomInput').value); };
        $('copyInviteBtn').onclick = async () => {
            try { await navigator.clipboard.writeText($('inviteUrl').value); Events.fire('notify-user', '邀请链接已复制'); }
            catch { $('inviteUrl').focus(); $('inviteUrl').select(); Events.fire('notify-user', '请复制选中的邀请链接'); }
        };
        $('leaveRoomBtn').onclick = () => { this.server.leaveRoom(); clearInvite(); status('已离开，可创建新的邀请'); };
        Events.on('room-joined', event => { if (event.detail.roomId !== currentRoom) return; expires = event.detail.expiresAt; showInvite(currentRoom); status('房间已就绪，等待另一台设备加入并核对安全码', 'connected'); history.replaceState({}, '', location.pathname + '#room=' + currentRoom); });
        Events.on('room-expired', () => { clearInvite(); status('邀请已过期，连接已结束。请创建新邀请', 'error'); });
        Events.on('room-error', event => { if (['expired', 'missing', 'invalid', 'exists'].includes(event.detail.code)) clearInvite(); status(event.detail.message, 'error'); });
        Events.on('signal-state', event => {
            const state = event.detail.state; $('signalStatus').dataset.state = state;
            $('signalStatus').querySelector('.signal-label').textContent = { connected: '信令服务在线', connecting: '正在连接信令', offline: '信令连接断开' }[state];
            if (state === 'offline' && currentRoom) status('信令中断，正在恢复；文件需要重新选择', 'waiting');
        });
        setInterval(() => { if (expires) $('inviteExpiry').textContent = '邀请剩余 ' + Math.max(0, Math.ceil((expires - Date.now()) / 60000)) + ' 分钟 · 最多两台设备'; }, 1000);
        const url = new URL(location.href); const id = new URLSearchParams(url.hash.slice(1)).get('room') || url.searchParams.get('room');
        if (id) { history.replaceState({}, '', location.pathname + '#room=' + id); join(id); }
    }
    text() {
        const send = new Dialog('sendTextDialog'), receive = new Dialog('receiveTextDialog'); let recipient;
        Events.on('text-recipient', event => { recipient = event.detail; send.show(); $('textInput').focus(); });
        $('sendTextDialog').querySelector('form').onsubmit = event => { event.preventDefault(); Events.fire('send-text', { to: recipient, text: $('textInput').innerText }); send.hide(); };
        Events.on('text-received', event => { $('text').textContent = event.detail.text; receive.show(); });
        $('copy').onclick = () => navigator.clipboard.writeText($('text').textContent).catch(() => Events.fire('notify-user', '请手动选择并复制文本'));
    }
}
const zeydrop = new Zeydrop();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').then(registration => {
    registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', () => { if (registration.waiting && navigator.serviceWorker.controller) Events.fire('notify-user', '新版已准备好；完成传输后关闭本站所有标签并重新打开即可更新'); });
    });
}).catch(() => {});
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); $('install').hidden = false; $('install').onclick = () => event.prompt(); });
