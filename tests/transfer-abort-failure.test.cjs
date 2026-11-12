'use strict';
// Run the actual transfer state machine in a Node child so a deliberately
// rejected native abort promise is observed without leaking unhandled events
// into unrelated test cases. The child reports real unhandledRejection events;
// swallowing every rejection in the storage fixture would hide this defect.
const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

async function nativeAbortScenario(options) {
    const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
    const turn = () => new Promise(resolve => setImmediate(resolve));
    const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
    const unhandled = [], events = [], frames = [], timers = new Set(), hashes = [];
    process.on('unhandledRejection', error => unhandled.push(error?.name || 'Error'));
    const failure = new DOMException('private-native-error:file-secret-name:invite-secret-token', 'NotAllowedError');
    const abortEntered = gate(), abortGate = options.sync ? null : gate(), openEntered = gate(), openGate = gate();
    let opens = 0, aborts = 0, freshAborts = 0, closes = 0;
    const oldSink = { size: 0, async write() {}, async checkpoint() {}, async finish() { throw Error('must never finish'); },
        abort() { aborts++; abortEntered.resolve(); if (options.sync) throw failure; return abortGate.promise; } };
    if (options.durable) oldSink.park = async () => { throw Error('explicit cancellation must not park'); };
    const freshSink = { size: 0, async write() {}, async abort() { freshAborts++; } };
    const window = { ZeydropStreamHash: { create() {
        const hash = { closed: false, async update() {}, async digestHex() { return 'a'.repeat(64); }, dispose() { this.closed = true; } };
        hashes.push(hash); return hash;
    } }, ZeydropRecovery: { supported: true, async open() {
        if (opens++ !== 0) return freshSink;
        if (options.preparing) { openEntered.resolve(); await openGate.promise; }
        return oldSink;
    } } };
    if (options.nativeWriter) window.showSaveFilePicker = async () => ({
        async createWritable() { return { async write() {}, async close() {}, abort: () => oldSink.abort() }; }
    });
    const context = vm.createContext({ window, crypto: crypto.webcrypto, performance, ArrayBuffer, Uint8Array, TextEncoder, Blob, File,
        Events: { fire(type, detail) { events.push({ type, detail }); } },
        setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer=TransferPeer;', context);
    function peer(verified = true) {
        const p = new context.Peer({}, 'same-locked-paired-device');
        Object.assign(p, { _verified: verified, _path: { direct: true }, _remoteHello: true, _pathEpoch: 0,
            _isConnected: () => true, _connectionEvent() {} });
        p._send = text => frames.push(JSON.parse(text));
        p.close = () => { closes++; }; return p;
    }
    const original = peer(), meta = { id: crypto.randomUUID(), name: 'cancelled-local-file.bin', size: 1, mime: 'application/octet-stream' };
    await original._onMessage(JSON.stringify({ type: 'offer', ...meta }));
    const old = original._incoming, accepting = original.acceptIncoming(meta.id, { durable: !options.nativeWriter });
    if (options.preparing) await openEntered.promise; else await accepting;
    let owner = original;
    if (options.adopted) {
        original.suspendTransfers('transport handoff'); owner = peer(false);
        owner.adoptHeldTransfers(original.takeHeldTransfers()); owner._verified = true; owner.restoreTransfers();
    }
    const reason = 'explicit cancellation from fixture';
    if (options.held) { owner.suspendTransfers('temporary disconnect'); owner._dropHeld(reason); }
    else owner.cancel(meta.id, reason);
    let fresh;
    if (options.replacement) {
        await owner._onMessage(JSON.stringify({ type: 'offer', ...meta, name: 'fresh-same-id.bin' }));
        fresh = owner._incoming; await owner.acceptIncoming(meta.id, { durable: true });
    }
    if (options.preparing) openGate.resolve();
    await abortEntered.promise;
    if (!options.sync) abortGate.reject(failure);
    await accepting; await turn(); await turn(); await turn();
    const result = { unhandled, aborts, freshAborts, closes, notifications: events.filter(event => event.type === 'notify-user').map(event => event.detail),
        reason, oldCancelled: old.error === reason, oldHashDisposed: old.hash.closed,
        emptySlot: owner._incoming === null, fresh: fresh ? { same: owner._incoming === fresh, offset: fresh.offset,
            name: fresh.meta.name, error: fresh.error ?? null, sinkSame: fresh.sink === freshSink, hashClosed: fresh.hash.closed } : null,
        verified: owner._verified, direct: owner._path.direct, completes: frames.filter(frame => frame.type === 'complete').length };
    for (const timer of timers) clearTimeout(timer);
    for (const hash of hashes) hash.dispose();
    return result;
}

function runScenario(options) {
    const code = '(' + nativeAbortScenario.toString() + ')(' + JSON.stringify(options) + ').then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{process.stderr.write(String(error.stack||error));process.exitCode=1;});';
    const result = spawnSync(process.execPath, ['--unhandled-rejections=warn', '-e', code], { cwd: process.cwd(), encoding: 'utf8', timeout: 4000 });
    assert.equal(result.error, undefined, 'native-boundary child must finish: ' + result.error);
    assert.equal(result.status, 0, 'abort handling must not throw out of cancellation: ' + result.stderr);
    assert.ok(result.stdout, 'native-boundary child must report the actual rejected abort outcome');
    return JSON.parse(result.stdout);
}
function safeFailure(result) {
    assert.deepEqual(result.unhandled, [], 'every native abort rejection must have an observer');
    assert.equal(result.aborts, 1, 'a failed native abort is not silently retried or applied twice');
    const warning = result.notifications.filter(message => message !== result.reason
        && !['transport handoff', 'temporary disconnect'].includes(message));
    assert.equal(warning.length, 1, 'the user needs one explicit local cleanup failure notice');
    assert.equal(typeof warning[0], 'string'); assert.ok(warning[0].length <= 240, 'cleanup feedback stays bounded');
    assert.match(warning[0], /清理|删除|移除/); assert.match(warning[0], /失败|未能|无法|不能|可能/);
    assert.doesNotMatch(warning[0], /private-native-error|file-secret-name|invite-secret-token|NotAllowedError|已删除|清理成功|删除成功/);
    assert.equal(result.oldCancelled, true); assert.equal(result.oldHashDisposed, true);
    assert.equal(result.closes, 0); assert.equal(result.completes, 0);
}

for (const durable of [false, true]) test((durable ? 'durable' : 'ordinary') + ' incoming abort rejection is consumed and reports that local cleanup cannot be guaranteed', () => {
    const result = runScenario({ durable }); safeFailure(result);
    assert.equal(result.emptySlot, true); assert.equal(result.verified, true); assert.equal(result.direct, true);
});

test('a synchronous native abort throw cannot interrupt cancellation or escape its fixed local cleanup warning', () => {
    const result = runScenario({ durable: true, sync: true }); safeFailure(result); assert.equal(result.emptySlot, true);
});

test('the actual ReceiveSink native writer propagates abort failure to the observed cleanup warning', () => {
    const result = runScenario({ nativeWriter: true }); safeFailure(result); assert.equal(result.emptySlot, true);
});

for (const adopted of [false, true]) test('a late abort rejection touches only the cancelled sink while a fresh same-ID incoming transfer stays active ' + (adopted ? 'on an adopted owner' : 'on the same peer'), () => {
    const result = runScenario({ durable: true, replacement: true, adopted }); safeFailure(result);
    assert.equal(result.freshAborts, 0); assert.equal(result.verified, true); assert.equal(result.direct, true);
    assert.deepEqual(result.fresh, { same: true, offset: 0, name: 'fresh-same-id.bin', error: null, sinkSame: true, hashClosed: false });
});

test('a stale preparation sink abort failure is consumed once and cannot cancel a fresh same-ID accepted offer', () => {
    const result = runScenario({ durable: true, preparing: true, replacement: true }); safeFailure(result);
    assert.equal(result.freshAborts, 0);
    assert.deepEqual(result.fresh, { same: true, offset: 0, name: 'fresh-same-id.bin', error: null, sinkSame: true, hashClosed: false });
});

test('an ordinary sink abort rejected during held-transfer cleanup still reports a local cleanup failure', () => {
    const result = runScenario({ durable: false, held: true }); safeFailure(result); assert.equal(result.emptySlot, true);
});
