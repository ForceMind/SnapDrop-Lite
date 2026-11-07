'use strict';
// Opt-in, origin-local metadata only. File objects/handles/body bytes, peer IDs,
// invitations and consent to send are never persisted. Reselecting a saved
// queue is not authorization: the caller must establish/verify a new pairing
// and obtain receiver consent before passing returned File references to send.
class ZeydropSendQueueStore {
    static KEY = 'zeydrop-send-queue-v1';
    static TTL_MS = 24 * 60 * 60 * 1000;
    static MAX_FILES = 100;
    static MAX_BYTES = 128 * 1024;
    static HASH_CHUNK = 256 * 1024;
    constructor(options = {}) {
        this._storage = options.storage === undefined ? () => window.localStorage : () => options.storage;
        this._locks = options.locks || globalThis.navigator?.locks;
        this._now = options.now || Date.now;
        this._hash = options.hashFactory || (window.ZeydropHash?.create ? () => window.ZeydropHash.create() : null);
        this._uuid = options.randomUUID || (globalThis.crypto?.randomUUID ? () => crypto.randomUUID() : null);
        this.supported = !!this._locks?.request && !!this._hash && !!this._uuid && typeof TextEncoder === 'function';
    }
    get storageKey() { return ZeydropSendQueueStore.KEY; }
    _error(name, message) { const error = Error(message); error.name = name; return error; }
    _requireConsent(yes) {
        if (yes !== true) throw this._error('QueueConsentError', '请明确同意在此浏览器保存或恢复待发清单');
    }
    _abort(signal) { if (signal?.aborted) throw this._error('AbortError', '本机待发清单操作已取消'); }
    _validId(value) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
    _revision(value) {
        if (value !== null && !this._validId(value)) throw this._error('QueueConflictError', '请先重新读取本机待发清单');
    }
    _onlyKeys(value, keys) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).every(key => keys.includes(key));
    }
    _encode(value) {
        const text = JSON.stringify(value);
        if (text.length > ZeydropSendQueueStore.MAX_BYTES || new TextEncoder().encode(text).byteLength > ZeydropSendQueueStore.MAX_BYTES)
            throw this._error('QueueLimitError', '本机待发清单元数据不能超过 128 KiB');
        return text;
    }
    _parse(text) {
        try {
            if (typeof text !== 'string' || text.length > ZeydropSendQueueStore.MAX_BYTES
                || new TextEncoder().encode(text).byteLength > ZeydropSendQueueStore.MAX_BYTES) throw Error();
            const data = JSON.parse(text);
            if (!this._onlyKeys(data, ['version','revision','createdAt','expiresAt','files']) || data.version !== 1
                || !this._validId(data.revision) || !Number.isSafeInteger(data.createdAt) || data.createdAt < 0
                || data.createdAt > this._now() + 60000 || data.expiresAt !== data.createdAt + ZeydropSendQueueStore.TTL_MS
                || !Number.isSafeInteger(data.expiresAt) || !Array.isArray(data.files)
                || !data.files.length || data.files.length > ZeydropSendQueueStore.MAX_FILES) throw Error();
            const ids = new Set(); let total = 0;
            for (const file of data.files) {
                if (!this._onlyKeys(file, ['entryId','name','size','mime','lastModified','sha256'])
                    || !this._validId(file.entryId) || ids.has(file.entryId)
                    || typeof file.name !== 'string' || !file.name.length || file.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(file.name)
                    || !Number.isSafeInteger(file.size) || file.size < 0
                    || typeof file.mime !== 'string' || file.mime.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime)
                    || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0
                    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error();
                ids.add(file.entryId); total += file.size; if (!Number.isSafeInteger(total)) throw Error();
            }
            return data;
        } catch { throw this._error('QueueCorruptError', '本机待发清单格式损坏或不可用，请检查后手动删除'); }
    }
    _current(storage) {
        const text = storage.getItem(ZeydropSendQueueStore.KEY);
        if (text === null) return null;
        const snapshot = this._parse(text);
        if (this._now() >= snapshot.expiresAt) {
            storage.removeItem(ZeydropSendQueueStore.KEY);
            throw this._error('QueueExpiredError', '本机待发清单已超过 24 小时并清除，请重新选择文件');
        }
        return snapshot;
    }
    _check(snapshot, expectedRevision) {
        if ((snapshot?.revision || null) !== expectedRevision)
            throw this._error('QueueConflictError', '待发清单已在另一页面更改，请重新读取后操作');
    }
    _id(used = new Set()) {
        for (let i = 0; i < 4; i++) { const id = this._uuid(); if (this._validId(id) && !used.has(id)) return id; }
        throw this._error('QueueStorageError', '无法生成安全的本机清单标识');
    }
    async _locked(fn, signal) {
        if (!this.supported) throw this._error('QueueUnsupportedError', '此浏览器不支持安全的本机待发清单，请继续使用当前页面发送');
        this._abort(signal);
        return this._locks.request(ZeydropSendQueueStore.KEY, { mode:'exclusive', ...(signal ? {signal} : {}) }, () => {
            this._abort(signal); return fn(this._storage());
        });
    }
    _selection(files) {
        if (!files || !Number.isInteger(files.length) || files.length < 1 || files.length > ZeydropSendQueueStore.MAX_FILES)
            throw this._error('QueueLimitError', '待发清单必须包含 1 到 100 个文件');
        const selected = [], seen = new Set(); let total = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file || seen.has(file) || typeof file.name !== 'string' || !file.name.length || file.name.length > 255
                || /[\\/\x00-\x1f\x7f]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0
                || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0 || typeof file.slice !== 'function'
                || typeof file.type !== 'string' || file.type.length > 128)
                throw this._error('QueueFileMismatchError', '请重新选择有效且不重复的原文件，文件名不支持路径或控制字符');
            total += file.size;
            if (!Number.isSafeInteger(total)) throw this._error('QueueLimitError', '待发文件总大小超出安全数值范围');
            seen.add(file); selected.push(file);
        }
        return { selected, total };
    }
    async _fingerprints(files, phase, {signal,onProgress} = {}) {
        const {selected,total} = this._selection(files), descriptors = []; let hashed = 0, lastProgress = -Infinity;
        const report = (index, force = false) => {
            if (typeof onProgress !== 'function') return;
            const now = this._now();
            if (!force && now - lastProgress < 100) return;
            lastProgress = now; onProgress({phase,fileIndex:index,fileCount:selected.length,hashedBytes:hashed,totalBytes:total});
        };
        for (let i = 0; i < selected.length; i++) {
            this._abort(signal); const file = selected[i], hash = this._hash(); report(i,true);
            for (let offset = 0; offset < file.size; offset += ZeydropSendQueueStore.HASH_CHUNK) {
                this._abort(signal); const end = Math.min(file.size,offset + ZeydropSendQueueStore.HASH_CHUNK);
                const bytes = await file.slice(offset,end).arrayBuffer(); this._abort(signal);
                const chunk = bytes && new Uint8Array(bytes);
                if (!chunk || chunk.byteLength !== end-offset) throw this._error('QueueFileMismatchError', '原文件读取长度已变化，请重新选择');
                hash.update(chunk); hashed += chunk.byteLength; report(i);
            }
            descriptors.push({name:file.name,size:file.size,mime:/^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream',
                lastModified:file.lastModified,sha256:Array.from(hash.digest(),n=>n.toString(16).padStart(2,'0')).join('')});
            report(i,true);
        }
        this._abort(signal); return {selected,descriptors};
    }
    load() { return this._locked(storage => this._current(storage)); }
    async save(files, options = {}) {
        this._requireConsent(options.optIn); this._revision(options.expectedRevision);
        // Check before expensive reads, then repeat under the commit lock. Hashes
        // and File references never enter localStorage until the user opted in.
        await this._locked(storage => this._check(this._current(storage),options.expectedRevision),options.signal);
        const {descriptors} = await this._fingerprints(files,'saving',options);
        return this._locked(storage => {
            const current = this._current(storage); this._check(current,options.expectedRevision);
            const createdAt = current?.createdAt ?? this._now(), used = new Set(current ? [current.revision] : []);
            const revision = this._id(used); used.add(revision);
            const entries = descriptors.map(file => {const entryId=this._id(used);used.add(entryId);return{entryId,...file};});
            const snapshot = {version:1,revision,createdAt,expiresAt:createdAt+ZeydropSendQueueStore.TTL_MS,files:entries};
            storage.setItem(ZeydropSendQueueStore.KEY,this._encode(snapshot)); return snapshot;
        },options.signal);
    }
    async reselect(revision, files, options = {}) {
        this._requireConsent(options.confirmed); this._revision(revision);
        const snapshot = await this._locked(storage => {const value=this._current(storage);this._check(value,revision);return value;},options.signal);
        if (!snapshot) throw this._error('QueueFileMismatchError', '本机没有待恢复清单');
        if (files?.length !== snapshot.files.length) throw this._error('QueueFileMismatchError', '请重新选择清单中的全部原文件');
        const {selected,descriptors} = await this._fingerprints(files,'matching',options), used = new Set(), ordered = [];
        for (const expected of snapshot.files) {
            const index = descriptors.findIndex((file,i) => !used.has(i) && file.name === expected.name && file.size === expected.size
                && file.mime === expected.mime && file.sha256 === expected.sha256);
            if (index < 0) throw this._error('QueueFileMismatchError', '重新选择的文件与原清单内容不一致，未恢复任何文件');
            used.add(index); ordered.push(selected[index]);
        }
        await this._locked(storage => this._check(this._current(storage),revision),options.signal);
        return {files:ordered,snapshot};
    }
    async removeEntry(entryId, {expectedRevision} = {}) {
        this._revision(expectedRevision);
        if (!this._validId(entryId)) throw this._error('QueueConflictError', '本机待发条目标识无效');
        return this._locked(storage => {
            const current=this._current(storage);this._check(current,expectedRevision);
            if (!current || !current.files.some(file=>file.entryId===entryId)) throw this._error('QueueConflictError','本机待发条目已更改，请重新读取');
            const files=current.files.filter(file=>file.entryId!==entryId);
            if (!files.length) {storage.removeItem(ZeydropSendQueueStore.KEY);return null;}
            const snapshot={...current,revision:this._id(new Set([current.revision,...files.map(file=>file.entryId)])),files};
            storage.setItem(ZeydropSendQueueStore.KEY,this._encode(snapshot));return snapshot;
        });
    }
    async clear({expectedRevision} = {}) {
        this._revision(expectedRevision);
        return this._locked(storage => {this._check(this._current(storage),expectedRevision);storage.removeItem(ZeydropSendQueueStore.KEY);return true;});
    }
    async clearCorrupt({confirmed} = {}) {
        this._requireConsent(confirmed);
        return this._locked(storage => {
            const text=storage.getItem(ZeydropSendQueueStore.KEY);if(text===null)return true;
            try {this._parse(text);} catch(error) {if(error.name!=='QueueCorruptError')throw error;storage.removeItem(ZeydropSendQueueStore.KEY);return true;}
            throw this._error('QueueConflictError','当前清单可正常读取，请重新检查后删除');
        });
    }
}
window.ZeydropSendQueue = new ZeydropSendQueueStore();
