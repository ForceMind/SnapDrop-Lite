'use strict';
// Protocol v2: ordered reliable DC; <=16 KiB chunks, <=256 KiB per persisted ACK.
// All transfer messages, including hashes and metadata, travel over DataChannel.
const CHUNK_SIZE = 16 * 1024;
const WINDOW_SIZE = 256 * 1024;
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const safeName = value => String(value).replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 255) || 'file';
let reservedMemory = 0;
class ReceiveSink {
    static async open(meta) {
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
    }
    sendJSON(message) { this._send(JSON.stringify(message)); }
    _receive(data) {
        this._queuedBytes += typeof data === 'string' ? data.length : data.byteLength;
        if (this._queuedBytes > 1024 * 1024) { this._protocolError('接收缓冲超限'); return; }
        this._messageChain = this._messageChain.then(() => this._onMessage(data))
            .catch(error => this._protocolError(error.message))
            .finally(() => { this._queuedBytes -= typeof data === 'string' ? data.length : data.byteLength; });
    }
    async _onMessage(data) {
        if (typeof data !== 'string') {
            const state = this._incoming;
            if (!state?.sink || state.accepting || data.byteLength < 1 || data.byteLength > CHUNK_SIZE
                || state.offset + data.byteLength > state.meta.size || state.offset + data.byteLength - state.acked > WINDOW_SIZE) throw Error('未授权或无效的文件分块');
            await state.sink.write(data);
            if (this._incoming !== state) return;
            state.hash.update(new Uint8Array(data)); state.offset += data.byteLength;
            this._progress(state, 'receiving');
            return;
        }
        if (data.length > 8192) throw Error('控制消息超限');
        let msg;
        try { msg = JSON.parse(data); } catch { throw Error('无效的传输消息'); }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw Error('无效的传输消息');
        if (msg.type === 'hello') {
            if (msg.version !== 2) throw Error('双方版本不兼容，请刷新网页');
            this._remoteHello = true; this._connectionEvent(); return;
        }
        if (!this._remoteHello) throw Error('传输协议尚未就绪');
        if (msg.type === 'offer') {
            if (typeof msg.id !== 'string' || !/^[a-f0-9-]{32,36}$/.test(msg.id)
                || typeof msg.name !== 'string' || msg.name.length > 255 || !Number.isSafeInteger(msg.size) || msg.size < 0
                || typeof msg.mime !== 'string' || msg.mime.length > 128) throw Error('无效文件信息');
            if (!this._verified || !this._path?.direct || this._incoming) { this.sendJSON({ type: 'reject', id: msg.id, reason: '接收方未确认安全码或正在接收其他文件' }); return; }
            const state = { meta: { id: msg.id, name: safeName(msg.name), size: msg.size, mime: /^[\w.+-]+\/[\w.+-]+$/.test(msg.mime) ? msg.mime : 'application/octet-stream' }, offset: 0, acked: 0, hash: window.ZeydropHash.create(), start: performance.now() };
            this._incoming = state;
            state.timer = setTimeout(() => this.cancel(msg.id, '接收确认已超时'), 120000);
            Events.fire('file-offer', { sender: this._peerId, ...state.meta }); return;
        }
        const outgoing = this._outgoing;
        const incoming = this._incoming;
        if (msg.type === 'accept' && outgoing?.meta.id === msg.id && outgoing.phase === 'offered') {
            clearTimeout(outgoing.timer); outgoing.phase = 'sending';
            this._pump(outgoing).catch(error => this.cancel(msg.id, error.message)); return;
        }
        if (msg.type === 'reject' && outgoing?.meta.id === msg.id) { this.cancel(msg.id, typeof msg.reason === 'string' ? msg.reason.slice(0, 150) : '对方拒绝接收', false); return; }
        if (msg.type === 'checkpoint' && incoming?.sink && msg.id === incoming.meta.id) {
            if (msg.offset !== incoming.offset) throw Error('文件偏移不一致');
            incoming.acked = incoming.offset;
            this.sendJSON({ type: 'ack', id: msg.id, offset: incoming.offset }); return;
        }
        if (msg.type === 'ack' && outgoing?.meta.id === msg.id && outgoing.waiter) {
            if (msg.offset !== outgoing.offset || msg.offset !== outgoing.expectedAck) throw Error('写入确认偏移不一致');
            outgoing.acked = msg.offset; outgoing.waiter.resolve(); outgoing.waiter = null;
            this._progress(outgoing, 'sending'); return;
        }
        if (msg.type === 'finish' && incoming?.sink && msg.id === incoming.meta.id) {
            if (incoming.offset !== incoming.meta.size || typeof msg.sha256 !== 'string' || msg.sha256 !== hex(incoming.hash.digest())) throw Error('SHA-256 校验失败');
            const result = await incoming.sink.finish();
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
    async acceptIncoming(id) {
        const state = this._incoming;
        if (!state || state.meta.id !== id || state.sink || state.accepting) return;
        state.accepting = true;
        try {
            const sink = await ReceiveSink.open(state.meta);
            if (this._incoming !== state) { await sink.abort(); return; }
            state.sink = sink; state.accepting = false; clearTimeout(state.timer);
            state.timer = setTimeout(() => this.cancel(id, '接收传输超时'), 30 * 60 * 1000);
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
        const speed = bytes / Math.max((performance.now() - state.start) / 1000, 0.1);
        Events.fire('transfer-state', { peerId: this._peerId, id: state.meta.id, name: state.meta.name, phase, bytes: phase === 'complete' ? state.meta.size : bytes, size: state.meta.size, progress: state.meta.size ? bytes / state.meta.size : 0, speed, eta: speed ? (state.meta.size - bytes) / speed : null });
    }
    pause(id, paused) {
        const state = [this._outgoing, this._incoming].find(s => s?.meta.id === id);
        if (!state) return;
        state.paused = paused;
        if (state === this._incoming) this.sendJSON({ type: paused ? 'pause' : 'resume', id });
        this._progress(state, paused ? 'paused' : state === this._outgoing ? 'sending' : 'receiving');
    }
    cancel(id, reason = '已取消传输', notify = true) {
        const outgoing = this._outgoing?.meta.id === id && this._outgoing;
        const incoming = this._incoming?.meta.id === id && this._incoming;
        const state = outgoing || incoming;
        if (!state) return;
        clearTimeout(state.timer);
        if (outgoing) { this._outgoing = null; state.waiter?.reject(Error(reason)); this._filesQueue = []; }
        if (incoming) { this._incoming = null; state.sink?.abort(); }
        if (notify && this._isConnected()) this.sendJSON({ type: 'cancel', id });
        this._progress(state, 'cancelled');
        Events.fire('file-offer-cancelled', { id, sender: this._peerId });
        Events.fire('notify-user', reason);
    }
    abortAll(reason) {
        if (this._outgoing) this.cancel(this._outgoing.meta.id, reason, false);
        if (this._incoming) this.cancel(this._incoming.meta.id, reason, false);
        this._filesQueue = []; this._queueWaitId = null;
    }
    sendText(text) {
        if (!this._verified || !this._path?.direct) return Events.fire('notify-user', '请先核对安全码');
        if (text.length > 4096) return Events.fire('notify-user', '文本最多 4096 字符');
        this.sendJSON({ type: 'text', text });
    }
    _protocolError(reason) { this.abortAll(reason); this.close(); Events.fire('notify-user', reason); }
}
