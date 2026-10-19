'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function harness(options = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js'); const events = [];
    let persisted = 0, closed = 0, aborted = 0; const receivedHash = sha256.create();
    const context = { console, crypto: crypto.webcrypto, performance, Blob, File, Uint8Array, TextEncoder, setTimeout, clearTimeout, window: { ZeydropHash: sha256, ZEYDROP_CONFIG: { memoryLimit: 64 * 1024 * 1024 } }, Events: { fire: (type, detail) => events.push({ type, detail }) } };
    if (options.disk) context.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async bytes => { assert.ok(bytes.byteLength <= 16384); persisted += bytes.byteLength; receivedHash.update(new Uint8Array(bytes)); }, close: async () => { closed++; }, abort: async () => { aborted++; } }) });
    vm.createContext(context); vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.T = TransferPeer; this.S = ReceiveSink;', context);
    const a = new context.T({}, 'b'), b = new context.T({}, 'a');
    for (const peer of [a, b]) { peer._verified = true; peer._remoteHello = true; peer._path = { direct: true }; peer._isConnected = () => true; peer._waitForDrain = async () => {}; peer._connectionEvent = () => {}; peer.close = () => {}; }
    a.close = b.close = () => { a.abortAll('closed'); b.abortAll('closed'); };
    let sent = 0;
    a._send = data => {
        if (typeof data !== 'string') { sent += data.byteLength; if (options.corrupt && sent === data.byteLength) { data = data.slice(0); new Uint8Array(data)[0] ^= 1; } }
        queueMicrotask(() => b._receive(data));
    };
    b._send = data => queueMicrotask(() => a._receive(data));
    const until = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(2); } throw Error('transfer timeout'); };
    return { a, b, events, until, sent: () => sent, persisted: () => persisted, closed: () => closed, aborted: () => aborted, receivedHash, context };
}
test('no file bytes before acceptance; verified SHA-256 and bounded disk writes, including empty files', async () => {
    for (const size of [0, 3, 2 * 1024 * 1024 + 19]) {
        const h = await harness({ disk: true }); const bytes = crypto.randomBytes(size); const file = new File([bytes], 'test.bin');
        h.a.sendFiles([file]); await h.until(() => h.b._incoming); assert.equal(h.sent(), 0);
        await h.b.acceptIncoming(h.b._incoming.meta.id);
        await h.until(() => h.events.some(event => event.type === 'file-received'));
        const result = h.events.find(event => event.type === 'file-received').detail;
        assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex')); assert.equal(result.saved, true);
        assert.equal(h.persisted(), size); assert.equal(h.closed(), 1);
        await h.until(() => !h.a._outgoing);
    }
});
test('corruption aborts partial disk file and never exposes a completed file', async () => {
    const h = await harness({ disk: true, corrupt: true }); h.a.sendFiles([new File([Buffer.alloc(90000, 3)], 'bad.bin')]);
    await h.until(() => h.b._incoming); await h.b.acceptIncoming(h.b._incoming.meta.id);
    await h.until(() => h.aborted()); assert.equal(h.closed(), 0); assert.ok(!h.events.some(event => event.type === 'file-received'));
});
test('memory fallback rejects oversized files before acceptance; malicious oversized chunks abort', async () => {
    const h = await harness();
    await assert.rejects(h.context.S.open({ name: 'large', size: 64 * 1024 * 1024 + 1 }), /64 MiB/);
    h.a.sendFiles([new File([Buffer.alloc(100)], '../file')]); await h.until(() => h.b._incoming);
    await h.b.acceptIncoming(h.b._incoming.meta.id);
    await h.until(() => h.events.some(event => event.type === 'file-received'));
    const result = h.events.find(event => event.type === 'file-received').detail;
    assert.equal(result.name, '.._file'); assert.equal((await result.blob.arrayBuffer()).byteLength, 100); result.release();
    const fresh = await harness(); await fresh.b._onMessage('not-json').then(() => assert.fail(), error => assert.match(error.message, /无效/));
    await assert.rejects(fresh.b._onMessage(new Uint8Array(16385).buffer), /未授权/);
});
test('unverified peers cannot send or receive file offers', async () => {
    const h = await harness(); h.a._verified = false;
    h.a.sendFiles([new File(['secret'], 's')]); assert.equal(h.a._outgoing, null); assert.equal(h.sent(), 0);
    h.b._verified = false; await h.b._onMessage(JSON.stringify({ type: 'offer', id: crypto.randomUUID(), name: 'x', size: 1, mime: '' })); assert.equal(h.b._incoming, null);
});
test('fallback multi-file queue waits until user saves/discards the previous Blob', async () => {
    const h = await harness(); h.a.sendFiles([new File(['one'], 'one'), new File(['two'], 'two')]);
    await h.until(() => h.b._incoming); const id = h.b._incoming.meta.id; await h.b.acceptIncoming(id);
    await h.until(() => !h.a._outgoing && h.a._queueWaitId === id);
    assert.equal(h.b._incoming, null); assert.equal(h.a._filesQueue.length, 1);
    h.events.find(event => event.type === 'file-received').detail.release();
    h.b.sendJSON({ type: 'ready-next', id });
    await h.until(() => h.b._incoming); assert.equal(h.b._incoming.meta.name, 'two');
    h.b.rejectIncoming(h.b._incoming.meta.id); await h.until(() => !h.a._outgoing);
});
test('pause holds file reads, resume continues, and cancel aborts native partial writes', async () => {
    const h = await harness({ disk: true }); const bytes = Buffer.alloc(2 * 1024 * 1024);
    h.a.sendFiles([new File([bytes], 'pause.bin')]); await h.until(() => h.b._incoming);
    const id = h.b._incoming.meta.id; h.a.pause(id, true); await h.b.acceptIncoming(id);
    await delay(130); assert.equal(h.sent(), 0);
    h.a.pause(id, false); await h.until(() => h.events.some(event => event.type === 'file-received'));
    await h.until(() => !h.a._outgoing);
    h.a.sendFiles([new File([bytes], 'cancel.bin')]); await h.until(() => h.b._incoming);
    const cancelled = h.b._incoming.meta.id; h.a.pause(cancelled, true); await h.b.acceptIncoming(cancelled);
    h.a.cancel(cancelled); await h.until(() => h.aborted());
    assert.equal(h.events.filter(event => event.type === 'file-received').length, 1); assert.equal(h.a._filesQueue.length, 0);
});
test('write failure cannot produce complete, and an incorrect ACK cannot advance a sender', async () => {
    const h = await harness({ disk: true }); h.a.sendFiles([new File([Buffer.alloc(60000)], 'failure')]);
    await h.until(() => h.b._incoming); h.a.pause(h.b._incoming.meta.id, true); await h.b.acceptIncoming(h.b._incoming.meta.id);
    h.b._incoming.sink.writer.write = async () => { throw Error('disk full'); };
    h.a.pause(h.b._incoming.meta.id, false); await h.until(() => h.aborted()); assert.equal(h.closed(), 0);
    assert.ok(!h.events.some(event => event.type === 'file-received'));
    const other = await harness(); other.a.sendFiles([new File(['x'], 'ack')]); await other.until(() => other.b._incoming);
    other.a._outgoing.waiter = {resolve: () => assert.fail('bad ACK resolved')}; other.a._outgoing.expectedAck = 1; other.a._outgoing.offset = 1;
    await assert.rejects(other.a._onMessage(JSON.stringify({type:'ack',id:other.a._outgoing.meta.id,offset:2})), /偏移/);
    other.a._outgoing.waiter = null; other.a.abortAll('test cleanup'); other.b.abortAll('test cleanup');
});
