'use strict';
// Protocol v2: ordered reliable DC; <=16 KiB chunks, <=256 KiB per persisted ACK.
// All transfer messages, including hashes and metadata, travel over DataChannel.
const CHUNK_SIZE = 16 * 1024;
const WINDOW_SIZE = 256 * 1024;
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const safeName = value => String(value).replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 255) || 'file';
let reservedMemory = 0;
function saveError(error) {
    if (error?.name === 'QuotaExceededError') return '保存空间不足，文件未完成。请释放磁盘或浏览器存储空间后重试。';
    if (error?.name === 'NotAllowedError') return '没有文件保存权限，请重新选择保存位置。';
    return '文件保存失败：' + String(error?.message || error).slice(0, 160);
}
class ReceiveSink {
    static async open(meta, options = {}) {
        if (options.durable && window.ZeydropRecovery?.supported) return window.ZeydropRecovery.open(meta);
        const sink = new ReceiveSink(meta);
        if (typeof window.showSaveFilePicker === 'function') {
            // Must be invoked from the receiver's explicit click/user activation.
            const handle = await window.showSaveFilePicker({ suggestedName: safeName(meta.name) });
            sink.writer = await handle.createWritable();
        } else {
            const limit = Math.min(window.ZEYDROP_CONFIG?.memoryLimit || 64 * 1024 * 1024, 64 * 1024 * 1024);
            if (meta.size + reservedMemory > limit) throw Error('此浏览器仅支持合计 64 MiB 内存保存。请使用支持流式保存的桌面 Chrome / Edge，或拆分文件。');
            reservedMemory += meta.size;
            sink.reserved = meta.size;
            sink.chunks = [];
        }
        return sink;
    }
    constructor(meta) { this.meta = meta; this.size = 0; }
    async write(bytes) {
        if (this.size + bytes.byteLength > this.meta.size) throw Error('文件超出声明大小');
        if (this.writer) await this.writer.write(bytes);
        else this.chunks.push(bytes);
        this.size += bytes.byteLength;
    }
    async finish() {
        if (this.size !== this.meta.size) throw Error('文件长度不一致');
        if (this.writer) { await this.writer.close(); return { saved: true }; }
        const blob = new Blob(this.chunks, { type: this.meta.mime });
        this.chunks = [];
        return { blob, release: () => this.release() };
    }
    release() { reservedMemory -= this.reserved || 0; this.reserved = 0; this.chunks = []; }
    async abort() { this.release(); if (this.writer) await this.writer.abort().catch(() => {}); }
}

class TransferPeer {
    constructor(server, peerId) {
        this._server = server; this._peerId = peerId;
        this._filesQueue = []; this._outgoing = null; this._incoming = null;
        this._messageChain = Promise.resolve(); this._queuedBytes = 0;
        this._verified = false; this._remoteHello = false;
        // Page-memory only: no file bytes, handles or resume metadata enter signaling.
        this._held = null; this._pendingResumeOffer = null; this._resumeReady = Promise.resolve();
    }
    sendJSON(message) { this._send(JSON.stringify(message)); }
    _receive(data) {
        if (this._held && typeof data !== 'string') return; // Drop stale channel frames.
        this._queuedBytes += typeof data === 'string' ? data.length : data.byteLength;
        this._peakQueuedBytes = Math.max(this._peakQueuedBytes || 0, this._queuedBytes);
        if (this._queuedBytes > 1024 * 1024) { this._protocolError('接收缓冲超限'); return; }
        this._messageChain = this._messageChain.then(() => this._onMessage(data))
            .catch(error => this._protocolError(error.message))
            .finally(() => { this._queuedBytes -= typeof data === 'string' ? data.length : data.byteLength; });
    }
    async _onMessage(data) {
        // Already queued chunks from a dead channel must not become protocol errors.
        if (this._held && typeof data !== 'string') return;
        if (typeof data !== 'string') {
            // An accepted transfer can be cancelled while its final bounded window
            // is already in flight. Drain those bytes without saving or closing DC.
            if (this._discard && !this._incoming && data.byteLength > 0 && data.byteLength <= CHUNK_SIZE && data.byteLength <= this._discard.remaining) { this._discard.remaining -= data.byteLength; return; }
            const state = this._incoming;
            if (!state?.sink || state.accepting || state.awaitingResume || data.byteLength < 1 || data.byteLength > CHUNK_SIZE
                || state.offset + data.byteLength > state.meta.size || state.offset + data.byteLength - state.acked > WINDOW_SIZE) throw Error('未授权或无效的文件分块');
            try { await state.sink.write(data); }
            catch (error) { this.cancel(state.meta.id, saveError(error)); return; }
            if (this._incoming !== state && this._held?.incoming !== state) return;
            state.hash.update(new Uint8Array(data)); state.offset += data.byteLength;
            if (this._incoming === state) this._progress(state, 'receiving');
            return;
        }
        if (data.length > 8192) throw Error('控制消息超限');
        let msg;
        try { msg = JSON.parse(data); } catch { throw Error('无效的传输消息'); }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw Error('无效的传输消息');
        if (msg.type === 'hello') {
            if (msg.version !== 2) throw Error('双方版本不兼容，请刷新网页');
            this._remoteHello = true; this._connectionEvent(); this.restoreTransfers(); return;
        }
        if (!this._remoteHello) throw Error('传输协议尚未就绪');
        // Resume control is valid only for an existing, user-approved file from the
        // same locked pair. Never turn a resume request into a fresh file offer.
        if (msg.type === 'resume-offer') {
            const held = this._incoming || this._held?.incoming;
            const matches = held && held.meta.id === msg.id && held.meta.name === msg.name
                && held.meta.size === msg.size && held.meta.mime === msg.mime;
            if (!matches) { this.sendJSON({ type: 'reject', id: msg.id, reason: '本机没有可恢复的文件，请重新选择文件' }); return; }
            this._pendingResumeOffer = msg;
            if (this._incoming && this._verified && this._path?.direct) await this._replyResumeOffer(msg);
            return;
        }
        if (this._held && msg.type !== 'cancel') return;
        if (msg.type === 'resume-at') {
            await this._resumeFromOffset(msg); return;
        }
        if (msg.type === 'resume-confirm') {
            const state = this._incoming;
            if (!state?.awaitingResume || state.meta.id !== msg.id || msg.offset !== state.offset
                || msg.sha256 !== hex(state.hash.clone().digest())) throw Error('续传前缀校验失败');
            if (!this._verified || !this._path?.direct) throw Error('续传直连或身份未重新确认');
            clearTimeout(state.timer);
            state.awaitingResume = false; state.acked = state.offset;
            state.timer = setTimeout(() => this.cancel(msg.id, '续传接收超时'), 12 * 60 * 60 * 1000);
            this._progress(state, 'receiving'); return;
        }
        if (msg.type === 'offer') {
            if (typeof msg.id !== 'string' || !/^[a-f0-9-]{32,36}$/.test(msg.id)
                || typeof msg.name !== 'string' || msg.name.length > 255 || !Number.isSafeInteger(msg.size) || msg.size < 0
                || typeof msg.mime !== 'string' || msg.mime.length > 128) throw Error('无效文件信息');
            if (!this._verified || !this._path?.direct || this._incoming) { this.sendJSON({ type: 'reject', id: msg.id, reason: '接收方未确认安全码或正在接收其他文件' }); return; }
            this._discard = null;
            const state = { meta: { id: msg.id, name: safeName(msg.name), size: msg.size, mime: /^[\w.+-]+\/[\w.+-]+$/.test(msg.mime) ? msg.mime : 'application/octet-stream' }, offset: 0, acked: 0, hash: window.ZeydropHash.create(), start: performance.now() };
            this._incoming = state;
            state.timer = setTimeout(() => this.cancel(msg.id, '接收确认已超时'), 120000);
            Events.fire('file-offer', { sender: this._peerId, ...state.meta }); return;
        }
        if (msg.type === 'checkpoint' && this._discard?.id === msg.id) { this._discard = null; return; }
        const outgoing = this._outgoing;
        const incoming = this._incoming;
        if (msg.type === 'resume-preparing' && outgoing?.meta.id === msg.id && outgoing.phase === 'offered') {
            clearTimeout(outgoing.timer);
            outgoing.timer = setTimeout(() => this.cancel(msg.id, '接收端准备本地断点超时'), 5 * 60 * 1000);
            return;
        }
        if (msg.type === 'accept' && outgoing?.meta.id === msg.id && outgoing.phase === 'offered') {
            clearTimeout(outgoing.timer); outgoing.phase = 'sending';
            this._pump(outgoing).catch(error => { if (this._outgoing === outgoing) this.cancel(msg.id, error.message); }); return;
        }
        if (msg.type === 'reject' && outgoing?.meta.id === msg.id) { this.cancel(msg.id, typeof msg.reason === 'string' ? msg.reason.slice(0, 150) : '对方拒绝接收', false); return; }
        if (msg.type === 'checkpoint' && incoming?.sink && msg.id === incoming.meta.id) {
            if (msg.offset !== incoming.offset) throw Error('文件偏移不一致');
            if (incoming.sink.checkpoint) await incoming.sink.checkpoint(hex(incoming.hash.clone().digest()));
            if (this._incoming !== incoming) return;
            incoming.acked = incoming.offset;
            this.sendJSON({ type: 'ack', id: msg.id, offset: incoming.offset }); return;
        }
        if (msg.type === 'ack' && outgoing?.meta.id === msg.id && outgoing.waiter) {
            if (msg.offset !== outgoing.offset || msg.offset !== outgoing.expectedAck) throw Error('写入确认偏移不一致');
            outgoing.acked = msg.offset; outgoing.waiter.resolve(); outgoing.waiter = null;
            this._progress(outgoing, 'sending'); return;
        }
        if (msg.type === 'finish' && incoming?.sink && msg.id === incoming.meta.id) {
            if (incoming.awaitingResume || incoming.offset !== incoming.meta.size || typeof msg.sha256 !== 'string' || msg.sha256 !== hex(incoming.hash.digest())) throw Error('SHA-256 校验失败');
            let result;
            try { incoming.finishing = true; result = await incoming.sink.finish(msg.sha256); }
            catch (error) { this.cancel(msg.id, saveError(error)); return; }
            if (this._incoming !== incoming) { result.release?.(); return; }
            clearTimeout(incoming.timer); this._incoming = null;
            this.sendJSON({ type: 'complete', id: msg.id, sha256: msg.sha256, readyNext: !!result.saved });
            Events.fire('file-received', { ...incoming.meta, ...result, sender: this._peerId, sha256: msg.sha256 });
            this._progress(incoming, 'complete'); return;
        }
        if (msg.type === 'complete' && outgoing?.meta.id === msg.id && outgoing.phase === 'verifying') {
            if (msg.sha256 !== outgoing.sha256) throw Error('对方返回的校验值不一致');
            clearTimeout(outgoing.timer); this._outgoing = null;
            this._queueWaitId = msg.readyNext === true ? null : msg.id;
            this._progress(outgoing, 'complete'); this._dequeueFile(); return;
        }
        if (msg.type === 'ready-next' && msg.id === this._queueWaitId) { this._queueWaitId = null; this._dequeueFile(); return; }
        if (['pause', 'resume'].includes(msg.type) && outgoing?.meta.id === msg.id) { outgoing.remotePaused = msg.type === 'pause'; return; }
        if (msg.type === 'cancel' && typeof msg.id === 'string') { this.cancel(msg.id, '对方取消传输', false); return; }
        if (msg.type === 'text' && this._verified && typeof msg.text === 'string' && msg.text.length <= 4096) Events.fire('text-received', { text: msg.text, sender: this._peerId });
    }
    // Retain only accepted in-page File objects and opened native/memory sinks.
    // No storage-backed persistence: page reload or browser exit cancels recovery.
    suspendTransfers(reason) {
        if (this._held) return true;
        const outgoing = this._outgoing && ['sending', 'verifying', 'resuming'].includes(this._outgoing.phase) ? this._outgoing : null;
        const incoming = this._incoming?.sink && !this._incoming.finishing ? this._incoming : null;
        if (!outgoing && !incoming) { this.abortAll(reason); return false; }
        if (this._outgoing && !outgoing) this.cancel(this._outgoing.meta.id, reason, false);
        if (this._incoming && !incoming) this.cancel(this._incoming.meta.id, reason, false);
        const deadline = Date.now() + 120000;
        for (const state of [outgoing, incoming]) {
            if (!state) continue;
            state.resumeDeadline = Math.min(state.resumeDeadline || deadline, deadline);
            clearTimeout(state.timer);
            state.awaitingResume = true;
            this._progress(state, 'reconnecting');
        }
        const hold = { outgoing, incoming, deadline: Math.min(...[outgoing, incoming].filter(Boolean).map(state => state.resumeDeadline)) };
        // An in-flight sink.write may finish after the transport disappears. Its
        // hash/offset is accounted for before the receiver advertises a prefix.
        this._held = hold;
        this._outgoing = null; this._incoming = null;
        this._filesQueue = []; this._queueWaitId = null; this._discard = null;
        if (outgoing?.waiter) { const waiter = outgoing.waiter; outgoing.waiter = null; waiter.reject(Error('正在恢复连接')); }
        hold.ready = this._messageChain.catch(() => {});
        hold.timer = setTimeout(() => this._dropHeld('续传窗口已过期，请重新选择文件'), Math.max(0, hold.deadline - Date.now()));
        return true;
    }
    _dropHeld(reason) {
        const hold = this._held; if (!hold) return;
        this._held = null; clearTimeout(hold.timer); this._pendingResumeOffer = null;
        for (const state of [hold.outgoing, hold.incoming]) {
            if (!state) continue;
            clearTimeout(state.timer); state.error = reason;
            state.waiter?.reject(Error(reason));
            if (state.sink) {
                const cleanup = hold.ready.then(() => state.sink.park
                    ? state.sink.park(hex(state.hash.clone().digest())) : state.sink.abort());
                cleanup.catch(() => state.sink.abort().catch(() => {}));
            }
            this._progress(state, 'cancelled');
            Events.fire('file-offer-cancelled', { id: state.meta.id, sender: this._peerId });
        }
        Events.fire('notify-user', reason);
    }
    takeHeldTransfers() { return this._held; }
    adoptHeldTransfers(hold) {
        if (!hold || this._held || this._incoming || this._outgoing) return false;
        if (Date.now() >= hold.deadline) { hold.incoming?.sink?.abort().catch(() => {}); return false; }
        clearTimeout(hold.timer);
        this._held = hold;
        hold.timer = setTimeout(() => this._dropHeld('续传窗口已过期，请重新选择文件'), Math.max(0, hold.deadline - Date.now()));
        this.restoreTransfers(); return true;
    }
    restoreTransfers() {
        if (!this._verified || !this._remoteHello || !this._path?.direct || !this._isConnected()) return false;
        const hold = this._held;
        if (hold) {
            if (Date.now() >= hold.deadline) { this._dropHeld('续传窗口已过期，请重新选择文件'); return false; }
            clearTimeout(hold.timer); this._held = null;
            this._resumeReady = hold.ready;
            this._incoming = hold.incoming; this._outgoing = hold.outgoing;
            for (const state of [this._incoming, this._outgoing]) {
                if (!state) continue;
                state.timer = setTimeout(() => this.cancel(state.meta.id, '续传协商超时'), Math.max(0, state.resumeDeadline - Date.now()));
            }
            if (this._outgoing) {
                this._outgoing.phase = 'resuming';
                this.sendJSON({ type: 'resume-offer', ...this._outgoing.meta });
            }
        }
        if (this._pendingResumeOffer && this._incoming) {
            const offer = this._pendingResumeOffer;
            this._replyResumeOffer(offer).catch(error => this.cancel(offer.id, error.message));
        }
        return !!hold;
    }
    async _replyResumeOffer(msg) {
        const state = this._incoming;
        if (!state?.awaitingResume || !this._verified || !this._path?.direct || state.meta.id !== msg.id) return;
        await this._resumeReady;
        if (this._incoming !== state || !this._verified || !this._path?.direct) return;
        this._pendingResumeOffer = null;
        this.sendJSON({ type: 'resume-at', id: state.meta.id, offset: state.offset, sha256: hex(state.hash.clone().digest()) });
    }
    async _resumeFromOffset(msg) {
        const state = this._outgoing;
        if (!state || !['resuming', 'offered'].includes(state.phase) || msg.id !== state.meta.id
            || !Number.isSafeInteger(msg.offset) || msg.offset < 0 || msg.offset > state.meta.size
            || typeof msg.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(msg.sha256)
            || !this._verified || !this._path?.direct) throw Error('无效的续传确认');
        if (state.resumeBusy) throw Error('重复续传确认');
        state.resumeBusy = true; state.phase = 'resuming';
        clearTimeout(state.timer);
        state.timer = setTimeout(() => this.cancel(msg.id, '本机前缀比对超时'), 5 * 60 * 1000);
        const hash = window.ZeydropHash.create();
        for (let pos = 0; pos < msg.offset; pos += WINDOW_SIZE) {
            const bytes = await state.file.slice(pos, Math.min(pos + WINDOW_SIZE, msg.offset)).arrayBuffer();
            if (this._outgoing !== state || !this._verified || !this._path?.direct) return;
            hash.update(new Uint8Array(bytes));
        }
        if (hex(hash.clone().digest()) !== msg.sha256) {
            this.cancel(msg.id, '文件前缀与接收方记录不一致，已取消续传');
            return;
        }
        if (this._outgoing !== state || !this._verified || !this._path?.direct) return;
        state.hash = hash; state.offset = msg.offset; state.acked = msg.offset;
        state.phase = 'sending'; state.resumeBusy = false;
        clearTimeout(state.timer);
        this.sendJSON({ type: 'resume-confirm', id: msg.id, offset: msg.offset, sha256: msg.sha256 });
        this._pump(state).catch(error => { if (this._outgoing === state) this.cancel(msg.id, error.message); });
    }
    async acceptIncoming(id, options = {}) {
        const state = this._incoming;
        if (!state || state.meta.id !== id || state.sink || state.accepting) return;
        state.accepting = true;
        try {
            if (options.resumeLocalId) {
                if (!window.ZeydropRecovery?.supported) throw Error('此浏览器无法读取本机断点');
                // Only a fresh, explicitly accepted offer may attach a stored partial.
                this.sendJSON({ type: 'resume-preparing', id });
                clearTimeout(state.timer);
                state.timer = setTimeout(() => this.cancel(id, '读取本机断点超时'), 5 * 60 * 1000);
                const { sink, snapshot, offset, prefixSha256 } =
                    await window.ZeydropRecovery.restore(options.resumeLocalId, state.meta);
                if (this._incoming !== state) { await sink.park(prefixSha256); return; }
                state.sink = sink;
                const hash = window.ZeydropHash.create();
                for await (const bytes of snapshot.slice(0, offset).stream()) {
                    if (this._incoming !== state) return;
                    hash.update(new Uint8Array(bytes));
                }
                if (hex(hash.clone().digest()) !== prefixSha256) throw Error('本机断点校验失败，请删除断点后重新接收');
                if (this._incoming !== state) return;
                state.hash = hash; state.offset = offset; state.acked = offset;
                state.awaitingResume = true; state.accepting = false;
                clearTimeout(state.timer);
                state.timer = setTimeout(() => this.cancel(id, '续传协商超时'), 120000);
                this.sendJSON({ type: 'resume-at', id, offset, sha256: prefixSha256 });
                this._progress(state, 'resuming');
                return;
            }
            const sink = await ReceiveSink.open(state.meta, options);
            if (this._incoming !== state) { await sink.abort(); return; }
            state.sink = sink; state.accepting = false; clearTimeout(state.timer);
            state.timer = setTimeout(() => this.cancel(id, '接收传输超时'), 12 * 60 * 60 * 1000);
            this.sendJSON({ type: 'accept', id });
            this._progress(state, 'receiving');
        } catch (error) { this.cancel(id, error.name === 'AbortError' ? '已取消保存' : error.message); }
    }
    rejectIncoming(id) { if (this._incoming?.meta.id === id) this.cancel(id, '已拒绝接收'); }
    sendFiles(files) {
        if (!this._verified || !this._path?.direct || !this._remoteHello) return Events.fire('notify-user', '请先等待直连就绪并核对两台设备的安全码');
        if (files.length + this._filesQueue.length > 100) return Events.fire('notify-user', '每次最多排队 100 个文件');
        this._filesQueue.push(...Array.from(files)); this._dequeueFile();
    }
    _dequeueFile() {
        if (this._outgoing || this._queueWaitId || !this._filesQueue.length || !this._isConnected()) return;
        const file = this._filesQueue.shift();
        const state = { file, meta: { id: crypto.randomUUID(), name: safeName(file.name), size: file.size, mime: file.type.slice(0, 128) }, phase: 'offered', offset: 0, acked: 0, hash: window.ZeydropHash.create(), start: performance.now() };
        this._outgoing = state;
        state.timer = setTimeout(() => this.cancel(state.meta.id, '对方未确认，邀请接收已取消'), 120000);
        this.sendJSON({ type: 'offer', ...state.meta }); this._progress(state, 'offered');
    }
    async _pump(state) {
        while (state.offset < state.meta.size) {
            if (this._outgoing !== state) return;
            if (state.paused || state.remotePaused) {
                await new Promise(resolve => setTimeout(resolve, 100)); continue;
            }
            const limit = Math.min(state.offset + WINDOW_SIZE, state.meta.size);
            while (state.offset < limit) {
                if (this._outgoing !== state) return;
                await this._waitForDrain();
                const bytes = await state.file.slice(state.offset, Math.min(state.offset + CHUNK_SIZE, limit)).arrayBuffer();
                if (this._outgoing !== state) return;
                state.hash.update(new Uint8Array(bytes)); this._send(bytes); state.offset += bytes.byteLength;
            }
            state.expectedAck = state.offset;
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => { state.waiter = null; reject(Error('接收写入确认超时')); }, 30000);
                state.waiter = { resolve: () => { clearTimeout(timeout); resolve(); }, reject: error => { clearTimeout(timeout); reject(error); } };
                this.sendJSON({ type: 'checkpoint', id: state.meta.id, offset: state.offset });
            });
        }
        if (this._outgoing !== state) return;
        state.sha256 = hex(state.hash.digest()); state.phase = 'verifying';
        state.timer = setTimeout(() => this.cancel(state.meta.id, '对方校验或保存超时'), 60000);
        this.sendJSON({ type: 'finish', id: state.meta.id, sha256: state.sha256 }); this._progress(state, 'verifying');
    }
    _progress(state, phase) {
        const bytes = state.acked ?? state.offset;
        if ((state.paused || state.remotePaused) && ['receiving', 'sending'].includes(phase)) phase = 'paused';
        const now = performance.now();
        if (state.uiPhase === phase && now - (state.lastUI || 0) < 200) return;
        state.uiPhase = phase; state.lastUI = now;
        const speed = bytes / Math.max((performance.now() - state.start) / 1000, 0.1);
        Events.fire('transfer-state', { peerId: this._peerId, id: state.meta.id, name: state.meta.name, phase, error: state.error || null, bytes: phase === 'complete' ? state.meta.size : bytes, size: state.meta.size, progress: state.meta.size ? bytes / state.meta.size : 0, speed, eta: speed ? (state.meta.size - bytes) / speed : null });
    }
    pause(id, paused) {
        const state = [this._outgoing, this._incoming].find(s => s?.meta.id === id);
        if (!state) return;
        state.paused = paused;
        if (state === this._incoming) this.sendJSON({ type: paused ? 'pause' : 'resume', id });
        this._progress(state, paused ? 'paused' : state === this._outgoing ? 'sending' : 'receiving');
    }
    cancel(id, reason = '已取消传输', notify = true, keepDurable = false) {
        const outgoing = this._outgoing?.meta.id === id && this._outgoing;
        const incoming = this._incoming?.meta.id === id && this._incoming;
        if (!outgoing && !incoming && this._held && [this._held.outgoing?.meta.id, this._held.incoming?.meta.id].includes(id)) {
            this._dropHeld(reason);
            if (notify && this._isConnected()) this.sendJSON({ type: 'cancel', id });
            return;
        }
        const state = outgoing || incoming;
        if (!state) return;
        clearTimeout(state.timer); state.error = reason;
        if (outgoing) { this._outgoing = null; state.waiter?.reject(Error(reason)); this._filesQueue = []; }
        if (incoming) {
            if (state.sink) this._discard = { id, remaining: WINDOW_SIZE };
            this._incoming = null;
            if (keepDurable && state.sink?.park) {
                this._messageChain.then(() => state.sink.park(hex(state.hash.clone().digest())))
                    .catch(() => state.sink.abort().catch(() => {}));
            } else state.sink?.abort();
        }
        if (notify && this._isConnected()) this.sendJSON({ type: 'cancel', id });
        this._progress(state, 'cancelled');
        Events.fire('file-offer-cancelled', { id, sender: this._peerId });
        Events.fire('notify-user', reason);
    }
    abortAll(reason, keepDurable = false) {
        if (this._outgoing) this.cancel(this._outgoing.meta.id, reason, false);
        if (this._incoming) this.cancel(this._incoming.meta.id, reason, false, keepDurable);
        this._filesQueue = []; this._queueWaitId = null; this._discard = null;
        this._dropHeld(reason);
    }
    sendText(text) {
        if (!this._verified || !this._path?.direct) return Events.fire('notify-user', '请先核对安全码');
        if (text.length > 4096) return Events.fire('notify-user', '文本最多 4096 字符');
        this.sendJSON({ type: 'text', text });
    }
    _protocolError(reason) { this.abortAll(reason); this.close(reason); Events.fire('notify-user', reason); }
}
