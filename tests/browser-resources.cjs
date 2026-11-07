'use strict';

// Test-only CDP observations. Fields were checked against the installed
// playwright-core/types/protocol.d.ts, Runtime.getHeapUsage and Performance.
// Usage: const probe = await start(page, { engine: 'chromium' });
//        ...actual transfer assertions...; const report = await probe.stop();
// Always stop in finally. A failed observation never changes transfer verdicts.
const { performance } = require('node:perf_hooks');

const HEAP_FIELDS = ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'];
const PERFORMANCE_FIELDS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
const LIMITATIONS = [
    'Samples observe the target Chromium page/isolate and renderer duration counters, not browser total RSS, workers, GPU or every process.',
    'Runtime backingStorageSize includes ArrayBuffer backing storage AND external strings; it is not an ArrayBuffer-only measurement.',
    'Renderer TaskDuration is not whole-process CPU usage, a CPU percentage or a hardware power measurement.',
    'Peaks are observed sampled values, not a memory hard limit or proof that no larger transient allocation occurred.',
    'The observation window includes test workflow and measurement overhead; it is not a WAN throughput benchmark.',
    'Unsupported, missing or failed fields are omitted, never replaced with zero; metrics do not override file-integrity or direct-path assertions.'
];

function boundedInteger(value, fallback, minimum, maximum) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

// Do not keep protocol error messages: they may include target URLs, paths or
// session details. Late resolutions/rejections remain handled after a timeout.
function boundedCall(operation, milliseconds) {
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true; clearTimeout(timer); resolve(result);
        };
        const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), milliseconds);
        Promise.resolve().then(operation).then(
            value => finish({ ok: true, value }),
            () => finish({ ok: false, code: 'command-failed' })
        );
    });
}

async function start(page, options = {}) {
    const engine = ['chromium', 'firefox', 'webkit'].includes(options.engine) ? options.engine : 'unknown';
    const intervalMs = boundedInteger(options.intervalMs, 1000, 250, 10000);
    const maxSamples = boundedInteger(options.maxSamples, 180, 1, 600);
    const commandTimeoutMs = boundedInteger(options.commandTimeoutMs, 1500, 100, 5000);
    const started = performance.now(), samples = [], issues = {}, availableFields = new Set();
    let session, timer, inFlight, stopped = false, closed = false, enabled = false, attempts = 0;
    let limitReached = false, cleanupPromise, reportPromise;
    const note = code => { issues[code] = (issues[code] || 0) + 1; };
    const onClose = () => { closed = true; note('session-closed'); clearTimeout(timer); };
    const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
            clearTimeout(timer);
            if (!session) return;
            if (!closed && enabled) await boundedCall(() => session.send('Performance.disable'), commandTimeoutMs);
            session.off?.('close', onClose);
            if (!closed) await boundedCall(() => session.detach(), commandTimeoutMs);
        })().catch(() => { note('cleanup-failed'); });
        return cleanupPromise;
    };
    const sample = async () => {
        if (closed || !session || attempts >= maxSamples) return;
        attempts++;
        const [heapResult, metricsResult] = await Promise.all([
            boundedCall(() => session.send('Runtime.getHeapUsage'), commandTimeoutMs),
            enabled ? boundedCall(() => session.send('Performance.getMetrics'), commandTimeoutMs)
                : Promise.resolve(null)
        ]);
        const entry = { atMs: Math.round(performance.now() - started) };
        if (heapResult.ok) {
            const heap = {};
            for (const key of HEAP_FIELDS) {
                const value = heapResult.value?.[key];
                if (Number.isSafeInteger(value) && value >= 0) { heap[key] = value; availableFields.add('heap.' + key); }
            }
            if (Object.keys(heap).length) entry.heap = heap;
            else note('heap-fields-unavailable');
        } else note('heap-' + heapResult.code);
        if (metricsResult?.ok) {
            const metrics = {};
            // A fixed field allowlist also excludes URLs, arbitrary names and
            // raw protocol objects. Cap the input walk as well as output size.
            for (const metric of (Array.isArray(metricsResult.value?.metrics) ? metricsResult.value.metrics : []).slice(0, 256)) {
                if (PERFORMANCE_FIELDS.includes(metric?.name) && Number.isFinite(metric.value) && metric.value >= 0) {
                    metrics[metric.name] = metric.value; availableFields.add('performance.' + metric.name);
                }
            }
            if (Object.keys(metrics).length) entry.performance = metrics;
            else note('performance-fields-unavailable');
        } else if (metricsResult) note('performance-' + metricsResult.code);
        if (entry.heap || entry.performance) samples.push(entry);
        if (attempts >= maxSamples) { limitReached = true; await cleanup(); }
    };
    const schedule = () => {
        if (stopped || closed || limitReached) return;
        timer = setTimeout(() => {
            inFlight = sample().catch(() => note('sample-failed')).finally(() => { inFlight = null; schedule(); });
        }, intervalMs);
        timer.unref?.();
    };
    const summarize = () => {
        const summary = {};
        for (const group of ['heap', 'performance']) {
            const fields = group === 'heap' ? HEAP_FIELDS : PERFORMANCE_FIELDS;
            const values = {};
            for (const field of fields) {
                const present = samples.flatMap(item => item[group]?.[field] === undefined ? [] : [item[group][field]]);
                if (!present.length) continue;
                const metric = { first: present[0], peak: Math.max(...present), last: present.at(-1) };
                if (group === 'performance') {
                    const reset = present.some((value, index) => index > 0 && value < present[index - 1]);
                    metric.counterResetObserved = reset;
                    metric.delta = reset || present.length < 2 ? null : metric.last - metric.first;
                }
                values[field] = metric;
            }
            if (Object.keys(values).length) summary[group] = values;
        }
        return summary;
    };
    const controller = { stop() {
        if (reportPromise) return reportPromise;
        stopped = true; clearTimeout(timer);
        reportPromise = (async () => {
            await inFlight;
            // Preserve the periodic frequency bound; a stop right after a sample
            // does not cause an extra back-to-back collection.
            if (!closed && !limitReached && session && performance.now() - started - (samples.at(-1)?.atMs || 0) >= intervalMs) {
                await sample().catch(() => note('sample-failed'));
            }
            await cleanup();
            return {
                schema: 1, engine,
                status: engine !== 'chromium' ? 'unsupported' : samples.length ? (Object.keys(issues).length ? 'partial' : 'sampled') : 'unavailable',
                supported: !!session,
                scope: 'test-only Chromium target CDP observations; same-host workflow, not total browser RSS or WAN measurement',
                sampling: { intervalMs, maxSamples, commandTimeoutMs, attempts, count: samples.length, limitReached,
                    elapsedMs: Math.round(performance.now() - started) },
                availableFields: [...availableFields].sort(), issues: { ...issues }, summary: summarize(), samples,
                limitations: [...LIMITATIONS]
            };
        })();
        return reportPromise;
    } };

    if (engine !== 'chromium') { note('cdp-unsupported-engine'); return controller; }
    let attachTimedOut = false;
    const attached = await boundedCall(async () => {
        const attachedSession = await page.context().newCDPSession(page);
        // CDP attachment itself cannot be cancelled. Detach any session created
        // after our deadline rather than retaining an unowned late connection.
        if (attachTimedOut) await boundedCall(() => attachedSession.detach(), commandTimeoutMs);
        return attachedSession;
    }, commandTimeoutMs);
    if (!attached.ok) { attachTimedOut = true; note('attach-' + attached.code); return controller; }
    session = attached.value;
    try { session.on('close', onClose); } catch { note('session-listener-failed'); await cleanup(); return controller; }
    const enable = await boundedCall(() => session.send('Performance.enable', { timeDomain: 'timeTicks' }), commandTimeoutMs);
    enabled = enable.ok;
    if (!enabled) note('performance-enable-' + enable.code);
    await sample().catch(() => note('sample-failed'));
    schedule();
    return controller;
}

module.exports = { start };
