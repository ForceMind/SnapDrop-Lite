'use strict';
// Protocol-level retry tests run the actual transfer source. They do not claim
// browser picker, real-device storage or WAN connectivity coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

async function harness() {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const events = [], wires = [], timers = new Map(), errors = [];
    const context = vm.createContext({
        crypto: crypto.webcrypto, performance, Blob, File, Uint8Array, TextEncoder,
        setTimeout(fn, ms) {
            const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
            timer.unref(); timers.set(timer, { fn, ms }); return timer;
        },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
        window: { ZeydropHash: sha256, ZEYDROP_CONFIG: { memoryLimit: 64 * 1024 * 1024 } },
        Events: { fire(type, detail) { events.push({ type, detail }); } }
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer = TransferPeer;', context);
    const a = new context.Peer({}, 'b'), b = new context.Peer({}, 'a');
    for (const peer of [a, b]) {
        peer.connected = true; peer._verified = true; peer._path = { direct: true }; peer._remoteHello = true;
        peer._isConnected = () => peer.connected;
        peer._waitForDrain = async () => {};
        peer._connectionEvent = () => {};
        peer.close = reason => { errors.push(reason); peer.abortAll(reason); };
    }
    let sentBytes = 0;
    a._send = data => {
        if (typeof data === 'string') wires.push({ from: 'a', message: JSON.parse(data) });
        else sentBytes += data.byteLength;
        queueMicrotask(() => b._receive(data));
    };
    b._send = data => {
        if (typeof data === 'string') wires.push({ from: 'b', message: JSON.parse(data) });
        queueMicrotask(() => a._receive(data));
    };
    const settle = async () => {
        await new Promise(resolve => setImmediate(resolve));
        await Promise.all([a._messageChain, b._messageChain]);
    };
    const until = async predicate => {
        for (let i = 0; i < 500; i++) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        throw Error('retry queue fixture timed out');
    };
    const cleanup = () => {
        a.abortAll('fixture cleanup'); b.abortAll('fixture cleanup');
        for (const timer of timers.keys()) clearTimeout(timer);
        timers.clear();
    };
    return { a, b, events, wires, timers, errors, until, settle, cleanup, sentBytes: () => sentBytes };
}

test('receiver rejection retains the queue without auto-reoffering; retry has a fresh ID and fresh consent', async () => {
    const h = await harness();
    try {
        const original = new File(['original retry bytes'], '需要重发 & 空格.txt');
        h.a.sendFiles([original, new File(['next'], 'next.txt')]);
        await h.until(() => h.b._incoming);
        const rejectedId = h.b._incoming.meta.id;
        h.b.rejectIncoming(rejectedId);
        await h.until(() => !h.a._outgoing);
        await h.settle();
        assert.equal(h.sentBytes(), 0);
        assert.equal(h.a._filesQueue.length, 1);
        assert.equal(h.a._queueBlocked, true);
        assert.equal(h.a._retryFiles.get(rejectedId).file, original);
        assert.equal(h.b._incoming, null);
        assert.equal(h.wires.filter(item => item.from === 'a' && item.message.type === 'offer').length, 1);

        assert.equal(h.a.retryFile(rejectedId), true);
        await h.until(() => h.b._incoming);
        const freshId = h.b._incoming.meta.id;
        assert.notEqual(freshId, rejectedId);
        assert.equal(h.a._retryFiles.has(rejectedId), false);
        assert.equal(h.a._outgoing.phase, 'offered');
        await h.a._onMessage(JSON.stringify({ type: 'accept', id: rejectedId }));
        await h.settle();
        assert.equal(h.sentBytes(), 0, 'old acceptance cannot authorize the new retry');
        await h.b.acceptIncoming(freshId);
        await h.until(() => h.events.some(event => event.type === 'file-received'));
        const received = h.events.find(event => event.type === 'file-received').detail;
        assert.equal(await received.blob.text(), await original.text());
        await h.until(() => !h.a._outgoing && h.a._queueWaitId === freshId);

        h.a.continueQueue(); await h.settle();
        assert.equal(h.b._incoming, null, 'manual continue must not bypass a pending Blob save');
        await h.a._onMessage(JSON.stringify({ type: 'ready-next', id: rejectedId }));
        assert.equal(h.a._queueWaitId, freshId, 'stale ready-next must not release the barrier');
        received.release();
        h.b.sendJSON({ type: 'ready-next', id: freshId });
        await h.until(() => h.b._incoming);
        assert.equal(h.b._incoming.meta.name, 'next.txt');
        assert.equal(h.errors.length, 0);
    } finally { h.cleanup(); }
});

test('retry and continue cannot send before direct path, fresh identity, hello and live transport', async () => {
    const h = await harness();
    try {
        h.a.sendFiles([new File(['private'], 'private.txt'), new File(['queued'], 'queued.txt')]);
        await h.until(() => h.b._incoming);
        const id = h.b._incoming.meta.id;
        h.b.rejectIncoming(id); await h.until(() => !h.a._outgoing);
        for (const [field, denied, allowed] of [
            ['_verified', false, true], ['_path', { direct: false }, { direct: true }],
            ['_remoteHello', false, true], ['connected', false, true]
        ]) {
            h.a[field] = denied;
            h.a.retryFile(id); h.a.continueQueue(); await h.settle();
            assert.equal(h.a._outgoing, null, field + ' must gate retries and queues');
            assert.equal(h.a._retryFiles.has(id), true);
            assert.equal(h.a._queueBlocked, true);
            h.a[field] = allowed;
        }
        assert.equal(h.sentBytes(), 0);
        assert.equal(h.a.retryFile(id), true);
        await h.until(() => h.b._incoming);
        assert.equal(h.sentBytes(), 0, 'an authorized sender still needs new receiver consent');
    } finally { h.cleanup(); }
});

test('retry references expire, stay capped at 30 and are released by forgetting or terminal abort', async () => {
    const h = await harness();
    try {
        h.a._send = () => {}; // Local reference policy does not need remote offer delivery.
        const ids = [];
        for (let i = 0; i < 32; i++) {
            h.a.continueQueue();
            h.a.sendFiles([new File(['x'], 'failure-' + i)]);
            const id = h.a._outgoing.meta.id; ids.push(id);
            h.a.cancel(id, 'fixture cancelled');
        }
        assert.equal(h.a._retryFiles.size, 30);
        assert.equal(h.a._retryFiles.has(ids[0]), false);
        assert.equal(h.a._retryFiles.has(ids[1]), false);
        const entry = h.a._retryFiles.get(ids[2]);
        assert.equal(h.timers.get(entry.timer).ms, 15 * 60 * 1000);
        h.timers.get(entry.timer).fn();
        assert.equal(h.a._retryFiles.has(ids[2]), false);
        const expired = h.a._retryFiles.get(ids[3]); expired.expires = Date.now() - 1;
        assert.equal(h.a.retryFile(ids[3]), false);
        assert.equal(h.a._retryFiles.has(ids[3]), false);
        h.a._forgetRetry(ids[4]); assert.equal(h.a._retryFiles.has(ids[4]), false);
        h.a.abortAll('identity ended');
        assert.equal(h.a._retryFiles.size, 0);
        assert.equal(h.a._filesQueue.length, 0);
        assert.equal(h.a._queueBlocked, false);
        assert.ok(h.events.some(event => event.type === 'transfer-retry-state' && !event.detail.available));
    } finally { h.cleanup(); }
});

test('an offer timeout retains its file for explicit retry and does not automatically send the next file', async () => {
    const h = await harness();
    try {
        h.a.sendFiles([new File(['unconfirmed'], 'unconfirmed.txt'), new File(['later'], 'later.txt')]);
        await h.until(() => h.b._incoming);
        const timedOut = h.a._outgoing;
        assert.equal(h.timers.get(timedOut.timer).ms, 120000);
        h.timers.get(timedOut.timer).fn();
        await h.settle();
        assert.equal(h.a._outgoing, null);
        assert.equal(h.a._queueBlocked, true);
        assert.equal(h.a._filesQueue.length, 1);
        assert.equal(h.a._retryFiles.get(timedOut.meta.id).file, timedOut.file);
        assert.equal(h.b._incoming, null);
        assert.equal(h.sentBytes(), 0);
        assert.equal(h.wires.filter(item => item.from === 'a' && item.message.type === 'offer').length, 1);
    } finally { h.cleanup(); }
});

test('transient disconnect releases failed retries but preserves the blocked remaining queue until manual continue', async () => {
    const h = await harness();
    try {
        h.a.sendFiles([new File(['failed'], 'failed'), new File(['later'], 'later')]);
        await h.until(() => h.b._incoming);
        const failedId = h.b._incoming.meta.id;
        h.b.rejectIncoming(failedId); await h.until(() => !h.a._outgoing);
        h.a._verified = false; h.a._path = { direct: false };
        assert.equal(h.a.suspendTransfers('fixture reconnect'), true);
        assert.equal(h.a._retryFiles.size, 0);
        assert.equal(h.a._held.pendingFiles.length, 1);
        const pausedQueue = h.events.filter(event => event.type === 'send-queue-state' && event.detail.peerId === 'b').at(-1).detail;
        assert.equal(pausedQueue.count, 1);
        assert.equal(pausedQueue.ready, false, 'queue controls must reflect the reconnecting identity state');
        h.a._verified = true; h.a._path = { direct: true }; h.a.restoreTransfers();
        await h.settle();
        assert.equal(h.a._outgoing, null);
        assert.equal(h.a._queueBlocked, true);
        h.a.continueQueue(); await h.until(() => h.b._incoming);
        assert.equal(h.b._incoming.meta.name, 'later');
    } finally { h.cleanup(); }
});

test('a failed-file retry cannot bypass another completed Blob waiting for save or discard', async () => {
    const h = await harness();
    try {
        h.a.sendFiles([new File(['failed'], 'failed.txt'), new File(['complete'], 'complete.txt')]);
        await h.until(() => h.b._incoming);
        const failedId = h.b._incoming.meta.id;
        h.b.rejectIncoming(failedId); await h.until(() => !h.a._outgoing);
        h.a.continueQueue(); await h.until(() => h.b._incoming);
        const completedId = h.b._incoming.meta.id;
        await h.b.acceptIncoming(completedId);
        await h.until(() => h.a._queueWaitId === completedId);
        assert.equal(h.a._retryFiles.has(failedId), true);
        h.a.retryFile(failedId); h.a.clearQueue(); h.a.retryFile(failedId);
        await h.settle();
        assert.equal(h.a._outgoing, null);
        assert.equal(h.a._queueWaitId, completedId, 'clear pending queue cannot release the saved-file barrier');
        assert.equal(h.a._retryFiles.has(failedId), true, 'blocked retry retains its original File reference');
        await h.a._onMessage(JSON.stringify({ type: 'ready-next', id: failedId }));
        assert.equal(h.a._queueWaitId, completedId);
        const result = h.events.find(event => event.type === 'file-received').detail;
        result.release(); h.b.sendJSON({ type: 'ready-next', id: completedId });
        await h.until(() => !h.a._queueWaitId);
        assert.equal(h.a.retryFile(failedId), true);
        await h.until(() => h.b._incoming);
        assert.notEqual(h.b._incoming.meta.id, failedId);
        assert.equal(h.b._incoming.meta.name, 'failed.txt');
        assert.equal(h.a._outgoing.phase, 'offered', 'fresh receiver consent is still required after the barrier');
    } finally { h.cleanup(); }
});

test('expiring a held queue releases the files and publishes an empty queue state', async () => {
    const h = await harness();
    try {
        h.a.sendFiles([new File(['offered'], 'offered.txt'), new File(['later'], 'later.txt')]);
        await h.until(() => h.b._incoming);
        h.a._verified = false; h.a._path = { direct: false };
        h.a.suspendTransfers('fixture reconnect');
        const hold = h.a._held;
        assert.ok(h.timers.get(hold.timer).ms <= 120000);
        h.timers.get(hold.timer).fn();
        assert.equal(h.a._held, null);
        assert.equal(hold.pendingFiles.length, 0);
        const empty = h.events.filter(event => event.type === 'send-queue-state' && event.detail.peerId === 'b').at(-1).detail;
        assert.equal(empty.count, 0);
        assert.equal(empty.ready, false);
        h.a._verified = true; h.a._path = { direct: true }; h.a.restoreTransfers();
        assert.equal(h.a._outgoing, null);
    } finally { h.cleanup(); }
});

test('clearing the queue while reconnecting releases the held files and cannot offer them after recovery', async () => {
    const h = await harness();
    try {
        h.a.sendFiles([new File(['offered'], 'offered'), new File(['later'], 'later')]);
        await h.until(() => h.b._incoming);
        h.a._verified = false; h.a._path = { direct: false };
        assert.equal(h.a.suspendTransfers('fixture reconnect'), true);
        assert.equal(h.a._held.pendingFiles.length, 2);
        h.a.clearQueue();
        assert.equal(h.a._held.pendingFiles.length, 0, 'clear must release held page-memory File references too');
        h.a._verified = true; h.a._path = { direct: true }; h.a.restoreTransfers();
        await h.settle();
        assert.equal(h.a._outgoing, null);
        assert.equal(h.a._filesQueue.length, 0);
    } finally { h.cleanup(); }
});
