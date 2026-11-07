'use strict';
const $ = id => document.getElementById(id);
const fmt = bytes => bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GiB' : bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : bytes + ' B';
const labels = { offered: '等待对方同意', sending: '正在发送', receiving: '正在接收', paused: '已暂停', verifying: '正在校验并保存', reconnecting: '等待原设备恢复（最多 2 分钟）', resuming: '正在核对续传进度', complete: 'SHA-256 校验通过', cancelled: '传输已停止' };
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
            const items = this.focusables();
            if (!items.length) { event.preventDefault(); this.el.focus(); return; }
            if (event.shiftKey && (document.activeElement === items[0] || !items.includes(document.activeElement))) { event.preventDefault(); items.at(-1)?.focus(); }
            else if (!event.shiftKey && (document.activeElement === items.at(-1) || !items.includes(document.activeElement))) { event.preventDefault(); items[0]?.focus(); }
        });
    }
    focusables() {
        return [...this.el.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable]:not([contenteditable="false"])')]
            .filter(el => !el.matches(':disabled') && !el.closest('[hidden], [inert]') && el.getClientRects().length
                && !['hidden','collapse'].includes(getComputedStyle(el).visibility)
                && (el.tabIndex >= 0 || (el.isContentEditable && !el.hasAttribute('tabindex'))));
    }
    show() { this.previous = document.activeElement; this.el.setAttribute('show', '1'); this.el.setAttribute('aria-hidden', 'false'); this.el.tabIndex = -1; const items = this.focusables(); (items.find(el => el.hasAttribute('autofocus')) || items[0] || this.el).focus(); }
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
        $('offerFileSize').textContent = fmt(this.active.size) + (window.showSaveFilePicker ? ' · 默认保存到你选择的文件' : ' · 默认内存保存最多 64 MiB');
        $('durableLocalReceive').checked = false;
        $('useLocalCheckpoint').checked = false;
        $('localResumeOption').hidden = true; this.candidate = null;
        this.show();
        if (window.ZeydropRecovery?.supported) {
            const active = this.active;
            window.ZeydropRecovery.available().then(available => {
                if (this.active !== active || !available) return;
                $('recoveryReceiveOptions').hidden = false;
                return window.ZeydropRecovery.list();
            }).then(items => {
                if (this.active !== active || !items) return;
                const match = items.find(item => item.phase === 'partial' && item.offset > 0
                    && item.name === active.name && item.size === active.size && item.mime === active.mime);
                if (!match) return;
                this.candidate = match;
                $('localResumeOption').hidden = false;
                $('localResumeOption').lastChild.textContent = ' 本机已有 ' + fmt(match.offset)
                    + ' 断点：重新配对后校验并从这里续传';
            }).catch(() => {});
        }
    }
    decide(accept) {
        if (!this.active) return;
        const offer = this.active; this.active = null;
        // Only a user click chooses a partial. Never auto-bind stored files to a new peer.
        const resumeLocalId = accept && $('useLocalCheckpoint').checked ? this.candidate?.id : null;
        const durable = accept && ($('durableLocalReceive').checked || !!resumeLocalId);
        // Synchronous event preserves activation for showSaveFilePicker.
        Events.fire(accept ? 'file-accepted' : 'file-rejected', { from: offer.sender, id: offer.id, durable, resumeLocalId });
        $('recoveryReceiveOptions').hidden = true;
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
        $('fileName').textContent = this.active.name; $('fileSize').textContent = fmt(this.active.size) + ' · SHA-256 ' + this.active.sha256
            + (this.active.locallyStored ? ' · 下载不会立即删除本机副本' : '');
        this.show();
    }
    hide() {
        super.hide();
        if (this.url) {
            const url = this.url;
            if (this.active?.locallyStored) {
                // A download has no reliable completion event. Revoking the Blob
                // URL or deleting the OPFS source during the click can cancel it.
                // Keep the URL until page exit; the user manages the local copy.
                window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
            } else setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        if (this.active?.locallyStored) {
            Events.fire('notify-user', '下载使用的本机副本仍保留；可在“管理本机暂存文件”中删除，或等待过期清理。');
        } else this.active?.release?.();
        if (this.active) Events.fire('file-saved', { sender: this.active.sender, id: this.active.id });
        this.active = null; this.url = null; this.next();
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
        Events.on('send-queue-state', event => this.queue(event.detail));
    }
    count() { $('peerCount').textContent = document.querySelectorAll('x-peer').length + ' 台设备'; }
    add(peer) {
        if ($(peer.id)) return;
        const el = document.createElement('x-peer'); el.id = peer.id;
        el.innerHTML = '<div class="peer-device"><svg class="icon"><use href="#desktop-mac"/></svg><strong class="name"></strong></div><div class="status" role="status">正在建立直连…</div><div class="connection-help"></div><div class="peer-verification"><small>在两台设备核对相同的安全码</small><strong class="security-code">等待协商</strong><button type="button" class="verify-peer" disabled>安全码一致，允许传输</button></div><label class="select-files button" tabindex="0">选择文件<input type="file" multiple disabled></label><div class="peer-actions"><button type="button" class="send-text">发送文字</button><button type="button" class="retry-peer">重试连接</button></div><details class="peer-diagnostics"><summary>连接详情</summary><div class="path-detail"></div></details>';
        const queue = document.createElement('div'); queue.className = 'send-queue'; queue.hidden = true;
        queue.innerHTML = '<p class="queue-summary" role="status"></p><div class="peer-actions"><button type="button" class="continue-queue">继续后续文件</button><button type="button" class="clear-queue">清空待发队列</button></div>';
        el.append(queue);
        for (const action of ['continue', 'clear']) queue.querySelector('.' + action + '-queue').onclick = () => Events.fire('transfer-control', { peerId: peer.id, action: action + '-queue' });
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
        el.querySelector('.status').textContent = info.state === 'closed' ? '连接已关闭' : info.state === 'failed' ? '无法直连' : info.state === 'disconnected' ? '连接断开，正在恢复' : info.path?.direct ? '设备直连已建立' : '正在建立并核验直连…';
        el.querySelector('.connection-help').textContent = info.reason || (info.path?.direct ? (!info.ready ? '直连已建立，正在等待另一台设备就绪' : info.verified ? '安全码已核对，可以选择文件' : '请先在两台设备核对下方安全码') : '请让另一台设备保持页面打开');
        el.querySelector('.path-detail').textContent = info.path?.direct ? `${info.path.protocol.toUpperCase()} · ${info.path.family} · ${info.path.localType} ↔ ${info.path.remoteType}${info.path.rtt !== null ? ' · ' + info.path.rtt + ' ms' : ''}` : `候选：host ${info.candidates?.host || 0} / srflx ${info.candidates?.srflx || 0}${info.stunError ? ' · 部分 STUN 探测失败' : ''}`;
        el.querySelector('.security-code').textContent = info.code || '等待协商';
        const verify = el.querySelector('.verify-peer'); verify.disabled = !info.code || !info.path?.direct || !info.ready || info.verified;
        verify.textContent = info.verified ? '安全码已核对' : '安全码一致，允许传输';
        el.querySelector('input').disabled = !info.verified || !info.path?.direct || !info.ready;
        el.querySelector('.send-text').disabled = !info.verified || !info.path?.direct || !info.ready;
        el.dataset.state = info.state;
    }
    queue(info) {
        const el = $(info.peerId); if (!el) return;
        const queue = el.querySelector('.send-queue'); queue.hidden = !info.count;
        queue.querySelector('.queue-summary').textContent = '待发 ' + info.count + ' 个文件' + (info.blocked ? ' · 已保留队列，请选择重新发送或继续后续文件' : info.busy ? ' · 等待当前文件保存' : '');
        const next = queue.querySelector('.continue-queue'); next.hidden = !info.blocked; next.disabled = !info.ready || info.busy;
    }
}
class TransfersUI {
    constructor() {
        this.rows = new Map();
        Events.on('transfer-state', event => this.update(event.detail));
        Events.on('transfer-retry-state', event => {
            const row = this.rows.get(event.detail.id); if (!row) return;
            row.querySelector('.retry-transfer').hidden = !event.detail.available;
            row.querySelector('.forget-transfer').hidden = !event.detail.available;
            row.querySelector('.transfer-actions').hidden = !event.detail.available;
        });
    }
    update(info) {
        let row = this.rows.get(info.id);
        if (!row) {
            // Keep history bounded; active transfers are never removed.
            if (this.rows.size >= 30) for (const [id, old] of this.rows) if (old.dataset.done === 'true') { old.remove(); this.rows.delete(id); break; }
            row = document.createElement('article'); row.className = 'transfer-row';
            row.innerHTML = '<div class="transfer-heading"><strong class="transfer-name"></strong><span class="transfer-phase"></span></div><progress max="1" value="0"></progress><div class="transfer-detail"></div><div class="transfer-actions"><button type="button" class="pause-transfer">暂停</button><button type="button" class="cancel-transfer">取消</button><button type="button" class="retry-transfer" hidden>重新发送</button><button type="button" class="forget-transfer" hidden>移除重试</button></div>';
            this.rows.set(info.id, row); $('transfers').prepend(row); $('transferSection').hidden = false;
        }
        row.querySelector('.transfer-name').textContent = info.name;
        row.querySelector('.transfer-phase').textContent = labels[info.phase] || info.phase;
        row.querySelector('progress').value = info.phase === 'complete' ? 1 : info.progress;
        row.querySelector('.transfer-detail').textContent = (info.error ? info.error + ' · ' : '') + fmt(info.bytes) + ' / ' + fmt(info.size) + (['sending', 'receiving'].includes(info.phase) ? ' · ' + fmt(Math.round(info.speed)) + '/s' + (info.eta !== null ? ' · 约 ' + Math.ceil(info.eta) + ' 秒' : '') : '');
        const paused = info.phase === 'paused', done = ['complete', 'cancelled'].includes(info.phase);
        row.dataset.done = String(done);
        row.querySelector('.transfer-actions').hidden = done && !info.retryable;
        const pause = row.querySelector('.pause-transfer'); pause.hidden = done; pause.disabled = !['sending', 'receiving', 'paused'].includes(info.phase); pause.textContent = paused ? '继续' : '暂停';
        pause.onclick = () => Events.fire('transfer-control', { peerId: info.peerId, id: info.id, action: paused ? 'resume' : 'pause' });
        const cancel = row.querySelector('.cancel-transfer'); cancel.hidden = done;
        cancel.onclick = () => Events.fire('transfer-control', { peerId: info.peerId, id: info.id, action: 'cancel' });
        for (const action of ['retry', 'forget']) {
            const button = row.querySelector('.' + action + '-transfer'); button.hidden = !info.retryable;
            button.onclick = () => Events.fire('transfer-control', { peerId: info.peerId, id: info.id, action });
        }
    }
}
class SendQueueUI {
    constructor(peers) {
        this.peers = peers; this.store = window.ZeydropSendQueue;
        this.snapshot = null; this.boundFiles = null; this.bindings = new WeakMap();
        this.sequence = 0; this.completionChain = Promise.resolve();
        if (!this.store?.supported) return;
        // Browser form/history restoration is not a new storage permission.
        const resetConsent = () => { $('rememberSendQueue').checked = false; $('sendQueueFiles').value = ''; };
        resetConsent();
        $('sendQueueSection').hidden = false;
        $('rememberSendQueue').onchange = () => {
            if (!$('rememberSendQueue').checked && this.mode === 'save') this.hashController?.abort();
            this.render();
        };
        $('saveSendQueue').onclick = () => { this.mode = 'save'; $('sendQueueFiles').click(); };
        $('reselectSendQueue').onclick = () => { this.mode = 'reselect'; $('sendQueueFiles').click(); };
        $('sendQueueFiles').onchange = () => {
            const files = Array.from($('sendQueueFiles').files); $('sendQueueFiles').value = '';
            if (files.length) void this.choose(files);
        };
        $('cancelQueueHash').onclick = () => this.hashController?.abort();
        $('clearSendQueue').onclick = () => void this.clear();
        $('sendStoredQueue').onclick = () => void this.send();
        Events.on('connection-state', () => this.render());
        Events.on('send-queue-state', () => this.render());
        Events.on('send-file-complete', event => {
            this.completionChain = this.completionChain.then(() => this.completed(event.detail.file, event.detail.sha256)).catch(error => this.failure(error));
        });
        window.addEventListener('storage', event => {
            if (event.key !== null && event.key !== this.store.storageKey) return;
            this.sequence++; this.hashController?.abort(); this.hashController = null; this.busy = false;
            this.boundFiles = null; this.bindings = new WeakMap();
            void this.refresh('另一标签页修改了清单，请重新选择原件');
        });
        window.addEventListener('pagehide', () => {
            this.sequence++; this.hashController?.abort(); this.hashController = null; this.busy = false;
            this.boundFiles = null; this.bindings = new WeakMap(); resetConsent(); this.render();
        });
        window.addEventListener('pageshow', event => {
            if (!event.persisted) return;
            this.sequence++; this.hashController?.abort(); this.hashController = null; this.busy = false;
            this.boundFiles = null; this.bindings = new WeakMap(); resetConsent(); this.render();
        });
        void this.refresh();
    }
    peer() { return [...this.peers.peers.values()].find(peer => peer._canSend()); }
    active() { return [...this.peers.peers.values()].some(peer => peer._outgoing || peer._filesQueue.length || peer._held || peer._queueWaitId); }
    render(note) {
        if (!this.store?.supported) return;
        if (note !== undefined) this.notice = note;
        const exists = !!this.snapshot, active = this.active();
        $('saveSendQueue').disabled = this.busy || exists || this.invalid || active || !$('rememberSendQueue').checked;
        $('reselectSendQueue').disabled = this.busy || !exists || active;
        $('clearSendQueue').disabled = this.busy || (!exists && !this.invalid);
        $('sendStoredQueue').disabled = this.busy || !this.boundFiles || !this.peer() || active;
        $('cancelQueueHash').hidden = !this.hashController;
        const status = this.notice || (exists
            ? `本机清单 ${this.snapshot.files.length} 个文件 · ${this.boundFiles ? '原件已核验，请连接并核对安全码后手动发送' : '请重新选择全部原件，未自动发送'}`
            : '当前没有待发清单');
        if ($('sendQueueStatus').textContent !== status) $('sendQueueStatus').textContent = status;
        const listRevision = this.snapshot?.revision || null;
        if (this.listRevision === listRevision) return;
        this.listRevision = listRevision;
        const list = $('sendQueueList'); list.replaceChildren();
        for (const entry of this.snapshot?.files.slice(0, 10) || []) {
            const item = document.createElement('li'); item.textContent = entry.name + ' · ' + fmt(entry.size); list.append(item);
        }
        if (this.snapshot?.files.length > 10) { const item = document.createElement('li'); item.textContent = '另有 ' + (this.snapshot.files.length - 10) + ' 个文件'; list.append(item); }
    }
    failure(error) {
        this.boundFiles = null;
        const messages = {
            QueueConflictError: '另一标签页修改了清单，请重新加载并选择原件',
            QueueFileMismatchError: '原文件不匹配，文件内容或信息已变化；没有发送文件',
            QueueCorruptError: '本机清单损坏，请删除后重新创建',
            QueueExpiredError: '本机清单已过期，请重新创建',
            QueueConsentError: '请先明确允许在本机保存清单',
            QueueLimitError: '清单最多 100 个文件，记录总量须小于 128 KiB',
            QuotaExceededError: '浏览器存储空间不足，未保存待发清单',
            SecurityError: '浏览器不允许本机存储，请使用普通文件选择发送',
            HashTimeoutError: '校验耗时过长，请重试，或使用普通文件选择发送',
            HashBusyError: '正在校验其它文件，请稍后重试',
            HashWorkerError: '本机文件校验已中断，请重试；没有发送文件',
            HashProtocolError: '本机文件校验已中断，请重试；没有发送文件',
            NotReadableError: '无法读取原文件，可能已移动或被修改，请重新选择',
            AbortError: '已停止校验，没有自动发送文件'
        };
        if (error.name === 'QueueCorruptError') { this.invalid = true; this.snapshot = null; }
        if (error.name === 'QueueExpiredError') this.snapshot = null;
        this.render(messages[error.name] || '清单操作失败，请重新选择原件或删除本机清单');
        if (error.name === 'QueueConflictError') {
            this.bindings = new WeakMap(); void this.refresh(messages.QueueConflictError);
        }
    }
    async refresh(note = '') {
        const sequence = this.sequence;
        try {
            const snapshot = await this.store.load(); if (sequence !== this.sequence) return;
            this.snapshot = snapshot; this.invalid = false; this.render(note);
        } catch (error) { if (sequence === this.sequence) this.failure(error); }
    }
    async choose(files) {
        if (this.busy || this.active()) return;
        const sequence = ++this.sequence;
        this.busy = true; this.boundFiles = null; this.bindings = new WeakMap();
        this.hashController = new AbortController();
        const options = { signal: this.hashController.signal, onProgress: info => {
            if (sequence !== this.sequence) return;
            const valid = Number.isSafeInteger(info?.hashedBytes) && Number.isSafeInteger(info?.totalBytes)
                && info.hashedBytes >= 0 && info.hashedBytes <= info.totalBytes && Number.isSafeInteger(info.fileIndex)
                && Number.isSafeInteger(info.fileCount) && info.fileIndex >= 0 && info.fileIndex < info.fileCount;
            const percent = valid ? (info.totalBytes ? Math.floor(info.hashedBytes * 100 / info.totalBytes) : 100) : null;
            this.render(percent === null ? '正在分块校验原文件，请稍候；尚未发送'
                : `正在核验原文件 · ${percent}% · ${info.fileIndex + 1}/${info.fileCount} 个 · 尚未发送`);
        } };
        this.render('正在分块校验原文件，请稍候；尚未发送');
        try {
            if (this.mode === 'save') {
                const snapshot = await this.store.save(files, { ...options, optIn: $('rememberSendQueue').checked, expectedRevision: null });
                if (sequence !== this.sequence) return;
                this.snapshot = snapshot; this.boundFiles = files;
            } else {
                const result = await this.store.reselect(this.snapshot.revision, files, { ...options, confirmed: true });
                if (sequence !== this.sequence) return;
                this.snapshot = result.snapshot; this.boundFiles = result.files;
            }
            for (let index = 0; index < this.boundFiles.length; index++) this.bindings.set(this.boundFiles[index], this.snapshot.files[index].entryId);
            this.notice = '';
        } catch (error) { if (sequence === this.sequence) this.failure(error); }
        finally { if (sequence === this.sequence) { this.busy = false; this.hashController = null; this.render(); } }
    }
    async send() {
        const peer = this.peer(), files = this.boundFiles;
        const sequence = this.sequence;
        if (this.busy || !peer || !files || this.active()) return;
        try {
            const current = await this.store.load();
            if (sequence !== this.sequence) return;
            if (!current || current.revision !== this.snapshot?.revision) {
                this.snapshot = current; throw Object.assign(Error(), { name: 'QueueConflictError' });
            }
            if (this.peer() !== peer || this.boundFiles !== files || this.active()) return;
            if (peer.sendFiles(files) === true) { this.boundFiles = null; this.render('已加入发送队列，每个文件仍须对方同意；校验成功后才从清单移除'); }
        } catch (error) { if (sequence === this.sequence) this.failure(error); }
    }
    async completed(file, sha256) {
        const entryId = this.bindings.get(file);
        if (!entryId || !this.snapshot) return;
        const sequence = this.sequence;
        if (this.snapshot.files.find(entry => entry.entryId === entryId)?.sha256 !== sha256)
            throw Object.assign(Error(), { name: 'QueueFileMismatchError' });
        try {
            const snapshot = await this.store.removeEntry(entryId, { expectedRevision: this.snapshot.revision });
            if (sequence !== this.sequence) return;
            this.snapshot = snapshot;
            this.bindings.delete(file); this.render(this.snapshot ? '已完成文件已移除，剩余 ' + this.snapshot.files.length + ' 个文件' : '清单中的文件均已校验完成，本机清单已删除');
        } catch (error) { if (sequence === this.sequence) this.failure(error); }
    }
    async clear() {
        if (this.busy) return;
        const sequence = ++this.sequence;
        this.busy = true; this.boundFiles = null; this.bindings = new WeakMap(); this.render();
        try {
            if (this.invalid) await this.store.clearCorrupt({ confirmed: true });
            else await this.store.clear({ expectedRevision: this.snapshot?.revision ?? null });
            if (sequence !== this.sequence) return;
            this.snapshot = null; this.invalid = false; this.boundFiles = null; this.bindings = new WeakMap();
            this.render('本机清单已删除；当前已授权的传输如需停止，请在传输记录中取消');
        } catch (error) { if (sequence === this.sequence) this.failure(error); }
        finally { if (sequence === this.sequence) { this.busy = false; this.render(); } }
    }
}
class Zeydrop {
    constructor() {
        this.diagnostics = new ConnectionDiagnostics({ version: document.querySelector('meta[name="version"]')?.content, revision: document.querySelector('meta[name="build-revision"]')?.content });
        Events.on('connection-state', event => this.diagnostics.recordConnection(event.detail));
        Events.on('signal-state', event => this.diagnostics.recordSignal(event.detail.state));
        $('exportDiagnostics').onclick = () => {
            const report = this.diagnostics.snapshot({ secureContext: window.isSecureContext, webRTC: window.isRtcSupported, streamingSave: typeof window.showSaveFilePicker === 'function' });
            const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'zeydrop-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
            document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            Events.fire('notify-user', '诊断已在本机导出，可自行查看后分享给开发者');
        };
        new PeersUI(); this.server = new ServerConnection(); this.peers = new PeersManager(this.server);
        new FileOfferDialog(); new ReceiveDialog(); new TransfersUI(); this.rooms(); this.text();
        this.sendQueue = new SendQueueUI(this.peers);
        Events.on('display-name', event => $('displayName').textContent = '你的设备：' + event.detail.message.deviceName);
        Events.on('offline', () => Events.fire('notify-user', '网络已断开'));
        Events.on('dragover', event => event.preventDefault()); Events.on('drop', event => event.preventDefault());
        if (!window.isRtcSupported) Events.fire('notify-user', '请通过 HTTPS 或 localhost 打开，并使用支持 WebRTC 的浏览器');
    }
    rooms() {
        let currentRoom = null, expires = null, paired = false;
        const status = (message, state = '') => { $('roomStatus').textContent = message; $('roomStatus').dataset.state = state; };
        const clearInvite = () => { currentRoom = null; expires = null; paired = false; $('inviteCreated').hidden = true; $('inviteUrl').value = ''; $('inviteQR').getContext('2d').clearRect(0, 0, 200, 200); $('roomInput').value = ''; $('roomBtn').hidden = true; history.replaceState({}, '', location.pathname); };
        const showInvite = async id => {
            const url = new URL(location.pathname, location.origin); url.hash = 'room=' + id;
            $('inviteUrl').value = url.href; $('inviteCreated').hidden = false;
            $('inviteTitle').textContent = paired ? '双方设备已配对' : '邀请已生成';
            $('inviteUrl').parentElement.hidden = paired; $('inviteQR').hidden = paired;
            if (paired) return;
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
            currentRoom = id; expires = null; paired = false; $('inviteCreated').hidden = true;
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
        $('leaveRoomBtn').onclick = () => { this.server.leaveRoom(); clearInvite(); status('会话已结束，可创建新的邀请。已启用的本机暂存可在本机暂存管理中查看'); };
        Events.on('room-joined', event => { if (event.detail.roomId !== currentRoom) return; expires = event.detail.expiresAt; paired = event.detail.paired === true; showInvite(currentRoom); status(paired ? '配对已锁定，请核对安全码；此邀请不再接受其他设备' : '房间已就绪，等待另一台设备加入并核对安全码', 'connected'); history.replaceState({}, '', location.pathname + '#room=' + currentRoom); });
        Events.on('room-expired', () => { clearInvite(); status('邀请或会话已过期，连接已结束。请创建新邀请；已启用的本机暂存可在本机暂存管理中查看', 'error'); });
        Events.on('room-error', event => { if (['expired', 'missing', 'invalid', 'exists'].includes(event.detail.code)) clearInvite(); status(event.detail.message, 'error'); });
        Events.on('signal-state', event => {
            const state = event.detail.state; $('signalStatus').dataset.state = state;
            $('signalStatus').querySelector('.signal-label').textContent = { connected: '信令服务在线', connecting: '正在连接信令', offline: '信令连接断开' }[state];
            if (state === 'offline' && currentRoom) status('信令中断，正在恢复；已接受的文件可在短时间内继续，超时需重新选择', 'waiting');
        });
        setInterval(() => { if (expires) $('inviteExpiry').textContent = (paired ? '会话剩余 ' : '邀请剩余 ') + Math.max(0, Math.ceil((expires - Date.now()) / 60000)) + (paired ? ' 分钟 · 已锁定双方 · 最长 12 小时' : ' 分钟 · 最多两台设备'); }, 1000);
        const url = new URL(location.href); const id = new URLSearchParams(url.hash.slice(1)).get('room') || url.searchParams.get('room');
        if (id) { history.replaceState({}, '', location.pathname + '#room=' + id); join(id); }
    }
    text() {
        const send = new Dialog('sendTextDialog'), receive = new Dialog('receiveTextDialog'); let recipient;
        Events.on('text-recipient', event => { recipient = event.detail; send.show(); $('textInput').focus(); });
        $('sendTextDialog').querySelector('form').onsubmit = event => { event.preventDefault(); Events.fire('send-text', { to: recipient, text: $('textInput').innerText }); send.hide(); };
        Events.on('text-received', event => { $('text').textContent = event.detail.text; receive.show(); });
        $('copy').onclick = async () => {
            try {
                if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
                await navigator.clipboard.writeText($('text').textContent);
                receive.hide();
                Events.fire('notify-user', '文本已复制');
            } catch {
                const selection = window.getSelection(), range = document.createRange();
                range.selectNodeContents($('text')); selection?.removeAllRanges(); selection?.addRange(range);
                Events.fire('notify-user', '请复制选中的文本，或长按文本手动复制');
            }
        };
    }
}

// Files are private to this origin and only enumerated after a local user click.
// Completed files are independently rehashed before a download link is shown.
const localRecovery = window.ZeydropRecovery;
if (localRecovery?.supported) localRecovery.available().then(available => {
    if (!available) return;
    $('localStorageSection').hidden = false;
    // Expired entries are cleaned on the next site visit and periodically
    // while this page is open; there is no background task when it is closed.
    void localRecovery.list().catch(() => {});
    const recoverySweep = setInterval(() => {
        void localRecovery.list().catch(() => {});
    }, 60 * 60 * 1000);
    const records = $('localStorageRecords');
    const MAX_LOCAL_DOWNLOADS = 20;
    const downloadCapacityMessage = '待保存链接已达 20 个。请先保存文件，等待最多 60 秒释放后重试；关闭面板可释放尚未点击的链接';
    let renderGeneration = 0;
    const verificationJobs = new Set(), downloadUrls = new Map();
    const releaseDownload = url => {
        if (!downloadUrls.has(url)) return;
        clearTimeout(downloadUrls.get(url)); downloadUrls.delete(url);
        URL.revokeObjectURL(url);
    };
    const retireRender = (releaseAllDownloads = false) => {
        renderGeneration++;
        // Cancel only this panel's jobs; checklist hashing shares the bridge.
        for (const controller of verificationJobs) controller.abort();
        verificationJobs.clear();
        // A clicked link may still be starting its browser download. Keep its
        // bounded 60-second grace through ordinary panel changes. Explicit
        // deletion/page exit release everything; unclicked links never linger.
        for (const [url, timer] of downloadUrls) if (releaseAllDownloads || timer === null) releaseDownload(url);
        records.replaceChildren();
        return renderGeneration;
    };
    window.addEventListener('pagehide', () => {
        clearInterval(recoverySweep); records.hidden = true; retireRender(true);
    });
    $('localStorageManage').onclick = async () => {
        records.hidden = !records.hidden;
        if (records.hidden) { retireRender(); return; }
        const refresh = async () => {
            const generation = retireRender();
            const current = () => generation === renderGeneration && !records.hidden;
            let items;
            try { items = await localRecovery.list(); }
            catch (error) { if (current()) throw error; return; }
            if (!current()) return;
            if (!items.length) { const empty = document.createElement('p'); empty.textContent = '当前没有暂存文件'; records.append(empty); return; }
            for (const item of items) {
                const row = document.createElement('div'); row.className = 'recovery-record';
                const title = document.createElement('span');
                title.textContent = item.name + ' · ' + fmt(item.offset) + '/' + fmt(item.size)
                    + (item.phase === 'complete' ? ' · 已完成（待下载）' : item.phase === 'expired' ? ' · 已过期，请删除' : ['invalid','corrupt'].includes(item.phase) ? ' · 记录损坏，请删除' : ' · 未完成');
                row.append(title);
                if (item.phase === 'complete') {
                    const load = document.createElement('button'); load.type = 'button'; load.textContent = '验证并准备保存';
                    load.onclick = async () => {
                        if (!current() || load.disabled) return;
                        if (downloadUrls.size >= MAX_LOCAL_DOWNLOADS) { Events.fire('notify-user', downloadCapacityMessage); return; }
                        load.disabled = true;
                        const controller = new AbortController(); verificationJobs.add(controller);
                        try {
                            const { blob, meta } = await localRecovery.completed(item.id);
                            if (!current() || controller.signal.aborted) return;
                            const result = await window.ZeydropFileHash.hash(blob, { signal: controller.signal });
                            if (!current() || controller.signal.aborted) return;
                            if (!Number.isSafeInteger(result?.bytes) || result.bytes !== blob.size || result.bytes !== meta.size
                                || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)
                                || result.sha256 !== meta.completeSha256) throw Error('本机文件校验失败，请删除损坏记录');
                            if (downloadUrls.size >= MAX_LOCAL_DOWNLOADS)
                                throw Error(downloadCapacityMessage);
                            const link = document.createElement('a');
                            const url = URL.createObjectURL(blob); downloadUrls.set(url, null);
                            link.textContent = '点击保存'; link.href = url;
                            link.download = meta.name; link.className = 'button';
                            link.addEventListener('click', () => {
                                if (downloadUrls.has(url)) downloadUrls.set(url, setTimeout(() => releaseDownload(url), 60000));
                            }, { once: true });
                            row.append(link); load.remove();
                        } catch (e) {
                            if (current() && !controller.signal.aborted) { load.disabled = false; Events.fire('notify-user', e.message); }
                        } finally { verificationJobs.delete(controller); }
                    };
                    row.append(load);
                }
                const del = document.createElement('button'); del.type = 'button'; del.textContent = '删除本机数据';
                del.onclick = async () => {
                    if (!current() || del.disabled) return;
                    del.disabled = true;
                    // Invalidate before waiting for erase: an already-running
                    // hash must not recreate a link for a deleted/detached row.
                    const deletionGeneration = retireRender(true);
                    const pending = document.createElement('p'); pending.textContent = '正在删除本机数据…'; records.append(pending);
                    let error;
                    try { await localRecovery.erase(item.id); } catch (e) { error = e; }
                    if (deletionGeneration !== renderGeneration || records.hidden) return;
                    if (error) Events.fire('notify-user', error.message);
                    try { await refresh(); } catch (e) { Events.fire('notify-user', e.message); }
                };
                row.append(del); records.append(row);
            }
        };
        try { await refresh(); } catch (e) { Events.fire('notify-user', e.message); }
    };
}).catch(() => {});

const zeydrop = new Zeydrop();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').then(registration => {
    registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', () => { if (registration.waiting && navigator.serviceWorker.controller) Events.fire('notify-user', '新版已准备好；完成传输后关闭本站所有标签并重新打开即可更新'); });
    });
}).catch(() => {});
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); $('install').hidden = false; $('install').onclick = () => event.prompt(); });
