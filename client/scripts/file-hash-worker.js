import { sha256 } from '@noble/hashes/sha2.js';
// Bundled as a separate local IIFE. No network, OPFS, names, or persistent state.
const CHUNK_BYTES = 256 * 1024;
const ERROR_NAMES = ['AbortError','NotReadableError','NotFoundError','SecurityError','NotAllowedError',
    'InvalidStateError','DataError','QuotaExceededError','UnknownError'];
let active = false;
const reply = value => { try { self.postMessage(value); } catch {} };
const keys = (value,allowed) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.length && Object.keys(value).every(key=>allowed.includes(key));
async function hashFile(data) {
    const request = Number.isSafeInteger(data?.request) && data.request > 0 ? data.request : 0;
    if (active || !keys(data,['type','request','blob']) || data.type !== 'hash' || !request) {
        reply({type:'error',request,errorName:'HashReadError'}); return;
    }
    active = true;
    try {
        const blob = data.blob,size = Object.getOwnPropertyDescriptor(Blob.prototype,'size').get.call(blob);
        if (!Number.isSafeInteger(size) || size < 0) throw Error();
        const hash = sha256.create(); let lastProgress = -Infinity;
        for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
            const end = Math.min(size,offset + CHUNK_BYTES);
            const buffer = await Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(blob,offset,end));
            const bytes = new Uint8Array(buffer); if (bytes.byteLength !== end-offset) throw Error();
            hash.update(bytes);
            const now = Date.now();
            if (now-lastProgress >= 100) { reply({type:'progress',request,bytes:end,total:size}); lastProgress=now; }
        }
        reply({type:'complete',request,bytes:size,sha256:Array.from(hash.digest(),n=>n.toString(16).padStart(2,'0')).join('')});
    } catch (error) {
        reply({type:'error',request,errorName:ERROR_NAMES.includes(error?.name) ? error.name : 'HashReadError'});
    } finally { active = false; }
}
self.onmessage = event => { void hashFile(event.data); };
