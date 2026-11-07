'use strict';
// Boundary fixtures validate bounded/sanitized reporting, not actual browser
// resource usage. Real measurements are produced only by Chromium E2E.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { start } = require('./browser-resources.cjs');

class Session extends EventEmitter {
    constructor(send) { super(); this.command = send; this.detached = 0; }
    send(method, params) { return this.command(method, params); }
    async detach() { this.detached++; this.emit('close'); }
}
const pageFor = session => ({ context: () => ({ newCDPSession: async () => session }) });
function browserPage(renderer, browserSession) {
    const page = new EventEmitter();
    page.context = () => ({ newCDPSession: async () => renderer,
        browser: () => ({ newBrowserCDPSession: async () => browserSession }) });
    return page;
}
const rendererSession = () => new Session(async method => method === 'Runtime.getHeapUsage'
    ? { usedSize: 100 } : method === 'Performance.getMetrics' ? { metrics: [{ name: 'TaskDuration', value: 1 }] } : {});
const procStat = (pid, start) => pid + ' (private process ) name) ' + ['S', ...Array(18).fill('0'), start].join(' ');

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

test('Linux proc parsing reads only the browser-listed same-uid fixture process and reports real RSS/PSS', { skip: process.platform !== 'linux' }, async () => {
    // The CDP endpoint is a fixture. This checks actual proc parsing/access for
    // this Node process, not a claim that Node is a Chromium browser process.
    const browserSession = new Session(async method => {
        assert.equal(method, 'SystemInfo.getProcessInfo');
        return { processInfo: [{ id: process.pid, type: 'browser', cpuTime: process.cpuUsage().user / 1e6 }] };
    });
    const probe = await start(browserPage(rendererSession(), browserSession), { engine: 'chromium', maxSamples: 1 });
    const report = await probe.stop();
    assert.equal(report.processes.status, 'sampled');
    assert.equal(report.samples[0].processes.listedCount, 1);
    assert.ok(report.summary.processes.rssSumBytes.peak > 0);
    assert.ok(report.summary.processes.pssSumBytes.peak > 0);
    assert.ok(report.summary.processes.rssSumBytes.peak >= report.summary.processes.pssSumBytes.peak);
    assert.equal(report.summary.processes.cpuObservedCumulativeSeconds, undefined, 'a first cumulative CPU reading is not interval CPU');
    assert.equal(browserSession.detached, 1);
});

test('process aggregation tracks churn, PID reuse and CPU reset without crossing identities or leaking PID/type/path', { skip: process.platform !== 'linux' }, async t => {
    const privateType = 'https://private.example/#room=do-not-report';
    const rounds = [
        [{ id: 10101, start: '11', cpuTime: 5, rss: 100, pss: 50 }, { id: 20202, start: '22', cpuTime: 8, rss: 200, pss: 100 }],
        [{ id: 10101, start: '11', cpuTime: 6, rss: 110, pss: 55 }, { id: 30303, start: '33', cpuTime: 1, rss: 50, pss: 25 }],
        [{ id: 10101, start: '99', cpuTime: 0.2, rss: 40, pss: 20 }, { id: 30303, start: '33', cpuTime: 1.5, rss: 60, pss: 30 }],
        [{ id: 10101, start: '99', cpuTime: 0.1, rss: 40, pss: 20 }, { id: 30303, start: '33', cpuTime: 1.8, rss: 60, pss: 30 }]
    ];
    let round = -1;
    const find = filename => {
        const pid = Number(filename.split('/')[2]);
        const item = rounds[round].find(value => value.id === pid);
        assert.ok(item, 'must only inspect the browser-listed process fixture'); return item;
    };
    t.mock.method(fs, 'stat', async filename => { find(filename); return { uid: process.getuid() }; });
    t.mock.method(fs, 'readFile', async filename => {
        const item = find(filename);
        if (filename.endsWith('/stat')) return procStat(item.id, item.start);
        assert.ok(filename.endsWith('/smaps_rollup'));
        return 'Rss: ' + item.rss + ' kB\nPss: ' + item.pss + ' kB\n';
    });
    const browserSession = new Session(async () => ({ processInfo: rounds[++round].map(item => ({ ...item, type: privateType })) }));
    const probe = await start(browserPage(rendererSession(), browserSession), { engine: 'chromium', maxSamples: 4, intervalMs: 250 });
    await new Promise(resolve => setTimeout(resolve, 950));
    const report = await probe.stop();
    assert.equal(report.processes.sampleCount, 4);
    assert.equal(report.summary.processes.rssSumBytes.peak, 300 * 1024);
    assert.equal(report.summary.processes.pssSumBytes.peak, 150 * 1024);
    assert.equal(report.samples[1].processes.exitedProcessCount, 1);
    assert.equal(report.samples[1].processes.newProcessCount, 1);
    assert.equal(report.samples[2].processes.reusedProcessCount, 1);
    assert.equal(report.samples[3].processes.cpuCounterResetCount, 1);
    assert.ok(Math.abs(report.summary.processes.cpuObservedCumulativeSeconds.last - 1.8) < 1e-9);
    assert.equal(report.processes.status, 'partial', 'churn leaves unobserved CPU intervals');
    assert.deepEqual(report.samples[0].processes.types, { other: 2 });
    const output = JSON.stringify(report);
    for (const secret of [privateType, '10101', '20202', '30303', '/proc/', 'private process']) assert.equal(output.includes(secret), false);
});

test('process list is capped at 128 and foreign-uid or unreadable memory stays partial rather than zero', { skip: process.platform !== 'linux' }, async t => {
    const inspected = new Set(), read = new Set();
    const pidOf = filename => { const pid = Number(filename.split('/')[2]); assert.ok(pid >= 5000 && pid < 5128); return pid; };
    t.mock.method(fs, 'stat', async filename => {
        const pid = pidOf(filename); inspected.add(pid); return { uid: pid === 5127 ? process.getuid() + 1 : process.getuid() };
    });
    t.mock.method(fs, 'readFile', async filename => {
        const pid = pidOf(filename); read.add(pid); assert.notEqual(pid, 5127, 'foreign uid proc content must not be read');
        if (filename.endsWith('/stat')) return procStat(pid, '1');
        if (pid === 5126) throw Error('/proc/' + pid + '/smaps_rollup secret permission error');
        return 'Rss: 1 kB\nPss: 1 kB\n';
    });
    const browserSession = new Session(async () => ({ processInfo: Array.from({ length: 129 }, (_, i) => ({ id: 5000 + i, type: 'renderer', cpuTime: 1 })) }));
    const probe = await start(browserPage(rendererSession(), browserSession), { engine: 'chromium', maxSamples: 1 });
    const report = await probe.stop(), sample = report.samples[0].processes;
    assert.equal(inspected.size, 128); assert.equal(read.size, 127);
    assert.equal(sample.listedCount, 128); assert.equal(sample.rssObservedCount, 126);
    assert.equal(sample.rssComplete, false); assert.equal(sample.pssComplete, false);
    assert.equal(sample.exitedProcessCount, undefined, 'truncated listing cannot prove a process exit');
    assert.equal(report.summary.processes.rssSumBytes.peak, 126 * 1024);
    assert.equal(report.processes.status, 'partial');
    assert.equal(report.processes.issues['process-uid-mismatch'], 1);
    assert.equal(report.processes.issues['process-memory-unavailable'], 1);
    assert.equal(JSON.stringify(report).includes('/proc/'), false);
});

test('page close detaches both owned CDP sessions and unsupported context browser does not invent process metrics', async () => {
    const renderer = rendererSession();
    const browserSession = new Session(async () => { throw Error('https://private.invalid/#room=hidden'); });
    const page = browserPage(renderer, browserSession);
    const probe = await start(page, { engine: 'chromium' });
    page.emit('close');
    const report = await probe.stop();
    assert.equal(renderer.detached, 1); assert.equal(browserSession.detached, 1);
    assert.equal(report.processes.status, 'unavailable');
    assert.equal(report.summary.processes, undefined);
    assert.equal(JSON.stringify(report).includes('private.invalid'), false);
    const unsupported = await start(pageFor(rendererSession()), { engine: 'chromium', maxSamples: 1 });
    const absent = await unsupported.stop();
    assert.equal(absent.processes.status, 'unsupported');
    assert.equal(absent.processes.reason, 'browser-context-unavailable');
    assert.equal(absent.summary.processes, undefined);
});

test('browser CDP arriving after attachment timeout is detached without adding a polling session', async () => {
    const renderer = rendererSession(), browserSession = new Session(async () => ({}));
    const page = new EventEmitter();
    page.context = () => ({ newCDPSession: async () => renderer, browser: () => ({
        newBrowserCDPSession: () => new Promise(resolve => setTimeout(() => resolve(browserSession), 180))
    }) });
    const probe = await start(page, { engine: 'chromium', commandTimeoutMs: 100, maxSamples: 1 });
    const report = await probe.stop();
    assert.equal(report.processes.status, 'unavailable');
    assert.equal(report.processes.issues['browser-attach-timeout'], 1);
    assert.equal(report.summary.processes, undefined);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(browserSession.detached, 1); assert.equal(renderer.detached, 1);
});

test('a proc read deadline aborts the read, emits no fabricated aggregate and still detaches both sessions', { skip: process.platform !== 'linux' }, async t => {
    let aborted = 0;
    t.mock.method(fs, 'stat', async () => ({ uid: process.getuid() }));
    t.mock.method(fs, 'readFile', async (filename, options) => {
        if (filename.endsWith('/stat')) return procStat(98765, '12');
        return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => { aborted++; reject(Error(filename + ' secret')); }, { once: true });
        });
    });
    const renderer = rendererSession(), browserSession = new Session(async () => ({ processInfo: [{ id: 98765, type: 'renderer', cpuTime: 2 }] }));
    const probe = await start(browserPage(renderer, browserSession), { engine: 'chromium', maxSamples: 1, commandTimeoutMs: 100 });
    const report = await probe.stop();
    assert.equal(aborted, 1);
    assert.equal(report.processes.status, 'unavailable');
    assert.equal(report.processes.issues['process-sampling-timeout'], 1);
    assert.equal(report.summary.processes, undefined);
    assert.equal(report.processes.coverage, undefined);
    assert.equal(renderer.detached, 1); assert.equal(browserSession.detached, 1);
    assert.equal(JSON.stringify(report).includes('98765'), false);
    assert.equal(JSON.stringify(report).includes('/proc/'), false);
});
