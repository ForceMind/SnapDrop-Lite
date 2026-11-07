'use strict';
// A delayed File read is deliberately left unresolved while cancellation must
// release the real receive chain. No browser I/O timing assumptions are needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function rig() {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const timers = new Map(), errors = [], frames = [], pumps = [];
    const context = vm.createContext({
        crypto: crypto.webcrypto, performance, File, Blob, Uint8Array, TextEncoder,
        setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.set(timer, { fn, ms }); return timer; },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
        window: { ZeydropHash: sha256 }, Events: { fire() {} }
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Peer=TransferPeer;', context);
    const peers = [];
    const peer = () => {
        const p = new context.Peer({}, 'same-paired-peer');
        p._verified = true; p._remoteHello = true; p._path = { direct: true };
        p._isConnected = () => true; p._connectionEvent = () => {};
        p._send = data => frames.push(typeof data === 'string' ? JSON.parse(data) : data);
        p._pump = async state => { pumps.push({ state, epoch: state.sendEpoch || 0 }); };
        p.close = reason => { errors.push(reason); p.abortAll(reason); };
        peers.push(p); return p;
    };
    const reads = [];
    const prepare = (p, stillCurrent = null, expectedHash = '0'.repeat(64)) => {
        let resolve, reject;
        const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
        const file = new File([Buffer.alloc(16384)], 'delayed-local-file.bin');
        const read = { resolve, reject, started: false, size: file.size };
        reads.push(read);
        file.slice = () => ({ arrayBuffer: () => { read.started = true; return pending; } });
        const id = crypto.randomUUID();
        p._outgoing = { file, meta: { id, name: file.name, size: file.size, mime: 'application/octet-stream' },
            phase: 'resuming', hash: sha256.create(), offset: 0, acked: 0, start: performance.now() };
        p._receive(JSON.stringify({ type: 'resume-at', id, offset: file.size, sha256: expectedHash }), stillCurrent);
        return { read, state: p._outgoing, id };
    };
    const drainsBeforeRead = async p => Promise.race([
        p._messageChain.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 60))
    ]);
    const cleanup = async () => {
        for (const read of reads) read.resolve(new ArrayBuffer(read.size));
        await Promise.allSettled(peers.map(p => p._messageChain));
        for (const p of peers) p.abortAll('fixture cleanup');
        for (const timer of timers.keys()) clearTimeout(timer);
    };
    return { peer, prepare, timers, errors, frames, pumps, drainsBeforeRead, cleanup, sha256 };
}

test('local cancellation unblocks queued control and a new offer before the old prefix read resolves', async () => {
    const h = await rig(), p = h.peer();
    try {
        const old = h.prepare(p); await tick(); assert.equal(old.read.started, true);
        const job = old.state.prefixJob;
        p._receive(JSON.stringify({ type: 'cancel', id: old.id }));
        p.cancel(old.id, 'local cancellation');
        const next = crypto.randomUUID();
        p._receive(JSON.stringify({ type: 'offer', id: next, name: 'next.bin', size: 1, mime: 'application/octet-stream' }));
        assert.equal(await h.drainsBeforeRead(p), true, 'cancel must settle the prefix await without waiting for Blob I/O');
        assert.equal(p._incoming?.meta.id, next);
        assert.equal(p._outgoing, null); assert.equal(h.errors.length, 0);
        assert.equal(job.done, true, 'cancelled prefix task itself must settle before its underlying File read');
        old.read.resolve(new ArrayBuffer(old.read.size)); await tick();
        assert.equal(p._incoming.meta.id, next, 'late prefix bytes cannot mutate the newer transfer');
        assert.equal(h.pumps.length, 0);
    } finally { await h.cleanup(); }
});

test('a current-wire remote cancel releases the prefix task without bypassing obsolete-wire rejection', async () => {
    const h = await rig(), p = h.peer();
    try {
        const old = h.prepare(p); await tick(); const job = old.state.prefixJob;
        p._receive(JSON.stringify({ type: 'cancel', id: old.id }), () => false);
        await tick(); assert.equal(p._outgoing, old.state, 'obsolete wire cannot cancel a current prefix');
        p._receive(JSON.stringify({ type: 'cancel', id: old.id }), () => true);
        assert.equal(await h.drainsBeforeRead(p), true);
        await tick();
        assert.equal(p._outgoing, null); assert.equal(job.done, true);
        assert.equal(h.errors.length, 0); assert.equal(h.pumps.length, 0);
    } finally { await h.cleanup(); }
});

test('accept, resume, ACK, checkpoint and completion cannot send or change an unverified prefix', async () => {
    const h = await rig(), p = h.peer();
    try {
        const old = h.prepare(p); await tick();
        let acknowledgements = 0;
        old.state.waiter = { resolve() { acknowledgements++; }, reject() {} };
        old.state.expectedAck = old.state.offset;
        const before = Buffer.from(old.state.hash.clone().digest()).toString('hex');
        for (const message of [
            { type: 'accept', id: old.id }, { type: 'resume', id: old.id },
            { type: 'ack', id: old.id, offset: 0 }, { type: 'checkpoint', id: old.id, offset: 0 },
            { type: 'complete', id: old.id, sha256: '0'.repeat(64), readyNext: true }
        ]) p._receive(JSON.stringify(message));
        assert.equal(await h.drainsBeforeRead(p), true);
        assert.equal(old.state.phase, 'resuming'); assert.equal(old.state.resumeBusy, true);
        assert.equal(old.state.offset, 0); assert.equal(old.state.acked, 0);
        assert.equal(Buffer.from(old.state.hash.clone().digest()).toString('hex'), before);
        assert.equal(acknowledgements, 0); assert.equal(h.pumps.length, 0);
        assert.equal(h.frames.some(frame => frame.type === 'resume-confirm' || frame instanceof ArrayBuffer), false);
        // Exercise the real pump guard independently of the recording stub.
        p._pump = Object.getPrototypeOf(p)._pump;
        await p._pump(old.state);
        assert.equal(h.frames.some(frame => frame.type === 'finish'), false);
        assert.equal(h.errors.length, 0);
    } finally { await h.cleanup(); }
});

test('duplicate resume-at is single-flight and cannot produce premature data', async () => {
    const h = await rig(), p = h.peer();
    try {
        const old = h.prepare(p); await tick(); const job = old.state.prefixJob;
        p._receive(JSON.stringify({ type: 'resume-at', id: old.id, offset: 0, sha256: crypto.createHash('sha256').digest('hex') }));
        await p._messageChain; await tick();
        assert.equal(h.errors.length, 1);
        assert.equal(p._outgoing, null); assert.equal(job.done, true);
        assert.equal(h.pumps.length, 0);
    } finally { await h.cleanup(); }
});

test('a late background prefix rejection from an obsolete wire cannot close the current connection', async () => {
    const h = await rig(), p = h.peer(); let valid = true;
    try {
        const old = h.prepare(p, () => valid); await tick(); valid = false;
        old.read.reject(Error('old-wire private read failure')); await tick();
        assert.equal(h.errors.length, 0);
        assert.equal(p._outgoing, old.state); assert.equal(old.state.offset, 0);
        assert.equal(h.pumps.length, 0);
    } finally { await h.cleanup(); }
});

test('cancelled but unresolved prefix reads remain capped, while ordinary file offers still work', async () => {
    const h = await rig();
    try {
        const held = [];
        for (let i = 0; i < 4; i++) {
            const p = h.peer(), old = h.prepare(p); await tick();
            assert.equal(old.read.started, true); p.cancel(old.id, 'fixture cancel'); await tick(); held.push(old);
        }
        const p = h.peer(), capped = h.prepare(p); await tick();
        assert.equal(capped.read.started, false, 'a fifth stale-read allocation must not be started');
        assert.equal(p._outgoing, null, 'cap fails only this prefix file'); assert.equal(h.errors.length, 0);
        const normalId = crypto.randomUUID();
        p._receive(JSON.stringify({ type: 'offer', id: normalId, name: 'normal.bin', size: 1, mime: 'application/octet-stream' }));
        await p._messageChain; assert.equal(p._incoming?.meta.id, normalId);
        p.cancel(normalId);
        held[0].read.resolve(new ArrayBuffer(held[0].read.size)); await tick();
        const resumed = h.prepare(p); await tick(); assert.equal(resumed.read.started, true, 'settled I/O releases the read reservation');
    } finally { await h.cleanup(); }
});

test('transport suspension releases the old prefix await and late rejection cannot cancel the restored generation', async () => {
    const h = await rig(), p = h.peer();
    try {
        const old = h.prepare(p); await tick();
        p._verified = false; p._path = { direct: false };
        assert.equal(p.suspendTransfers('fixture network loss'), true);
        assert.equal(await h.drainsBeforeRead(p), true);
        p._verified = true; p._path = { direct: true }; p.restoreTransfers();
        const generation = old.state.sendEpoch;
        p._receive(JSON.stringify({ type: 'resume-at', id: old.id, offset: 0, sha256: crypto.createHash('sha256').digest('hex') }));
        assert.equal(await h.drainsBeforeRead(p), true);
        assert.equal(h.pumps.length, 1);
        assert.equal(p._outgoing, old.state); assert.equal(old.state.phase, 'sending');
        old.read.reject(Error('private-file read failed late')); await tick();
        assert.equal(p._outgoing, old.state); assert.equal(old.state.sendEpoch, generation);
        assert.equal(old.state.offset, 0); assert.equal(h.errors.length, 0);
    } finally { await h.cleanup(); }
});

test('the prefix deadline cancels an unresolved read and still permits another file offer on the channel', async () => {
    const h = await rig(), p = h.peer();
    try {
        const old = h.prepare(p); await tick();
        assert.equal(h.timers.get(old.state.timer).ms, 5 * 60 * 1000);
        h.timers.get(old.state.timer).fn();
        const next = crypto.randomUUID();
        p._receive(JSON.stringify({ type: 'offer', id: next, name: 'after-timeout.bin', size: 1, mime: 'application/octet-stream' }));
        assert.equal(await h.drainsBeforeRead(p), true);
        assert.equal(p._incoming?.meta.id, next);
        assert.equal(h.errors.length, 0);
    } finally { await h.cleanup(); }
});

test('short or non-ArrayBuffer prefix reads cannot commit offset or hash even when their returned bytes match the claimed digest', async () => {
    const cases = [
        { value: new ArrayBuffer(0), bytes: Buffer.alloc(0) },
        { value: new ArrayBuffer(16383), bytes: Buffer.alloc(16383) },
        { value: new Uint8Array(16384), bytes: Buffer.alloc(16384) },
        { value: { byteLength: 16384 }, bytes: Buffer.alloc(0) }
    ];
    for (const entry of cases) {
        const h = await rig(), p = h.peer();
        try {
            const claimed = crypto.createHash('sha256').update(entry.bytes).digest('hex');
            const old = h.prepare(p, null, claimed); await tick();
            const originalHash = old.state.hash;
            old.read.resolve(entry.value); await tick();
            assert.equal(old.state.offset, 0, 'a read must cover its exact declared slice');
            assert.equal(old.state.acked, 0); assert.equal(old.state.hash, originalHash);
            assert.equal(h.frames.some(frame => frame.type === 'resume-confirm'), false);
            assert.equal(h.pumps.length, 0); assert.equal(p._outgoing, null);
        } finally { await h.cleanup(); }
    }
});

test('an exact cross-realm ArrayBuffer prefix retains the cloneable hash contract', async () => {
    const h = await rig(), p = h.peer();
    try {
        const expected = crypto.createHash('sha256').update(Buffer.alloc(16384)).digest('hex');
        const old = h.prepare(p, null, expected); await tick();
        old.read.resolve(vm.runInNewContext('new ArrayBuffer(16384)')); await tick();
        assert.equal(old.state.offset, 16384); assert.equal(h.pumps.length, 1);
        assert.equal(Buffer.from(old.state.hash.clone().digest()).toString('hex'), expected);
        assert.equal(h.errors.length, 0);
    } finally { await h.cleanup(); }
});

test('a stale post-prefix pump rejection microtask cannot cancel a reused state after epoch or wire replacement', async () => {
    for (const replacement of ['epoch', 'wire']) {
        const h = await rig(), p = h.peer(); let validWire = true;
        try {
            p.sendFiles([new File(['next'], 'reused-state.bin')]);
            const state = p._outgoing;
            p._pump = () => Promise.reject(Error('old-pump rejection'));
            const task = p._resumeFromOffset({ id: state.meta.id, offset: 0, sha256: crypto.createHash('sha256').digest('hex') }, () => validWire);
            if (replacement === 'epoch') state.sendEpoch = (state.sendEpoch || 0) + 1;
            else validWire = false;
            state.phase = 'resuming';
            await task; await tick();
            assert.equal(p._outgoing, state, replacement + ' must retire a queued pump error');
            assert.equal(state.phase, 'resuming'); assert.equal(state.error, undefined);
        } finally { await h.cleanup(); }
    }
});
