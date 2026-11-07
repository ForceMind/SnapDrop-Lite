'use strict';
// Incremental file hashes stay in this browser. No file identifiers, names,
// pairing data, hash state or content are sent to a network service.
const ZEYDROP_STREAM_HASH_SCRIPT = globalThis.document?.currentScript?.src;
class ZeydropStreamHasher {
    static MAX_HANDLES = 4;
    static MAX_PENDING = 4;
    static CHUNK_BYTES = 256 * 1024;
    static TIMEOUT_MS = 30000;
    constructor(options = {}) {
        this._Worker = Object.hasOwn(options, 'Worker') ? options.Worker : globalThis.Worker;
        this._factory = options.hashFactory || (() => window.ZeydropHash?.create());
        this._timeout = options.timeoutMs ?? ZeydropStreamHasher.TIMEOUT_MS;
        if (!Number.isSafeInteger(this._timeout) || this._timeout < 1 || this._timeout > 5 * 60 * 1000)
            throw TypeError('无效的增量校验超时');
        const source = options.scriptUrl ?? ZEYDROP_STREAM_HASH_SCRIPT;
        if (options.workerUrl) this._url = options.workerUrl;
        else if (source) {
            const url = new URL('stream-hash-worker.js', source);
            url.search = new URL(source).search; url.hash = ''; this._url = url.href;
        }
        this._handles = new Set(); this._sequence = 0;
        globalThis.addEventListener?.('pagehide', () => this.disposeAll());
    }
    _error(name) {
        const messages = {
            AbortError: '增量文件校验已取消', HashBusyError: '本机增量校验任务过多，请稍后重试',
            HashTimeoutError: '增量文件校验超时，请重新发送或恢复文件',
            HashWorkerError: '本机增量校验进程已中断，请重试',
            HashProtocolError: '本机增量校验状态异常，请重新发送或恢复文件',
            HashReadError: '无法完成本机增量文件校验', HashClosedError: '本机增量校验任务已结束'
        };
        const error = Error(messages[name] || messages.HashReadError); error.name = name; return error;
    }
    create() {
        if (this._handles.size >= ZeydropStreamHasher.MAX_HANDLES || !Number.isSafeInteger(this._sequence)
            || this._sequence < 0 || this._sequence >= Number.MAX_SAFE_INTEGER)
            throw this._error('HashBusyError');
        const handle = new ZeydropStreamHashHandle(this, ++this._sequence);
        this._handles.add(handle); return handle;
    }
    disposeAll() { for (const handle of [...this._handles]) handle.dispose(); }
}
class ZeydropStreamHashHandle {
    constructor(manager, session) {
        this._manager = manager; this._session = session;
        this.backend = typeof manager._Worker === 'function' ? 'worker' : 'main';
        this.bytes = 0; this.closed = false;
        this._worker = null; this._hash = null; this._initialized = false;
        this._active = null; this._queue = []; this._request = 0; this._completed = 0;
        this._reservedBytes = 0; this._finalQueued = false; this._scheduled = false;
    }
    _error(name) { return this._manager._error(name); }
    _capacity() {
        if (this.closed || this._finalQueued) throw this._error('HashClosedError');
        if (this._queue.length + (this._active ? 1 : 0) >= ZeydropStreamHasher.MAX_PENDING)
            throw this._error('HashBusyError');
        if (!Number.isSafeInteger(this._request) || this._request < 0 || this._request >= Number.MAX_SAFE_INTEGER)
            throw this._error('HashProtocolError');
    }
    _view(input) {
        // Use intrinsic getters, accepting cross-realm buffers/views without
        // trusting shadowed .buffer/.byteLength properties or lookalikes.
        const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
        let buffer, offset = 0, size;
        try { size = length.call(input); buffer = input; }
        catch {
            if (!ArrayBuffer.isView(input)) throw TypeError('校验分块必须是原生二进制缓冲');
            let proto = Object.getPrototypeOf(Uint8Array.prototype);
            try {
                buffer = Object.getOwnPropertyDescriptor(proto, 'buffer').get.call(input);
                size = Object.getOwnPropertyDescriptor(proto, 'byteLength').get.call(input);
                offset = Object.getOwnPropertyDescriptor(proto, 'byteOffset').get.call(input);
            } catch {
                proto = DataView.prototype;
                buffer = Object.getOwnPropertyDescriptor(proto, 'buffer').get.call(input);
                size = Object.getOwnPropertyDescriptor(proto, 'byteLength').get.call(input);
                offset = Object.getOwnPropertyDescriptor(proto, 'byteOffset').get.call(input);
            }
            length.call(buffer); // SharedArrayBuffer and detached buffers fail closed.
        }
        if (!Number.isSafeInteger(size) || size < 0 || size > ZeydropStreamHasher.CHUNK_BYTES)
            throw RangeError('每个增量校验分块最多 256 KiB');
        return new Uint8Array(buffer, offset, size);
    }
    update(input) {
        try {
            this._capacity(); const view = this._view(input);
            if (!Number.isSafeInteger(this._reservedBytes + view.byteLength)) throw this._error('HashProtocolError');
            const copy = new Uint8Array(view.byteLength); copy.set(view);
            this._reservedBytes += copy.byteLength;
            return this._enqueue({ type: 'update', chunk: copy, size: copy.byteLength, target: this._reservedBytes });
        } catch (error) { return Promise.reject(error); }
    }
    digestHex(options = {}) {
        try {
            this._capacity();
            if (!options || typeof options !== 'object' || Array.isArray(options)
                || Object.keys(options).some(key => key !== 'final')
                || (options.final !== undefined && typeof options.final !== 'boolean')) throw TypeError('无效的摘要选项');
            const final = options.final === true;
            if (final) this._finalQueued = true;
            return this._enqueue({ type: 'digest', final, target: this._reservedBytes });
        } catch (error) { return Promise.reject(error); }
    }
    _enqueue(value) {
        return new Promise((resolve, reject) => {
            this._queue.push({ ...value, request: ++this._request, resolve, reject }); this._schedule();
        });
    }
    _schedule() {
        if (this._scheduled || this.closed) return;
        this._scheduled = true;
        queueMicrotask(() => { this._scheduled = false; this._pump(); });
    }
    _pump() {
        if (this.closed || this._active || !this._queue.length) return;
        const job = this._active = this._queue.shift();
        job.timer = setTimeout(() => this._fatal('HashTimeoutError'), this._manager._timeout);
        if (this.backend === 'main') { this._main(job); return; }
        try {
            if (!this._worker) {
                if (!this._manager._url) throw this._error('HashWorkerError');
                const worker = this._worker = new this._manager._Worker(this._manager._url);
                worker.onmessage = event => { try { this._message(worker, event.data); } catch { this._fatal('HashProtocolError'); } };
                const failed = event => {
                    event?.preventDefault?.();
                    if (this._worker === worker && !this.closed) this._fatal('HashWorkerError');
                    return true;
                };
                worker.onerror = failed; worker.onmessageerror = failed;
                worker.postMessage({ type: 'init', session: this._session, request: 0 });
            } else this._post(job);
        } catch { this._fatal('HashWorkerError'); }
    }
    _post(job) {
        if (this.closed || this._active !== job) return;
        if (job.type === 'update') {
            // Only our bounded copy is transferred; the caller's bytes remain
            // usable for DataChannel send, native writes and diagnostics.
            const chunk = job.chunk.buffer;
            this._worker.postMessage({ type: 'update', session: this._session, request: job.request,
                offset: job.target - job.size, chunk }, [chunk]);
            job.chunk = null;
        } else this._worker.postMessage({ type: 'digest', session: this._session, request: job.request,
            offset: job.target, final: job.final });
    }
    _keys(value, keys) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
    }
    _message(worker, data) {
        if (this.closed || this._worker !== worker) return;
        if (!data || data.session !== this._session || !Number.isSafeInteger(data.request) || data.request < 0)
            return this._fatal('HashProtocolError');
        const job = this._active;
        if (!job) {
            if (data.request <= this._completed) return;
            return this._fatal('HashProtocolError');
        }
        if (!this._initialized) {
            if (!this._keys(data, ['type', 'session', 'request', 'bytes']) || data.type !== 'ready'
                || data.request !== 0 || data.bytes !== 0) return this._fatal('HashProtocolError');
            this._initialized = true;
            try { this._post(job); } catch { this._fatal('HashWorkerError'); }
            return;
        }
        if (data.request < job.request) return;
        if (data.request !== job.request) return this._fatal('HashProtocolError');
        if (data.type === 'error') {
            if (!this._keys(data, ['type', 'session', 'request', 'errorName'])
                || !['HashReadError', 'HashProtocolError'].includes(data.errorName)) return this._fatal('HashProtocolError');
            return this._fatal(data.errorName);
        }
        if (job.type === 'update') {
            if (!this._keys(data, ['type', 'session', 'request', 'bytes']) || data.type !== 'updated'
                || data.bytes !== job.target || job.target !== this.bytes + job.size) return this._fatal('HashProtocolError');
            this.bytes = data.bytes; this._complete(job); return;
        }
        if (!this._keys(data, ['type', 'session', 'request', 'bytes', 'sha256', 'final']) || data.type !== 'digest'
            || data.bytes !== job.target || data.bytes !== this.bytes || data.final !== job.final
            || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) return this._fatal('HashProtocolError');
        this._complete(job, data.sha256);
    }
    _main(job) {
        try {
            if (!this._hash) this._hash = this._manager._factory();
            if (!this._hash?.update || !this._hash?.clone || !this._hash?.digest) throw this._error('HashReadError');
            if (job.type === 'update') {
                this._hash.update(job.chunk); this.bytes = job.target;
                this._complete(job); return;
            }
            const digest = (job.final ? this._hash : this._hash.clone()).digest();
            const bytes = this._view(digest);
            if (bytes.byteLength !== 32) throw this._error('HashReadError');
            const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            this._complete(job, value);
        } catch { this._fatal('HashReadError'); }
    }
    _complete(job, value) {
        if (this.closed || this._active !== job) return;
        clearTimeout(job.timer); job.chunk = null; this._active = null; this._completed = job.request;
        if (job.final) this._close();
        job.resolve(value); this._schedule();
    }
    _close(error) {
        if (this.closed) return;
        this.closed = true;
        const worker = this._worker; this._worker = null;
        try { worker?.terminate(); } catch {}
        try { this._hash?.destroy?.(); } catch {}
        this._hash = null;
        const jobs = this._active ? [this._active, ...this._queue] : [...this._queue];
        this._active = null; this._queue = [];
        for (const job of jobs) { clearTimeout(job.timer); job.chunk = null; job.reject(error || this._error('HashClosedError')); }
        this._manager._handles.delete(this);
    }
    _fatal(name) { this._close(this._error(name)); }
    dispose() { this._close(this._error('AbortError')); }
}
window.ZeydropStreamHash = new ZeydropStreamHasher();
