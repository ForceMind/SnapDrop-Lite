'use strict';
// File references are transient. Only bounded slices enter the hasher; no
// content, file name, pairing identity or hash is sent to a network service.
class ZeydropFileHasher {
    static CHUNK_BYTES = 256 * 1024;
    static MAX_QUEUED = 4;
    static TIMEOUT_MS = 5 * 60 * 1000;
    static ERROR_NAMES = ['AbortError','NotReadableError','NotFoundError','SecurityError','NotAllowedError',
        'InvalidStateError','DataError','QuotaExceededError','UnknownError','HashReadError'];
    constructor(options = {}) {
        this._Worker = Object.hasOwn(options,'Worker') ? options.Worker : globalThis.Worker;
        this._factory = options.hashFactory || (() => window.ZeydropHash?.create());
        this._now = options.now || Date.now;
        this._timeout = options.timeoutMs ?? ZeydropFileHasher.TIMEOUT_MS;
        if (!Number.isSafeInteger(this._timeout) || this._timeout < 1 || this._timeout > 24 * 60 * 60 * 1000)
            throw TypeError('无效的文件校验超时');
        const source = options.scriptUrl ?? globalThis.document?.currentScript?.src;
        if (options.workerUrl) this._url = options.workerUrl;
        else if (source) { const url = new URL('file-hash-worker.js',source); url.search = new URL(source).search; this._url = url.href; }
        this._queue = []; this._active = null; this._worker = null; this._sequence = 0;
        globalThis.addEventListener?.('pagehide', () => this.cancelAll());
    }
    _error(name) {
        const error = Error(name === 'AbortError' ? '文件校验已取消' : name === 'HashBusyError' ? '待校验文件过多，请稍后重试'
            : name === 'HashTimeoutError' ? '文件校验超时，请重新选择原文件'
            : name === 'HashProtocolError' || name === 'HashWorkerError' ? '文件校验进程已中断，请重试'
            : name === 'HashUnsupportedError' ? '此浏览器无法校验文件' : '无法读取原文件，请重新选择');
        error.name = name; return error;
    }
    _size(blob) {
        // Native brand check accepts File and cross-realm Blob, not metadata
        // lookalikes with attacker-controlled slice/size methods.
        const size = Object.getOwnPropertyDescriptor(Blob.prototype,'size').get.call(blob);
        if (!Number.isSafeInteger(size) || size < 0) throw TypeError('无效的文件大小');
        return size;
    }
    hash(blob, {signal,onProgress} = {}) {
        let size;
        try {
            size = this._size(blob);
            if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
                || typeof signal.removeEventListener !== 'function')) throw TypeError('无效的取消信号');
            if (onProgress !== undefined && typeof onProgress !== 'function') throw TypeError('无效的校验进度回调');
            if (signal?.aborted) throw this._error('AbortError');
            if (this._queue.length >= ZeydropFileHasher.MAX_QUEUED) throw this._error('HashBusyError');
            if (!Number.isSafeInteger(this._sequence + 1)) throw this._error('HashBusyError');
        } catch (error) { return Promise.reject(error); }
        return new Promise((resolve,reject) => {
            const job = {id:++this._sequence,blob,size,signal,onProgress,resolve,reject,bytes:0,lastProgress:-Infinity,done:false};
            job.abort = () => this._finish(job,this._error('AbortError'),null,this._active === job);
            signal?.addEventListener('abort',job.abort,{once:true});
            job.timer = setTimeout(() => this._finish(job,this._error('HashTimeoutError'),null,this._active === job),this._timeout);
            this._queue.push(job); this._pump();
        });
    }
    _dropWorker() {
        const worker = this._worker; this._worker = null;
        try { worker?.terminate(); } catch {}
    }
    _finish(job,error,result,drop = false) {
        if (job.done) return;
        job.done = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort',job.abort);
        this._queue = this._queue.filter(item => item !== job);
        if (this._active === job) this._active = null;
        if (drop) this._dropWorker();
        job.blob = null; job.onProgress = null;
        if (error) job.reject(error); else job.resolve(result);
        queueMicrotask(() => this._pump());
    }
    cancelAll() {
        const jobs = [...this._queue]; if (this._active) jobs.unshift(this._active);
        this._queue = []; this._dropWorker();
        for (const job of jobs) this._finish(job,this._error('AbortError'));
    }
    _progress(job,bytes,force = false) {
        if (job.done) return;
        job.bytes = bytes;
        const now = this._now();
        if (!force && now - job.lastProgress < 100) return;
        job.lastProgress = now;
        try { job.onProgress?.({bytes,total:job.size}); }
        catch { this._finish(job,this._error('HashReadError'),null,this._active === job); }
    }
    _pump() {
        if (this._active || !this._queue.length) return;
        const job = this._active = this._queue.shift();
        if (job.signal?.aborted) { this._finish(job,this._error('AbortError')); return; }
        this._progress(job,0,true); if (job.done) return;
        if (typeof this._Worker !== 'function') { void this._main(job); return; }
        let worker;
        try {
            if (!this._worker) {
                if (!this._url) throw this._error('HashWorkerError');
                worker = new this._Worker(this._url); this._worker = worker;
                worker.onmessage = event => this._message(worker,event.data);
                const failed = event => {
                    event?.preventDefault?.();
                    if (this._worker !== worker) return;
                    if (this._active) this._finish(this._active,this._error('HashWorkerError'),null,true);
                    else this._dropWorker();
                    return true;
                };
                worker.onerror = failed; worker.onmessageerror = failed;
            }
            // Strip File.name/lastModified before structured clone. slice is a
            // bounded Blob view; it does not read or allocate the full body.
            const blob = Blob.prototype.slice.call(job.blob,0,job.size);
            this._worker.postMessage({type:'hash',request:job.id,blob});
        } catch { this._finish(job,this._error('HashWorkerError'),null,true); }
    }
    _keys(data,keys) {
        return data && typeof data === 'object' && !Array.isArray(data)
            && Object.keys(data).length === keys.length && Object.keys(data).every(key => keys.includes(key));
    }
    _message(worker,data) {
        if (this._worker !== worker) return;
        const job = this._active; if (!job) return;
        const invalid = () => this._finish(job,this._error('HashProtocolError'),null,true);
        if (!Number.isSafeInteger(data?.request) || data.request < 1) { invalid(); return; }
        if (data.request < job.id) return; // Late completion from the same live worker.
        if (data.request !== job.id) { invalid(); return; }
        if (data.type === 'progress') {
            if (!this._keys(data,['type','request','bytes','total']) || data.total !== job.size
                || !Number.isSafeInteger(data.bytes) || data.bytes < job.bytes || data.bytes > job.size) { invalid(); return; }
            this._progress(job,data.bytes); return;
        }
        if (data.type === 'complete') {
            if (!this._keys(data,['type','request','bytes','sha256']) || data.bytes !== job.size
                || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) { invalid(); return; }
            this._progress(job,job.size,true); if (job.done) return;
            this._finish(job,null,{sha256:data.sha256,bytes:job.size,backend:'worker'}); return;
        }
        if (data.type === 'error' && this._keys(data,['type','request','errorName'])
            && ZeydropFileHasher.ERROR_NAMES.includes(data.errorName)) {
            this._finish(job,this._error(data.errorName)); return;
        }
        invalid();
    }
    _read(blob,start,end) { return Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(blob,start,end)); }
    async _main(job) {
        try {
            const hash = this._factory(); if (!hash?.update || !hash?.digest) throw this._error('HashUnsupportedError');
            for (let offset = 0; offset < job.size; offset += ZeydropFileHasher.CHUNK_BYTES) {
                if (job.done || this._active !== job) return;
                const end = Math.min(job.size,offset + ZeydropFileHasher.CHUNK_BYTES),bytes = await this._read(job.blob,offset,end);
                if (job.done || this._active !== job) return;
                const chunk = new Uint8Array(bytes);
                if (chunk.byteLength !== end-offset) throw this._error('HashReadError');
                hash.update(chunk); this._progress(job,end);
            }
            if (job.done || this._active !== job) return;
            const sha256 = Array.from(hash.digest(),n=>n.toString(16).padStart(2,'0')).join('');
            if (!/^[a-f0-9]{64}$/.test(sha256)) throw this._error('HashReadError');
            this._progress(job,job.size,true); if (job.done) return;
            this._finish(job,null,{sha256,bytes:job.size,backend:'main'});
        } catch (error) {
            const name = ZeydropFileHasher.ERROR_NAMES.includes(error?.name) || error?.name === 'HashUnsupportedError' ? error.name : 'HashReadError';
            this._finish(job,this._error(name));
        }
    }
}
window.ZeydropFileHash = new ZeydropFileHasher();
