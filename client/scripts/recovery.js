'use strict';
// Only activated after explicit receiver opt-in. Holds no access tokens or
// file contents in URLs, cookies, localStorage, signaling or remote services.
class ZeydropRecoveryStore {
    constructor() {
        this.supported = typeof Worker !== 'undefined' && !!navigator.storage?.getDirectory;
        this.worker = null; this.sequence = 0; this.pending = new Map();
    }
    async request(type, ...args) {
        if (!this.supported) throw Error('此浏览器不支持本机断点保存');
        if (!this.worker) {
            this.worker = new Worker('/scripts/recovery-worker.js');
            this.worker.onmessage = event => {
                const data = event.data, job = this.pending.get(data?.request);
                if (!job) return;
                this.pending.delete(data.request);
                if (data.ok) job.resolve(data.value);
                else job.reject(Error(data.error || '本机文件操作失败'));
            };
            this.worker.onerror = () => {
                for (const job of this.pending.values()) job.reject(Error('本机存储进程已中断'));
                this.pending.clear(); this.worker?.terminate(); this.worker = null;
            };
        }
        const request = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.pending.set(request, { resolve, reject });
            try { this.worker.postMessage({ request, type, args }); }
            catch (e) { this.pending.delete(request); reject(e); }
        });
    }
    list() { return this.request('list'); }
    erase(id) { return this.request('erase', id); }
    async open(meta) {
        await this.request('start', meta);
        return new ZeydropDurableSink(this, meta.id, meta, 0);
    }
    async restore(id, meta) {
        const result = await this.request('resume', id, meta);
        return { sink: new ZeydropDurableSink(this, id, meta, result.meta.offset),
            snapshot: result.snapshot, prefixSha256: result.meta.prefixSha256, offset: result.meta.offset };
    }
}
class ZeydropDurableSink {
    constructor(store, id, meta, offset) {
        this.store = store; this.id = id; this.meta = meta; this.size = offset;
        this.lastCommitted = offset; this.saved = false;
    }
    async write(bytes) {
        if (this.size + bytes.byteLength > this.meta.size) throw Error('文件超出声明大小');
        // Dedicated OPFS worker owns the exclusive access handle.
        await this.store.request('append', this.id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        this.size += bytes.byteLength;
    }
    async checkpoint(sha256, force = false) {
        this.lastCommitted = await this.store.request('checkpoint', this.id, sha256, force);
        return this.lastCommitted;
    }
    async finish(sha256) {
        if (this.size !== this.meta.size) throw Error('文件长度不一致');
        const result = await this.store.request('finish', this.id, sha256);
        this.saved = true;
        return { blob: result.file, release: () => this.release(), locallyStored: true };
    }
    release() { this.store.erase(this.id).catch(() => {}); }
    async abort() { await this.store.erase(this.id); }
}
window.ZeydropRecovery = new ZeydropRecoveryStore();
