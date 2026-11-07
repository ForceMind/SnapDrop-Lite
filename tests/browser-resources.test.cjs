'use strict';
// Boundary fixtures validate bounded/sanitized reporting, not actual browser
// resource usage. Real measurements are produced only by Chromium E2E.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { start } = require('./browser-resources.cjs');

class Session extends EventEmitter {
    constructor(send) { super(); this.command = send; this.detached = 0; }
    send(method, params) { return this.command(method, params); }
    async detach() { this.detached++; this.emit('close'); }
}
const pageFor = session => ({ context: () => ({ newCDPSession: async () => session }) });

test('unsupported engines never inspect pages or manufacture metric values', async () => {
    const page = { context() { assert.fail('CDP is Chromium-only'); } };
    for (const engine of ['firefox', 'webkit']) {
        const probe = await start(page, { engine });
        const result = await probe.stop();
        assert.equal(result.status, 'unsupported');
        assert.equal(result.supported, false);
        assert.deepEqual(result.samples, []);
        assert.deepEqual(result.summary, {});
        assert.equal(await probe.stop(), result, 'stop must be idempotent');
    }
});

test('CDP output is numeric-allowlisted, missing fields stay absent, and raw errors never leave the probe', async () => {
    const sensitive = 'https://private.example/#room=private-token';
    const session = new Session(async (method, params) => {
        if (method === 'Performance.enable') { assert.deepEqual(params, { timeDomain: 'timeTicks' }); return {}; }
        if (method === 'Runtime.getHeapUsage') return { usedSize: 123, totalSize: 200, embedderHeapUsedSize: NaN, backingStorageSize: -1, url: sensitive };
        if (method === 'Performance.getMetrics') return { metrics: [
            { name: 'TaskDuration', value: 2 }, { name: sensitive, value: 100 },
            { name: 'ScriptDuration', value: Infinity }, { name: 'LayoutDuration', value: '1' }
        ], url: sensitive };
        return {};
    });
    const probe = await start(pageFor(session), { engine: 'chromium', maxSamples: 1 });
    const report = await probe.stop();
    assert.equal(report.status, 'sampled');
    assert.equal(report.sampling.count, 1);
    assert.equal(report.sampling.limitReached, true);
    assert.deepEqual(report.samples[0].heap, { usedSize: 123, totalSize: 200 });
    assert.deepEqual(report.samples[0].performance, { TaskDuration: 2 });
    assert.equal(report.summary.performance.TaskDuration.delta, null, 'one cumulative point cannot prove an interval delta');
    assert.equal(JSON.stringify(report).includes(sensitive), false);
    assert.equal(session.detached, 1);

    const broken = new Session(async method => {
        if (method === 'Runtime.getHeapUsage') throw Error(sensitive);
        if (method === 'Performance.getMetrics') return { metrics: [{ name: 'TaskDuration', value: 1 }] };
        return {};
    });
    const partial = await start(pageFor(broken), { engine: 'chromium' });
    broken.emit('close');
    const result = await partial.stop();
    assert.equal(result.status, 'partial');
    assert.equal(result.issues['heap-command-failed'], 1);
    assert.equal(result.issues['session-closed'], 1);
    assert.equal(result.summary.heap, undefined);
    assert.equal(JSON.stringify(result).includes(sensitive), false);
});

test('sample cap terminates polling and a reset renderer counter does not produce a false CPU duration', async () => {
    let heapCalls = 0, metricCalls = 0;
    const session = new Session(async method => {
        if (method === 'Runtime.getHeapUsage') return { usedSize: ++heapCalls * 100 };
        if (method === 'Performance.getMetrics') return { metrics: [{ name: 'TaskDuration', value: ++metricCalls === 1 ? 10 : 2 }] };
        return {};
    });
    const probe = await start(pageFor(session), { engine: 'chromium', intervalMs: 1, maxSamples: 2 });
    await new Promise(resolve => setTimeout(resolve, 550));
    const report = await probe.stop();
    assert.equal(report.sampling.intervalMs, 250, 'caller cannot poll more frequently than the hard bound');
    assert.equal(heapCalls, 2);
    assert.equal(metricCalls, 2);
    assert.equal(report.summary.heap.usedSize.peak, 200);
    assert.equal(report.summary.performance.TaskDuration.counterResetObserved, true);
    assert.equal(report.summary.performance.TaskDuration.delta, null);
    assert.equal(session.detached, 1);
});

test('an attachment deadline is bounded and a session arriving late is detached without exposing failure text', async () => {
    const session = new Session(async () => ({}));
    const page = { context: () => ({ newCDPSession: () => new Promise(resolve => setTimeout(() => resolve(session), 180)) }) };
    const probe = await start(page, { engine: 'chromium', commandTimeoutMs: 100 });
    const result = await probe.stop();
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.issues, { 'attach-timeout': 1 });
    assert.deepEqual(result.samples, []);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(session.detached, 1);
});
