'use strict';
// Protocol v2: ordered reliable DC; <=16 KiB chunks, <=256 KiB per persisted ACK.
// All transfer messages, including hashes and metadata, travel over DataChannel.
const CHUNK_SIZE = 16 * 1024;
const WINDOW_SIZE = 256 * 1024;
// Blob.arrayBuffer() has no abort API. Retired prefix reads remain counted
// until their underlying I/O settles, so repeated cancellation stays bounded.
const MAX_PREFIX_READS = 4;
let prefixReadsInFlight = 0;
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const safeName = value => String(value).replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 255) || 'file';
const safeMime = value => typeof value === 'string' && value.length <= 128 && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
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
        this._retryFiles = new Map(); this._queueBlocked = false;
        this._messageChain = Promise.resolve(); this._queuedBytes = 0;
        this._verified = false; this._remoteHello = false;
        // Page-memory only: no file bytes, handles or resume metadata enter signaling.
        this._held = null; this._pendingResumeOffer = null; this._resumeReady = Promise.resolve();
    }
    sendJSON(message) { this._send(JSON.stringify(message)); }
    _receive(data, stillCurrent = null) {
        // The message chain may be blocked on an earlier asynchronous disk
        // write. Recheck channel identity at dequeue time, not only on receipt.
        if (stillCurrent && !stillCurrent()) return;
        if (this._held && typeof data !== 'string') return; // Drop stale channel frames.
        this._queuedBytes += typeof data === 'string' ? data.length : data.byteLength;
        this._peakQueuedBytes = Math.max(this._peakQueuedBytes || 0, this._queuedBytes);
        if (this._queuedBytes > 1024 * 1024) {
            this._queuedBytes -= typeof data === 'string' ? data.length : data.byteLength;
            this._protocolError('接收缓冲超限'); return;
        }
        this._messageChain = this._messageChain.then(() => {
            if (stillCurrent && !stillCurrent()) return;
            return this._onMessage(data, stillCurrent);
        }).catch(error => { if (!stillCurrent || stillCurrent()) this._protocolError(error.message); })
            .finally(() => { this._queuedBytes -= typeof data === 'string' ? data.length : data.byteLength; });
    }
    async _onMessage(data, stillCurrent = null) {
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
            catch (error) { this._receiveStorageFailure(state, error); return; }
            if (this._incoming !== state && this._held?.incoming !== state && !state.heldCleanup) return;
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
            const first = !this._remoteHello;
            this._remoteHello = true;
            this._helloReceived?.(msg);
            if (first) { this._connectionEvent(); this.restoreTransfers(); }
            return;
        }
        if (msg.type === 'hello-ack') {
            if (msg.version !== 2) throw Error('双方版本不兼容，请刷新网页');
            this._helloAcknowledged?.(msg); return;
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
            // Outgoing prefix I/O must not hold the ordered incoming message
            // queue: remote cancel, incoming ACKs and the opposite direction
            // still need processing while a local File read is pending.
            const state = this._outgoing, epoch = state?.sendEpoch || 0, pathEpoch = this._pathEpoch;
            this._resumeFromOffset(msg, stillCurrent).catch(error => {
                if ((!stillCurrent || stillCurrent()) && this._pathEpoch === pathEpoch
                    && (!state || (this._outgoing === state && (state.sendEpoch || 0) === epoch)))
                    this._protocolError(error.message);
            });
            return;
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
            if (this._outgoing?.meta.id === msg.id) {
                this.sendJSON({ type: 'reject', id: msg.id, reason: '双方文件标识冲突，请重新选择文件' }); return;
            }
            if (!this._verified || !this._path?.direct || this._incoming) { this.sendJSON({ type: 'reject', id: msg.id, reason: '接收方未确认安全码或正在接收其他文件' }); return; }
            this._discard = null;
            const state = { meta: { id: msg.id, name: safeName(msg.name), size: msg.size, mime: safeMime(msg.mime) }, offset: 0, acked: 0, hash: window.ZeydropHash.create(), start: performance.now() };
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
            try { if (incoming.sink.checkpoint) await incoming.sink.checkpoint(hex(incoming.hash.clone().digest())); }
            catch (error) { this._receiveStorageFailure(incoming, error); return; }
            if (this._incoming !== incoming) return;
            incoming.acked = incoming.offset;
            this.sendJSON({ type: 'ack', id: msg.id, offset: incoming.offset }); return;
        }
        if (msg.type === 'ack' && outgoing?.meta.id === msg.id && outgoing.waiter) {
            if (msg.offset !== outgoing.offset || msg.offset !== outgoing.expectedAck) throw Error('写入确认偏移不一致');
            if (outgoing.phase !== 'sending' || outgoing.resumeBusy) return;
            outgoing.acked = msg.offset; outgoing.waiter.resolve(); outgoing.waiter = null;
            this._progress(outgoing, 'sending'); return;
        }
        if (msg.type === 'finish' && incoming?.sink && msg.id === incoming.meta.id) {
            if (incoming.awaitingResume || incoming.offset !== incoming.meta.size || typeof msg.sha256 !== 'string') throw Error('SHA-256 校验失败');
            const finalSha256 = hex(incoming.hash.digest());
            if (!/^[a-f0-9]{64}$/.test(finalSha256) || msg.sha256 !== finalSha256) throw Error('SHA-256 校验失败');
            // digest() consumes the incremental hasher. Only retain a final
            // value after actual local equality, for a failed durable finish.
            incoming.verifiedFinalSha256 = finalSha256;
            let result;
            try { incoming.finishing = true; result = await incoming.sink.finish(msg.sha256); }
            catch (error) { this._receiveStorageFailure(incoming, error); return; }
            if (this._incoming !== incoming) {
                // A transient durable cancellation keeps the validated local
                // file even when its storage operation completes late. This
                // intent belongs to the exact state, never a newer same-ID file.
                if (!(incoming.preserveDurableResult === true && result.locallyStored === true)) result.release?.();
                return;
            }
            clearTimeout(incoming.timer); this._incoming = null;
            this.sendJSON({ type: 'complete', id: msg.id, sha256: msg.sha256, readyNext: !!result.saved });
            Events.fire('file-received', { ...incoming.meta, ...result, sender: this._peerId, sha256: msg.sha256 });
            this._progress(incoming, 'complete'); return;
        }
        if (msg.type === 'complete' && outgoing?.meta.id === msg.id && outgoing.phase === 'verifying') {
            if (msg.sha256 !== outgoing.sha256) throw Error('对方返回的校验值不一致');
            clearTimeout(outgoing.timer); this._outgoing = null;
            this._queueWaitId = msg.readyNext === true ? null : msg.id;
            Events.fire('send-file-complete', { file: outgoing.file, sha256: outgoing.sha256 });
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
        this._clearRetries();
        const outgoing = this._outgoing && ['sending', 'verifying', 'resuming'].includes(this._outgoing.phase) ? this._outgoing : null;
        const incoming = this._incoming?.sink && !this._incoming.finishing ? this._incoming : null;
        // Queued File objects are never uploaded to signaling. Retain them
        // only in this page for a bounded 2-minute reconnection window.
        // If a completed fallback download still waits for manual saving,
        // the ready-next authorization cannot be safely replayed: discard
        // the remaining queue rather than skipping receiver consent.
        const offered = this._outgoing?.phase === 'offered' ? this._outgoing : null;
        const pendingFiles = this._queueWaitId ? []
            : [...(offered ? [offered.file] : []), ...this._filesQueue];
        if (!outgoing && !incoming && !pendingFiles.length) { this.abortAll(reason, true); return false; }
        if (offered) {
            clearTimeout(offered.timer);
            this._outgoing = null;
            this._progress(offered, 'reconnecting');
        }
        if (this._queueWaitId && this._filesQueue.length)
            Events.fire('notify-user', '上一文件仍待保存，重连后请重新选择剩余文件');
        if (this._outgoing && !outgoing) this.cancel(this._outgoing.meta.id, reason, false);
        if (this._incoming && !incoming) this.cancel(this._incoming.meta.id, reason, false, true);
        const deadline = Date.now() + 120000;
        for (const state of [outgoing, incoming]) {
            if (!state) continue;
            // A restored transfer can reuse the same state object on the same
            // RTCPeer. Object identity alone cannot retire an old asynchronous
            // File read, drain waiter or prefix hash from the previous attempt.
            if (state === outgoing) { state.sendEpoch = (state.sendEpoch || 0) + 1; this._cancelPrefixRead(state); state.resumeBusy = false; }
            state.resumeDeadline = Math.min(state.resumeDeadline || deadline, deadline);
            clearTimeout(state.timer);
            state.awaitingResume = true;
            this._progress(state, 'reconnecting');
        }
        const hold = { outgoing, incoming, pendingFiles, queueBlocked: this._queueBlocked,
            deadline: Math.min(deadline, ...[outgoing, incoming].filter(Boolean).map(state => state.resumeDeadline)) };
        // An in-flight sink.write may finish after the transport disappears. Its
        // hash/offset is accounted for before the receiver advertises a prefix.
        this._held = hold;
        this._outgoing = null; this._incoming = null;
        this._filesQueue = []; this._queueWaitId = null; this._discard = null;
        if (outgoing?.waiter) { const waiter = outgoing.waiter; outgoing.waiter = null; waiter.reject(Error('正在恢复连接')); }
        hold.ready = this._messageChain.catch(() => {});
        hold.timer = setTimeout(() => this._dropHeld('续传窗口已过期，请重新选择文件'), Math.max(0, hold.deadline - Date.now()));
        this._queueEvent();
        return true;
    }
    _dropHeld(reason) {
        const hold = this._held; if (!hold) return;
        this._held = null; clearTimeout(hold.timer); this._pendingResumeOffer = null;
        this._cleanupHeld(hold, reason);
        this._queueEvent();
    }
    _cleanupHeld(hold, reason) {
        if (hold.cleanupStarted) return;
        hold.cleanupStarted = true;
        hold.cancelled = reason || '旧传输已取消';
        clearTimeout(hold.timer);
        // Drop references to local File objects once recovery is no longer authorized.
        hold.pendingFiles = [];
        for (const state of [hold.outgoing, hold.incoming]) {
            if (!state) continue;
            // An already-started write still contributes to the digest before
            // storage is parked, even if its old peer no longer holds the slot.
            const previousCleanup = state.heldCleanup;
            const cleanup = { hold, ready: Promise.all([hold.ready, previousCleanup?.ready]) };
            state.heldCleanup = cleanup;
            // A write begun on the old peer may fail only after its checkpoint
            // was adopted. Route that failure to the current object owner;
            // transfer ID alone could target an unrelated, replayed new offer.
            if (state.resumeOwner && state.resumeOwner !== this) {
                const owner = state.resumeOwner;
                if (owner._incoming !== state && owner._outgoing !== state
                    && ![owner._held?.incoming, owner._held?.outgoing].includes(state)) {
                    if (state.heldCleanup === cleanup) state.heldCleanup = previousCleanup;
                    continue;
                }
                if (owner._held === hold) owner._dropHeld(reason); // detach the same shared slot; cleanup remains here
                else {
                    owner._cancelTransferredState(state, reason, true);
                    continue;
                }
            }
            clearTimeout(state.timer); state.error = reason;
            state.waiter?.reject(Error(reason));
            if (state.sink) {
                const sink = state.sink, durable = typeof sink.park === 'function';
                const disposal = cleanup.ready.then(() => durable
                    ? sink.park(this._checkpointHash(state)) : sink.abort());
                // A failed durable checkpoint publication does not invalidate
                // the previously committed prefix. Ordinary sinks still abort.
                disposal.catch(() => { if (durable) this._notifyCheckpointFailure(); })
                    .finally(() => { if (state.heldCleanup === cleanup) state.heldCleanup = null; });
            } else {
                cleanup.ready.finally(() => { if (state.heldCleanup === cleanup) state.heldCleanup = null; });
            }
            this._progress(state, 'cancelled');
            Events.fire('file-offer-cancelled', { id: state.meta.id, sender: this._peerId });
        }
        Events.fire('notify-user', reason);
    }
    _cancelTransferredState(state, reason, keepDurable = false) {
        if (this._incoming === state || this._outgoing === state) this.cancel(state.meta.id, reason, true, keepDurable);
        else if (this._held && [this._held.incoming, this._held.outgoing].includes(state)) this.cancel(state.meta.id, reason, true, keepDurable);
    }
    _receiveStorageFailure(state, error) {
        // A write/checkpoint begun on an obsolete peer may settle only after
        // adoption. Identity is the state object, never a replayable file ID.
        const owner = state.resumeOwner || this;
        if (owner._incoming === state || owner._held?.incoming === state)
            owner.cancel(state.meta.id, saveError(error), true, true);
    }
    _checkpointHash(state) {
        return typeof state.verifiedFinalSha256 === 'string' && /^[a-f0-9]{64}$/.test(state.verifiedFinalSha256)
            ? state.verifiedFinalSha256 : hex(state.hash.clone().digest());
    }
    takeHeldTransfers() { return this._held; }
    adoptHeldTransfers(hold) {
        if (!hold || hold.cancelled || this._held || this._incoming || this._outgoing) return false;
        if (Date.now() >= hold.deadline) {
            this._cleanupHeld(hold, '续传窗口已过期，请重新选择文件');
            return false;
        }
        clearTimeout(hold.timer);
        this._held = hold;
        for (const state of [hold.incoming, hold.outgoing]) if (state) state.resumeOwner = this;
        hold.timer = setTimeout(() => this._dropHeld('续传窗口已过期，请重新选择文件'), Math.max(0, hold.deadline - Date.now()));
        this.restoreTransfers(); return true;
    }
    restoreTransfers() {
        if (!this._canSend()) return false;
        const hold = this._held;
        if (hold) {
            if (hold.cancelled) { this._dropHeld(hold.cancelled); return false; }
            if (Date.now() >= hold.deadline) { this._dropHeld('续传窗口已过期，请重新选择文件'); return false; }
            clearTimeout(hold.timer); this._held = null;
            this._resumeReady = hold.ready;
            this._incoming = hold.incoming; this._outgoing = hold.outgoing;
            this._filesQueue = hold.pendingFiles || [];
            this._queueBlocked = !!hold.queueBlocked;
            hold.pendingFiles = [];
            for (const state of [this._incoming, this._outgoing]) {
                if (!state) continue;
                state.timer = setTimeout(() => this.cancel(state.meta.id, '续传协商超时'), Math.max(0, state.resumeDeadline - Date.now()));
            }
            if (this._outgoing) {
                this._outgoing.phase = 'resuming';
                this.sendJSON({ type: 'resume-offer', ...this._outgoing.meta });
            } else if (this._filesQueue.length) {
                // A previously offered but unaccepted file gets a fresh offer
                // and must receive fresh explicit user consent after reconnection.
                this._dequeueFile();
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
    _cancelPrefixRead(state) {
        const job = state?.prefixJob;
        if (!job) return;
        job.cancelled = true;
        job.cancelRead?.();
        job.cancelRead = null;
    }
    _notifyCheckpointFailure() {
        Events.fire('notify-user', '本机断点保存失败，请在本机暂存管理中检查此前检查点后重试');
    }
    _readPrefixChunk(job, file, start, end) {
        if (job.cancelled) return Promise.resolve({ cancelled: true });
        if (prefixReadsInFlight >= MAX_PREFIX_READS) return Promise.resolve({ busy: true });
        prefixReadsInFlight++;
        return new Promise(resolve => {
            let settled = false;
            const finish = result => {
                if (settled) return;
                settled = true;
                if (job.cancelRead === cancel) job.cancelRead = null;
                resolve(result);
            };
            const cancel = () => finish({ cancelled: true });
            job.cancelRead = cancel;
            // Both late outcomes are consumed even after cancellation. Only
            // actual I/O completion releases the global read reservation.
            Promise.resolve().then(() => job.cancelled ? null : file.slice(start, end).arrayBuffer()).then(
                bytes => { prefixReadsInFlight--; finish(bytes === null ? { cancelled: true } : { bytes }); },
                error => { prefixReadsInFlight--; finish({ error }); }
            );
            if (job.cancelled) cancel();
        });
    }
    async _resumeFromOffset(msg, stillCurrent = null) {
        const state = this._outgoing;
        if (!state || !['resuming', 'offered'].includes(state.phase) || msg.id !== state.meta.id
            || !Number.isSafeInteger(msg.offset) || msg.offset < 0 || msg.offset > state.meta.size
            || typeof msg.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(msg.sha256)
            || !this._verified || !this._path?.direct) throw Error('无效的续传确认');
        if (state.resumeBusy) throw Error('重复续传确认');
        const epoch = state.sendEpoch || 0;
        const job = { cancelled: false, done: false, cancelRead: null };
        state.prefixJob = job;
        const current = () => this._outgoing === state && (state.sendEpoch || 0) === epoch
            && !job.cancelled && (!stillCurrent || stillCurrent()) && this._verified && this._path?.direct;
        state.resumeBusy = true; state.phase = 'resuming';
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { if (current()) this.cancel(msg.id, '本机前缀比对超时'); }, 5 * 60 * 1000);
        const hash = window.ZeydropHash.create();
        try {
            for (let pos = 0; pos < msg.offset; pos += WINDOW_SIZE) {
                const end = Math.min(pos + WINDOW_SIZE, msg.offset);
                const result = await this._readPrefixChunk(job, state.file, pos, end);
                if (!current() || result.cancelled) return;
                if (result.busy) { this.cancel(msg.id, '前次文件读取尚未结束，请稍后重试或重新发送完整文件'); return; }
                if (result.error) throw result.error;
                let length;
                try { length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(result.bytes); }
                catch { throw Error('本机文件读取结果无效'); }
                if (length !== end - pos) throw Error('本机文件读取长度不一致');
                hash.update(new Uint8Array(result.bytes));
            }
            if (hex(hash.clone().digest()) !== msg.sha256) {
                this.cancel(msg.id, '文件前缀与接收方记录不一致，已取消续传');
                return;
            }
            if (!current()) return;
            state.hash = hash; state.offset = msg.offset; state.acked = msg.offset;
            state.phase = 'sending'; state.resumeBusy = false;
            clearTimeout(state.timer);
            this.sendJSON({ type: 'resume-confirm', id: msg.id, offset: msg.offset, sha256: msg.sha256 });
            this._pump(state).catch(error => { if (current()) this.cancel(msg.id, error.message); });
        } catch (error) { if (!current()) return; throw error; }
        finally {
            job.done = true;
            if (state.prefixJob === job) state.prefixJob = null;
        }
    }
    async acceptIncoming(id, options = {}) {
        const state = this._incoming;
        if (!state || state.meta.id !== id || state.sink || state.accepting) return;
        let prefixJob = null;
        const authorized = () => this._incoming === state && this._verified
            && (!prefixJob || !prefixJob.cancelled) && this._path?.direct && this._remoteHello && this._isConnected();
        if (!authorized()) { this.cancel(id, '请重新核对直连状态和安全码后接收'); return; }
        state.accepting = true;
        // Keep a preparing sink local. A persistent writer may already contain
        // N bytes while its prefix hash/transfer offset are still unverified.
        // Publishing it early would let suspendTransfers retain it as offset 0.
        let preparingSink = null, parkOriginal = null, provenPrefixMismatch = false;
        const cancelStale = () => { if (this._incoming === state) this.cancel(id, '接收准备已失效，请重新确认'); };
        try {
            if (options.resumeLocalId) {
                if (!window.ZeydropRecovery?.supported) throw Error('此浏览器无法读取本机断点');
                // Only a fresh, explicitly accepted offer may attach a stored partial.
                this.sendJSON({ type: 'resume-preparing', id });
                clearTimeout(state.timer);
                state.timer = setTimeout(() => this.cancel(id, '读取本机断点超时'), 5 * 60 * 1000);
                const { sink, snapshot, offset, prefixSha256 } =
                    await window.ZeydropRecovery.restore(options.resumeLocalId, state.meta);
                preparingSink = sink;
                prefixJob = { cancelled: false, done: false, cancelRead: null };
                state.prefixJob = prefixJob;
                let parkPromise = null;
                parkOriginal = async (reason = '接收准备已失效，请重新确认') => {
                    // Cancelling/reconnecting during preparation does not delete
                    // the committed prefix. Capture this exact sink once, never
                    // a newer incoming state or a re-used local-file ID. Clear
                    // local ownership before awaiting the storage RPC: failure
                    // to park must not fall through to deleting the original.
                    if (!parkPromise) {
                        const original = preparingSink; preparingSink = null;
                        parkPromise = Promise.resolve().then(() => original.park(prefixSha256));
                    }
                    await parkPromise;
                    if (this._incoming === state) this.cancel(id, reason);
                };
                if (!authorized()) { await parkOriginal(); return; }
                const hash = window.ZeydropHash.create();
                for (let pos = 0; pos < offset; pos += WINDOW_SIZE) {
                    const end = Math.min(pos + WINDOW_SIZE, offset);
                    const result = await this._readPrefixChunk(prefixJob, snapshot, pos, end);
                    if (!authorized() || result.cancelled) { await parkOriginal(); return; }
                    if (result.busy) { await parkOriginal('前次文件读取尚未结束，请稍后重试本机断点'); return; }
                    if (result.error) throw result.error;
                    let length;
                    try { length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(result.bytes); }
                    catch { throw Error('本机断点读取结果无效'); }
                    if (length !== end - pos) throw Error('本机断点读取长度不一致');
                    hash.update(new Uint8Array(result.bytes));
                }
                if (!authorized()) { await parkOriginal(); return; }
                const digest = hash.clone().digest();
                if (!(digest instanceof Uint8Array) || digest.byteLength !== 32 || !/^[a-f0-9]{64}$/.test(prefixSha256))
                    throw Error('本机断点校验结果无效');
                if (hex(digest) !== prefixSha256) {
                    provenPrefixMismatch = true;
                    throw Error('本机断点校验失败，请删除断点后重新接收');
                }
                state.hash = hash; state.offset = offset; state.acked = offset;
                // No await separates validation from ownership handoff. Once
                // published, ordinary active-transfer cancellation owns this
                // sink; the old preparation must never park it afterwards.
                prefixJob.done = true; state.prefixJob = null;
                state.sink = preparingSink; preparingSink = null;
                parkOriginal = null;
                state.awaitingResume = true; state.accepting = false;
                clearTimeout(state.timer);
                state.timer = setTimeout(() => this.cancel(id, '续传协商超时'), 120000);
                this.sendJSON({ type: 'resume-at', id, offset, sha256: prefixSha256 });
                this._progress(state, 'resuming');
                return;
            }
            preparingSink = await ReceiveSink.open(state.meta, options);
            if (!authorized()) { await preparingSink.abort(); preparingSink = null; cancelStale(); return; }
            state.sink = preparingSink; preparingSink = null; state.accepting = false; clearTimeout(state.timer);
            state.timer = setTimeout(() => this.cancel(id, '接收传输超时'), 12 * 60 * 60 * 1000);
            this.sendJSON({ type: 'accept', id });
            this._progress(state, 'receiving');
        } catch (error) {
            if (parkOriginal && !provenPrefixMismatch) {
                // Read/hash engine failures are not proof of corrupt bytes.
                // Preserve the exact original checkpoint even if parking fails.
                try { await parkOriginal(error.name === 'AbortError' ? '已取消保存' : error.message); }
                catch { this._notifyCheckpointFailure(); }
            } else if (preparingSink) { try { await preparingSink.abort(); } catch {} }
            if (this._incoming === state) this.cancel(id, error.name === 'AbortError' ? '已取消保存' : error.message);
        } finally {
            if (prefixJob) {
                prefixJob.done = true;
                if (state.prefixJob === prefixJob) state.prefixJob = null;
            }
        }
    }
    rejectIncoming(id) { if (this._incoming?.meta.id === id) this.cancel(id, '已拒绝接收'); }
    _protocolReady() { return this._remoteHello; }
    _canSend() { return this._verified && this._path?.direct && this._protocolReady() && this._isConnected(); }
    _queueEvent() {
        Events.fire('send-queue-state', { peerId: this._peerId, count: this._filesQueue.length + (this._held?.pendingFiles?.length || 0),
            blocked: this._held ? !!this._held.queueBlocked : this._queueBlocked,
            busy: !!(this._outgoing || this._queueWaitId || this._held?.outgoing), ready: !this._held && !!this._canSend() });
    }
    _forgetRetry(id) {
        const entry = this._retryFiles.get(id); if (!entry) return;
        clearTimeout(entry.timer); this._retryFiles.delete(id);
        Events.fire('transfer-retry-state', { peerId: this._peerId, id, available: false });
    }
    _clearRetries() { for (const id of this._retryFiles.keys()) this._forgetRetry(id); }
    _rememberRetry(state) {
        // Keep only File references in this page, never chunks, handles or signaling data.
        while (this._retryFiles.size >= 30) this._forgetRetry(this._retryFiles.keys().next().value);
        const entry = { file: state.file, expires: Date.now() + 15 * 60 * 1000 };
        entry.timer = setTimeout(() => this._forgetRetry(state.meta.id), 15 * 60 * 1000);
        entry.timer.unref?.();
        this._retryFiles.set(state.meta.id, entry);
    }
    retryFile(id) {
        const entry = this._retryFiles.get(id);
        if (!entry) return false;
        if (Date.now() >= entry.expires) { this._forgetRetry(id); return false; }
        if (!this._canSend() || this._outgoing || this._queueWaitId || this._held)
            return Events.fire('notify-user', '请等待当前文件结束，并重新确认直连和安全码后再发送');
        if (this._filesQueue.length >= 100) return false;
        this._filesQueue.unshift(entry.file); this._forgetRetry(id);
        this._queueBlocked = false; this._dequeueFile(); return true;
    }
    continueQueue() { if (this._canSend()) { this._queueBlocked = false; this._dequeueFile(); } }
    clearQueue() {
        this._filesQueue = []; this._queueBlocked = false;
        if (this._held) { this._held.pendingFiles = []; this._held.queueBlocked = false; }
        this._queueEvent();
    }
    sendFiles(files) {
        if (!this._canSend()) return Events.fire('notify-user', '请先等待直连就绪并核对两台设备的安全码');
        if (files.length + this._filesQueue.length + (this._outgoing ? 1 : 0) > 100) return Events.fire('notify-user', '每次最多排队 100 个文件');
        if (!this._filesQueue.length) this._queueBlocked = false;
        this._filesQueue.push(...Array.from(files)); this._dequeueFile(); return true;
    }
    _dequeueFile() {
        if (this._queueBlocked || this._outgoing || this._queueWaitId || !this._filesQueue.length || !this._canSend()) { this._queueEvent(); return; }
        const file = this._filesQueue.shift();
        const state = { file, meta: { id: crypto.randomUUID(), name: safeName(file.name), size: file.size, mime: safeMime(file.type) }, phase: 'offered', offset: 0, acked: 0, hash: window.ZeydropHash.create(), start: performance.now() };
        this._outgoing = state;
        state.timer = setTimeout(() => this.cancel(state.meta.id, '对方未确认，邀请接收已取消'), 120000);
        this.sendJSON({ type: 'offer', ...state.meta }); this._progress(state, 'offered');
        this._queueEvent();
    }
    async _pump(state) {
        const epoch = state.sendEpoch || 0;
        const current = () => this._outgoing === state && (state.sendEpoch || 0) === epoch
            && state.phase === 'sending' && !state.resumeBusy && this._verified && this._path?.direct;
        try {
            while (state.offset < state.meta.size) {
                if (!current()) return;
                if (state.paused || state.remotePaused) {
                    await new Promise(resolve => setTimeout(resolve, 100)); continue;
                }
                const limit = Math.min(state.offset + WINDOW_SIZE, state.meta.size);
                while (state.offset < limit) {
                    if (!current()) return;
                    await this._waitForDrain();
                    if (!current()) return;
                    const bytes = await state.file.slice(state.offset, Math.min(state.offset + CHUNK_SIZE, limit)).arrayBuffer();
                    if (!current()) return;
                    state.hash.update(new Uint8Array(bytes)); this._send(bytes); state.offset += bytes.byteLength;
                }
                state.expectedAck = state.offset;
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => { state.waiter = null; reject(Error('接收写入确认超时')); }, 30000);
                    state.waiter = { resolve: () => { clearTimeout(timeout); resolve(); }, reject: error => { clearTimeout(timeout); reject(error); } };
                    this.sendJSON({ type: 'checkpoint', id: state.meta.id, offset: state.offset });
                });
            }
            if (!current()) return;
            state.sha256 = hex(state.hash.digest()); state.phase = 'verifying';
            state.timer = setTimeout(() => this.cancel(state.meta.id, '对方校验或保存超时'), 60000);
            this.sendJSON({ type: 'finish', id: state.meta.id, sha256: state.sha256 }); this._progress(state, 'verifying');
        } catch (error) { if (current()) throw error; }
    }
    _progress(state, phase) {
        const bytes = state.acked ?? state.offset;
        if ((state.paused || state.remotePaused) && ['receiving', 'sending'].includes(phase)) phase = 'paused';
        const now = performance.now();
        if (state.uiPhase === phase && now - (state.lastUI || 0) < 200) return;
        const running = ['sending','receiving'].includes(phase);
        // Recent persisted progress, not a lifetime average diluted by long
        // pauses or prefix rehashing. At most 20 points, sampled at UI cadence.
        if (!running || state.uiPhase !== phase) state.rateSamples = [];
        const samples = state.rateSamples ||= [];
        if (running) {
            samples.push({ at: now, bytes });
            while (samples.length > 1 && (samples[0].at < now - 3000 || samples.length > 20)) samples.shift();
        }
        const first = samples[0], elapsed = first ? (now - first.at) / 1000 : 0;
        const speed = running && elapsed > 0 ? Math.max(0, (bytes - first.bytes) / elapsed) : 0;
        state.uiPhase = phase; state.lastUI = now;
        Events.fire('transfer-state', { peerId: this._peerId, id: state.meta.id, name: state.meta.name, phase, retryable: this._retryFiles.has(state.meta.id), error: state.error || null, bytes: phase === 'complete' ? state.meta.size : bytes, size: state.meta.size, progress: state.meta.size ? bytes / state.meta.size : 0, speed, eta: speed ? (state.meta.size - bytes) / speed : null });
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
        if (outgoing) {
            state.sendEpoch = (state.sendEpoch || 0) + 1; this._outgoing = null; state.waiter?.reject(Error(reason));
            this._cancelPrefixRead(state);
            if (!this._aborting) { this._rememberRetry(state); this._queueBlocked = true; }
        }
        if (incoming) {
            if (state.sink) this._discard = { id, remaining: WINDOW_SIZE };
            this._incoming = null;
            this._cancelPrefixRead(state);
            if (keepDurable && typeof state.sink?.park === 'function') {
                state.preserveDurableResult = true;
                const sink = state.sink;
                const cleanup = state.heldCleanup;
                Promise.all([this._messageChain, cleanup?.ready]).then(() => sink.park(this._checkpointHash(state)))
                    .catch(() => this._notifyCheckpointFailure())
                    .finally(() => { if (state.heldCleanup === cleanup) state.heldCleanup = null; });
            } else state.sink?.abort();
        }
        if (notify && this._isConnected()) this.sendJSON({ type: 'cancel', id });
        this._progress(state, 'cancelled');
        Events.fire('file-offer-cancelled', { id, sender: this._peerId });
        Events.fire('notify-user', reason);
        this._queueEvent();
    }
    abortAll(reason, keepDurable = false) {
        this._aborting = true;
        if (this._outgoing) this.cancel(this._outgoing.meta.id, reason, false);
        if (this._incoming) this.cancel(this._incoming.meta.id, reason, false, keepDurable);
        this._filesQueue = []; this._queueWaitId = null; this._discard = null;
        this._queueBlocked = false; this._clearRetries(); this._aborting = false;
        this._dropHeld(reason);
        this._queueEvent();
    }
    sendText(text) {
        if (!this._canSend()) return Events.fire('notify-user', '请等待对方就绪并核对安全码');
        if (text.length > 4096) return Events.fire('notify-user', '文本最多 4096 字符');
        this.sendJSON({ type: 'text', text });
    }
    _protocolError(reason) { this.abortAll(reason); this.close(reason); Events.fire('notify-user', reason); }
}
