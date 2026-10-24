'use strict';
// All file bytes remain in origin-private browser storage. The app server only
// exchanges WebRTC signaling; no recovery data is sent over WebSocket.
const DIR = 'zeydrop-recovery-v1';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 20;
const CHUNK = 16 * 1024;
const COMMIT_STEP = 1024 * 1024;
const active = new Map();
let directory;
const validId = id => typeof id === 'string' && /^[a-f0-9-]{32,36}$/.test(id);
const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const partName = id => id + '.part';
const metaName = id => id + '.json';
async function folder() {
    if (!directory) {
        const root = await navigator.storage.getDirectory();
        directory = await root.getDirectoryHandle(DIR, { create: true });
    }
    return directory;
}
async function existing(name) {
    try { return await (await folder()).getFileHandle(name); }
    catch (e) { if (e?.name === 'NotFoundError') return null; throw e; }
}
async function readMeta(id) {
    if (!validId(id)) throw Error('无效本机断点标识');
    const handle = await existing(metaName(id));
    if (!handle) return null;
    const file = await handle.getFile();
    if (file.size > 4096) throw Error('本机断点元数据损坏');
    const data = JSON.parse(await file.text());
    if (data.id !== id || data.version !== 1 || !Number.isSafeInteger(data.size) || data.size < 0
        || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.offset > data.size
        || typeof data.name !== 'string' || data.name.length > 255
        || typeof data.mime !== 'string' || data.mime.length > 128
        || !validHash(data.prefixSha256) || !Number.isSafeInteger(data.createdAt)
        || !['partial', 'complete'].includes(data.phase)) throw Error('本机断点元数据损坏');
    return data;
}
async function writeMeta(meta) {
    const file = await (await folder()).getFileHandle(metaName(meta.id), { create: true });
    const writer = await file.createWritable({ mode: 'exclusive' });
    try { await writer.write(JSON.stringify(meta)); await writer.close(); }
    catch (e) { try { await writer.abort(); } catch {} throw e; }
}
async function erase(id) {
    if (!validId(id)) throw Error('无效本机断点标识');
    const item = active.get(id);
    if (item) { active.delete(id); item.access.close(); }
    const dir = await folder();
    for (const name of [partName(id), metaName(id)]) {
        try { await dir.removeEntry(name); }
        catch (e) { if (e?.name !== 'NotFoundError') throw e; }
    }
    return true;
}
async function listing() {
    const dir = await folder(), result = [];
    for await (const [name] of dir.entries()) {
        if (!/^[a-f0-9-]{32,36}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        let meta;
        try { meta = await readMeta(id); } catch { continue; }
        if (!meta) continue;
        if (Date.now() - meta.createdAt >= TTL_MS || meta.createdAt > Date.now() + 60000) {
            if (!active.has(id)) await erase(id); continue;
        }
        const part = await existing(partName(id));
        if (!part) { if (!active.has(id)) await erase(id); continue; }
        result.push(meta);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
}
async function start(meta) {
    if (!meta || !validId(meta.id) || !Number.isSafeInteger(meta.size) || meta.size < 0
        || typeof meta.name !== 'string' || meta.name.length < 1 || meta.name.length > 255
        || typeof meta.mime !== 'string' || meta.mime.length > 128) throw Error('无效的本机文件信息');
    if (active.has(meta.id) || await existing(metaName(meta.id))) throw Error('本机已有同名断点');
    if ((await listing()).length >= MAX_ITEMS) throw Error('本机最多保留 20 个断点，请清理后重试');
    const dir = await folder();
    const file = await dir.getFileHandle(partName(meta.id), { create: true });
    const access = await file.createSyncAccessHandle();
    const item = { file, access, offset: 0, committed: 0, meta: {
        version: 1, id: meta.id, name: meta.name, size: meta.size, mime: meta.mime,
        offset: 0, prefixSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        createdAt: Date.now(), phase: 'partial'
    } };
    try {
        access.truncate(0);
        await writeMeta(item.meta);
        active.set(meta.id, item);
    } catch (e) { access.close(); await erase(meta.id); throw e; }
    return { id: meta.id, offset: 0 };
}
async function resume(id, expected) {
    if (active.has(id)) throw Error('本机断点正在其他传输中使用');
    const meta = await readMeta(id);
    if (!meta || meta.phase !== 'partial' || !meta.offset
        || Date.now() - meta.createdAt >= TTL_MS
        || !expected || expected.name !== meta.name || expected.size !== meta.size || expected.mime !== meta.mime)
        throw Error('找不到匹配的本机未完成文件');
    const file = await existing(partName(id));
    if (!file) throw Error('本机断点数据已丢失');
    const access = await file.createSyncAccessHandle();
    try {
        if (access.getSize() < meta.offset) throw Error('本机文件长度不足，断点不可用');
        access.truncate(meta.offset);
        access.flush();
        const snapshot = await file.getFile();
        if (snapshot.size < meta.offset) throw Error('本机断点不可用');
        active.set(id, { file, access, offset: meta.offset, committed: meta.offset, meta });
        return { meta, snapshot };
    } catch (e) { access.close(); throw e; }
}
async function append(id, bytes) {
    const item = active.get(id);
    if (!item || !(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > CHUNK
        || item.offset + bytes.byteLength > item.meta.size) throw Error('无效的本机分块');
    const wrote = item.access.write(new Uint8Array(bytes), { at: item.offset });
    if (wrote !== bytes.byteLength) throw Error('本机数据未完整写入');
    item.offset += wrote;
    return item.offset;
}
async function checkpoint(id, sha256, force) {
    const item = active.get(id);
    if (!item || !validHash(sha256)) throw Error('无效的本机检查点');
    if (!force && item.offset - item.committed < COMMIT_STEP) return item.committed;
    item.access.flush(); // Data must be on disk before publishing its offset.
    const updated = { ...item.meta, offset: item.offset, prefixSha256: sha256 };
    await writeMeta(updated);
    item.meta = updated; item.committed = item.offset;
    return item.committed;
}
async function park(id, sha256) {
    const item = active.get(id);
    if (!item) return false;
    await checkpoint(id, sha256, true);
    item.access.close(); active.delete(id);
    return true;
}
async function completed(id) {
    const meta = await readMeta(id);
    if (!meta || meta.phase !== 'complete' || !validHash(meta.completeSha256))
        throw Error('本机没有已验证完成的文件');
    const file = await existing(partName(id));
    if (!file) throw Error('本机文件不存在');
    const blob = await file.getFile();
    if (blob.size !== meta.size) throw Error('本机文件大小已变化');
    return { meta, blob };
}
async function probe() {
    const dir = await folder(), handle = await dir.getFileHandle('capability-probe', { create: true });
    try {
        if (typeof handle.createSyncAccessHandle !== 'function') return false;
        const access = await handle.createSyncAccessHandle();
        access.close();
        return true;
    } finally { await dir.removeEntry('capability-probe').catch(() => {}); }
}
async function finish(id, sha256) {
    const item = active.get(id);
    if (!item || item.offset !== item.meta.size || !validHash(sha256)) throw Error('本机文件尚未完成校验');
    await checkpoint(id, sha256, true);
    item.access.close(); active.delete(id);
    const complete = { ...item.meta, phase: 'complete', completeSha256: sha256 };
    await writeMeta(complete);
    return { meta: complete, file: await item.file.getFile() };
}
async function list() { return listing(); }
const tasks = { probe, start, resume, append, checkpoint, park, finish, completed, erase, list };
self.onmessage = async event => {
    const { request, type, args = [] } = event.data || {};
    if (!Number.isSafeInteger(request) || !Object.hasOwn(tasks, type) || !Array.isArray(args)) return;
    try { self.postMessage({ request, ok: true, value: await tasks[type](...args) }); }
    catch (e) { self.postMessage({ request, ok: false, error: String(e?.message || e).slice(0, 200) }); }
};
