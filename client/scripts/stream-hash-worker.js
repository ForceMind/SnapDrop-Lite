import { sha256 } from '@noble/hashes/sha2.js';
// One dedicated hash state per Worker. No names, pairing metadata, filesystem,
// network calls, or serialization of Noble's internal state.
const CHUNK_BYTES = 256 * 1024;
let hash = null, session = null, request = 0, bytes = 0, closed = false;
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const reply = data => { try { self.postMessage(data); } catch {} };
function reject(data, errorName = 'HashProtocolError') {
    closed = true; try { hash?.destroy?.(); } catch {} hash = null;
    reply({ type: 'error', session: Number.isSafeInteger(data?.session) ? data.session : 0,
        request: Number.isSafeInteger(data?.request) ? data.request : 0, errorName });
}
self.onmessage = event => {
    const data = event.data;
    try {
        if (closed) { reject(data); return; }
        if (!hash) {
            if (!keys(data, ['type', 'session', 'request']) || data.type !== 'init'
                || !Number.isSafeInteger(data.session) || data.session < 1 || data.request !== 0) { reject(data); return; }
            session = data.session; hash = sha256.create();
            reply({ type: 'ready', session, request: 0, bytes: 0 }); return;
        }
        if (data?.session !== session || !Number.isSafeInteger(data.request) || data.request !== request + 1
            || !Number.isSafeInteger(data.offset) || data.offset !== bytes) { reject(data); return; }
        if (data.type === 'update' && keys(data, ['type', 'session', 'request', 'offset', 'chunk'])) {
            let size;
            try { size = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(data.chunk); }
            catch { reject(data); return; }
            if (!Number.isSafeInteger(size) || size > CHUNK_BYTES || !Number.isSafeInteger(bytes + size)) { reject(data); return; }
            hash.update(new Uint8Array(data.chunk)); bytes += size; request = data.request;
            reply({ type: 'updated', session, request, bytes }); return;
        }
        if (data.type === 'digest' && keys(data, ['type', 'session', 'request', 'offset', 'final']) && typeof data.final === 'boolean') {
            const sha256 = Array.from((data.final ? hash : hash.clone()).digest(), byte => byte.toString(16).padStart(2, '0')).join('');
            request = data.request;
            if (data.final) { hash = null; closed = true; }
            reply({ type: 'digest', session, request, bytes, sha256, final: data.final }); return;
        }
        reject(data);
    } catch { reject(data, 'HashReadError'); }
};
