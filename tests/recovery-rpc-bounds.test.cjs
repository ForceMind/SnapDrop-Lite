'use strict';
// Executes the actual bridge with a controlled Worker transport. Filesystem
// command ordering and native OPFS behavior retain their separate regressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('client/scripts/recovery.js', 'utf8');

function harness(t) {
    const workers = [];
    class Worker {
        constructor() { this.posts = []; this.terminated = false; workers.push(this); }
        postMessage(value) { if (this.sendFailure) throw this.sendFailure; this.posts.push(value); }
        terminate() { this.terminated = true; }
        reply(request, value) { this.onmessage({ data: { request, ok: true, value } }); }
    }
    const context = vm.createContext({ Worker, navigator: { storage: { getDirectory: async () => ({}) } }, window: {}, URL, ArrayBuffer });
    vm.runInContext(source + '\nglobalThis.RecoveryStoreClass=ZeydropRecoveryStore;globalThis.DurableSinkClass=ZeydropDurableSink;', context);
    const store = context.window.ZeydropRecovery;
    t.after(() => { if (store.worker) store.worker.onerror(); });
    return { store, workers, Store: context.RecoveryStoreClass, Sink: context.DurableSinkClass };
}
const capture = promise => promise.then(value => ({ value }), error => ({ error }));

test('32 accepted unresolved storage RPCs remain counted and a completion frees exactly one slot', { timeout: 10000 }, async t => {
    const { store, workers, Store } = harness(t);
    const jobs = Array.from({ length: 32 }, () => capture(store.request('list')));
    const worker = workers[0];
    assert.equal(store.pending.size, 32); assert.equal(worker.posts.length, 32);
    const overflow = capture(store.request('append', 'private-fixture-id', new ArrayBuffer(16)));
    assert.equal(store.pending.size, 32, 'a rejected operation must never become an accepted pending job');
    assert.equal(Store.MAX_PENDING, 32);
    assert.equal(worker.posts.length, 32); assert.equal(workers.length, 1); assert.equal(store.sequence, 32);
    const blocked = (await overflow).error;
    assert.equal(blocked.name, 'StorageBusyError'); assert.ok(!blocked.message.includes('private-fixture-id'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.pending.size, 32, 'already-started operations have no synthetic timeout or implicit abort');
    worker.reply(worker.posts[0].request, 'first-complete'); assert.equal((await jobs[0]).value, 'first-complete');
    assert.equal(store.pending.size, 31);
    const next = capture(store.request('probe')); assert.equal(store.pending.size, 32); assert.equal(worker.posts.length, 33);
    assert.equal(worker.posts.at(-1).request, 33);
    worker.reply(worker.posts.at(-1).request, true); assert.equal((await next).value, true);
    worker.onerror(); await Promise.all(jobs); assert.equal(store.pending.size, 0);
});

test('an error reply and a synchronous send failure each release only their own reservation', async t => {
    const { store, workers } = harness(t);
    const first = capture(store.request('list')), second = capture(store.request('probe')); const worker = workers[0];
    worker.onmessage({ data: { request: worker.posts[0].request, ok: false, error: 'local quota fixture', errorName: 'QuotaExceededError' } });
    assert.equal((await first).error.name, 'QuotaExceededError'); assert.equal(store.pending.size, 1);
    worker.sendFailure = Error('synthetic private send context');
    const send = await capture(store.request('append', 'private-fixture-id', new ArrayBuffer(16)));
    assert.ok(send.error); assert.equal(store.pending.size, 1); assert.equal(worker.posts.length, 2);
    delete worker.sendFailure;
    const next = capture(store.request('list')); assert.equal(store.pending.size, 2);
    worker.reply(worker.posts[1].request, true); assert.equal((await second).value, true);
    worker.reply(worker.posts.at(-1).request, []); assert.deepEqual((await next).value, []); assert.equal(store.pending.size, 0);
});

test('worker crash clears accepted jobs while old messages and errors cannot consume replacement slots', async t => {
    const { store, workers } = harness(t);
    const oldJobs = Array.from({ length: 32 }, () => capture(store.request('list'))), old = workers[0];
    old.onmessageerror();
    assert.equal(store.pending.size, 0); assert.equal(store.worker, null); assert.equal(old.terminated, true);
    assert.ok((await Promise.all(oldJobs)).every(result => result.error));
    const fresh = capture(store.request('list')), current = workers[1], request = current.posts[0].request;
    assert.ok(request > old.posts.at(-1).request, 'replacement workers must not reuse old request IDs');
    old.onmessage({ data: { request, ok: true, value: 'stale' } }); old.onerror(); old.onmessageerror();
    assert.equal(store.worker, current); assert.equal(store.pending.size, 1); assert.equal(current.terminated, false);
    current.reply(request, 'current'); assert.equal((await fresh).value, 'current'); assert.equal(store.pending.size, 0);
});

test('safe sequence exhaustion rejects before creating a worker or posting and cannot reuse an ID', { timeout: 10000 }, async t => {
    const { store, workers } = harness(t);
    store.sequence = Number.MAX_SAFE_INTEGER;
    const operation = capture(store.request('append', 'private-fixture-id', new ArrayBuffer(16)));
    assert.equal(workers.length, 0, 'an exhausted sequence must be refused before starting any worker');
    const exhausted = await operation;
    assert.equal(exhausted.error.name, 'StorageRequestLimitError'); assert.ok(!exhausted.error.message.includes('private-fixture-id'));
    assert.equal(workers.length, 0); assert.equal(store.pending.size, 0); assert.equal(store.sequence, Number.MAX_SAFE_INTEGER);
    for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        store.sequence = invalid; assert.equal((await capture(store.request('list'))).error.name, 'StorageRequestLimitError');
        assert.equal(workers.length, 0); assert.equal(store.pending.size, 0);
    }
    store.sequence = Number.MAX_SAFE_INTEGER - 1;
    const final = capture(store.request('list')), worker = workers[0];
    assert.equal(worker.posts[0].request, Number.MAX_SAFE_INTEGER); assert.equal(store.pending.size, 1);
    const blocked = await capture(store.request('list')); assert.equal(blocked.error.name, 'StorageRequestLimitError');
    assert.equal(worker.posts.length, 1); assert.equal(store.pending.size, 1);
    worker.reply(Number.MAX_SAFE_INTEGER, 'last-safe'); assert.equal((await final).value, 'last-safe');
    assert.equal((await capture(store.request('list'))).error.name, 'StorageRequestLimitError');
    assert.equal(worker.posts.length, 1); assert.equal(store.pending.size, 0);
});

test('normal durable writes keep their existing one-ack-at-a-time flow', async t => {
    const { store, workers, Sink } = harness(t), sink = new Sink(store, 'fixture-id', { size: 2 }, 0);
    const first = sink.write(new Uint8Array([1])); const worker = workers[0];
    assert.equal(store.pending.size, 1); assert.equal(sink.size, 0); assert.equal(worker.posts[0].type, 'append');
    worker.reply(worker.posts[0].request, true); await first; assert.equal(sink.size, 1); assert.equal(store.pending.size, 0);
    const second = sink.write(new Uint8Array([2])); assert.equal(store.pending.size, 1); assert.equal(worker.posts.length, 2);
    worker.reply(worker.posts[1].request, true); await second; assert.equal(sink.size, 2); assert.equal(store.pending.size, 0);
});
