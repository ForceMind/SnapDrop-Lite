'use strict';
// Fresh-session protocol fixtures: sender reselects the original File, receiver
// manually opts into a stored prefix after a new authenticated invitation.
// No NAT or physical browser claim is made by these VM tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomBytes, webcrypto, createHash } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const unref = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; };
const digest = data => createHash('sha256').update(data).digest('hex');
async function rig({ corrupt = false, wrongMetadata = false } = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const events = [], content = randomBytes(2 * 1024 * 1024 + 19);
    const originalMeta = { name: 'durable.bin', size: content.length, mime: 'application/octet-stream' };
    const storage = { content: Buffer.alloc(0), committed: Buffer.alloc(0), checksum: digest(Buffer.alloc(0)), id: null };
    let firstConnection = true, sentAfterReload = 0, wireOpen = true;
    const durable = {
        supported: true,
        async open(meta) {
            storage.id = meta.id; storage.content = Buffer.alloc(0); storage.committed = Buffer.alloc(0);
            return makeSink(0, meta);
        },
        async restore(id, meta) {
            if (id !== storage.id || meta.name !== originalMeta.name
                || meta.size !== originalMeta.size || meta.mime !== originalMeta.mime) throw Error('断点不匹配');
            const snapshot = new Blob([corrupt ? Buffer.from(storage.committed.map((v, i) => i === 0 ? v ^ 1 : v)) : storage.committed]);
            return { sink: makeSink(storage.committed.length, meta), snapshot,
                offset: storage.committed.length, prefixSha256: storage.checksum };
        }
    };
    function makeSink(offset, meta) {
        return {
            size: offset, async write(bytes) {
                const chunk = Buffer.from(new Uint8Array(bytes));
                storage.content = Buffer.concat([storage.content, chunk]); this.size += bytes.byteLength;
            }, async checkpoint(hash) {
                storage.committed = Buffer.from(storage.content);
                storage.checksum = hash;
                if (firstConnection && storage.committed.length >= 256 * 1024) wireOpen = false;
            }, async finish(hash) {
                assert.equal(this.size, meta.size);
                assert.equal(digest(storage.content), hash);
                return { saved: true };
            }, async abort() {}, async park() {}
        };
    }
    const window = { ZeydropHash: sha256, ZeydropRecovery: durable, ZEYDROP_CONFIG: {} };
    const context = { crypto: webcrypto, window, Events: { fire: (type, detail) => events.push({ type, detail }) },
        performance, Uint8Array, TextEncoder, Blob, File, setTimeout: unref, clearTimeout };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Transfer = TransferPeer;', context);
    function peer(id) {
        const p = new context.Transfer({}, id);
        p._verified = true; p._remoteHello = true; p._path = { direct: true };
        p._isConnected = () => true; p._waitForDrain = async () => {};
        p._connectionEvent = () => {}; p.close = () => {};
        return p;
    }
    function wire(a, b) {
        a._send = data => {
            if (!wireOpen) return;
            if (!firstConnection && typeof data !== 'string') sentAfterReload += data.byteLength;
            queueMicrotask(() => { if (wireOpen) b._receive(data); });
        };
        b._send = data => {
            if (!wireOpen) return;
            queueMicrotask(() => { if (wireOpen) a._receive(data); });
        };
    }
    const until = async fn => {
        for (let i = 0; i < 6000; i++) { if (fn()) return; await delay(2); }
        throw Error('cross-page fixture timeout: ' + JSON.stringify(events.slice(-3)));
    };
    const a = peer('original-receiver'), b = peer('original-sender'); wire(a, b);
    a.sendFiles([new File([content], originalMeta.name, { type: originalMeta.mime })]);
    await until(() => Boolean(b._incoming));
    await b.acceptIncoming(b._incoming.meta.id, { durable: true });
    await until(() => !wireOpen);
    const originalId = storage.id, savedOffset = storage.committed.length;
    assert.ok(savedOffset > 0 && savedOffset < content.length);
    // Simulate destroying both old pages: no transfer state or File retained.
    firstConnection = false; wireOpen = true;
    const a2 = peer('new-receiver'), b2 = peer('new-sender'); wire(a2, b2);
    const candidate = new File([content], wrongMetadata ? 'different.bin' : originalMeta.name,
        { type: originalMeta.mime });
    a2.sendFiles([candidate]);
    await until(() => Boolean(b2._incoming));
    await b2.acceptIncoming(b2._incoming.meta.id, { resumeLocalId: originalId });
    return { a2, b2, content, events, storage, sent: () => sentAfterReload, savedOffset, until };
}
test('manual new-session resume hashes persisted prefix and transmits only remaining bytes', async () => {
    const h = await rig();
    await h.until(() => h.events.some(e => e.type === 'file-received' && e.detail.saved));
    assert.equal(digest(h.storage.content), digest(h.content));
    assert.equal(h.sent(), h.content.length - h.savedOffset);
    assert.ok(h.sent() < h.content.length);
});
test('corrupted persisted prefix cannot trigger completion or new binary bytes', async () => {
    const h = await rig({ corrupt: true });
    await h.until(() => h.b2._incoming === null);
    assert.equal(h.sent(), 0);
    assert.ok(!h.events.some(e => e.type === 'file-received'));
});
test('same-size but different source name does not silently reuse a checkpoint', async () => {
    const h = await rig({ wrongMetadata: true });
    await h.until(() => h.b2._incoming === null);
    assert.equal(h.sent(), 0);
    assert.ok(!h.events.some(e => e.type === 'file-received'));
});
