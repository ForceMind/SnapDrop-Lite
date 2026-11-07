'use strict';

// Test-only CDP observations. Fields were checked against the installed
// playwright-core/types/protocol.d.ts, Runtime.getHeapUsage and Performance.
// Usage: const probe = await start(page, { engine: 'chromium' });
//        ...actual transfer assertions...; const report = await probe.stop();
// Always stop in finally. A failed observation never changes transfer verdicts.
const { performance } = require('node:perf_hooks');
const fs = require('node:fs/promises');

const HEAP_FIELDS = ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'];
const PERFORMANCE_FIELDS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
const PROCESS_FIELDS = ['rssSumBytes', 'pssSumBytes', 'cpuObservedCumulativeSeconds'];
const LIMITATIONS = [
    'Heap and renderer duration samples retain their target-page/isolate scope; the separate process observations cover only processes reported by that owning browser CDP endpoint.',
    'Runtime backingStorageSize includes ArrayBuffer backing storage AND external strings; it is not an ArrayBuffer-only measurement.',
    'Renderer TaskDuration is not whole-process CPU usage, a CPU percentage or a hardware power measurement.',
    'Process RSS sums double-count shared resident pages; PSS sums apportion shared pages and are not machine-wide memory usage or an exclusive physical-memory total.',
    'Browser-process CPU is the observed sum of same-PID/starttime counter differences across all threads; new, exited, unreadable, reused or reset processes leave gaps, and processes that appear and exit between samples are unobserved. It is not whole-machine CPU.',
    'Process measurements may include other pages of the same browser. Sender/receiver reports for a shared browser overlap and must not be added as independent device totals.',
    'Linux proc measurements require the tested browser and test runner to share the local PID namespace; these readings are not remote-browser process evidence.',
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
        let settled = false; const abort = new AbortController();
        const finish = result => {
            if (settled) return;
            settled = true; clearTimeout(timer); resolve(result);
        };
        const timer = setTimeout(() => { abort.abort(); finish({ ok: false, code: 'timeout' }); }, milliseconds);
        Promise.resolve().then(() => operation(abort.signal)).then(
            value => finish({ ok: true, value }),
            () => finish({ ok: false, code: 'command-failed' })
        );
    });
}

function processType(value) {
    const name = typeof value === 'string' ? value.toLowerCase() : '';
    if (['browser', 'renderer', 'utility', 'zygote', 'broker', 'sandbox-helper'].includes(name)) return name;
    return ['gpu', 'gpu-process'].includes(name) ? 'gpu' : 'other';
}

function startIdentity(text, pid) {
    // stat's comm may contain whitespace and ')'. Only the numeric starttime
    // survives this parser, and neither comm nor PID is ever returned to callers.
    if (typeof text !== 'string' || text.length > 65536 || !text.startsWith(pid + ' (')) return null;
    const close = text.lastIndexOf(')');
    const start = text.slice(close + 1).trim().split(/\s+/)[19];
    return close >= 0 && /^\d+$/.test(start || '') ? start : null;
}

function memoryRollup(text) {
    const memory = {};
    if (typeof text !== 'string' || text.length > 65536) return memory;
    for (const [label, key] of [['Rss', 'rssSumBytes'], ['Pss', 'pssSumBytes']]) {
        const match = text.match(new RegExp('^' + label + ':\\s+(\\d+)\\s+kB\\s*$', 'm'));
        if (match && Number.isSafeInteger(Number(match[1]) * 1024)) memory[key] = Number(match[1]) * 1024;
    }
    return memory;
}

function processSampler(note) {
    let previous = new Map(), hasBaseline = false, disposed = false, cumulativeCPU;
    return {
        dispose() { disposed = true; previous.clear(); },
        async collect(session, signal) {
            const response = await session.send('SystemInfo.getProcessInfo');
            if (signal.aborted || disposed) return null;
            if (!Array.isArray(response?.processInfo) || !response.processInfo.length) {
                note('process-list-unavailable'); previous.clear(); hasBaseline = false; return null;
            }
            const candidates = [], seen = new Set();
            let invalidCount = 0, truncated = response.processInfo.length > 128;
            // Only this browser's CDP-reported PIDs are inspected. No /proc
            // enumeration, subprocess, sudo, environment or command-line reads.
            for (const item of response.processInfo.slice(0, 256)) {
                if (!Number.isSafeInteger(item?.id) || item.id < 1 || item.id > 2147483647 || seen.has(item.id)) { invalidCount++; continue; }
                if (candidates.length === 128) { truncated = true; break; }
                seen.add(item.id);
                candidates.push({ pid: item.id, type: processType(item.type),
                    cpu: Number.isFinite(item.cpuTime) && item.cpuTime >= 0 && item.cpuTime <= Number.MAX_SAFE_INTEGER ? item.cpuTime : undefined });
            }
            if (invalidCount) note('process-list-invalid');
            if (truncated) note('process-list-truncated');
            const uid = process.getuid();
            const observed = [];
            // Bounded concurrency prevents 128 processes from opening hundreds
            // of proc files at once. A deadline aborts pending readFile calls.
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
                while (!signal.aborted && !disposed && next < candidates.length) {
                    const item = candidates[next++], base = '/proc/' + item.pid;
                    try {
                        const owner = await fs.stat(base);
                        if (owner.uid !== uid) { note('process-uid-mismatch'); continue; }
                        const first = startIdentity(await fs.readFile(base + '/stat', { encoding: 'utf8', signal }), item.pid);
                        if (!first) { note('process-identity-unavailable'); continue; }
                        let memory = {};
                        try { memory = memoryRollup(await fs.readFile(base + '/smaps_rollup', { encoding: 'utf8', signal })); }
                        catch { if (!signal.aborted) note('process-memory-unavailable'); }
                        const last = startIdentity(await fs.readFile(base + '/stat', { encoding: 'utf8', signal }), item.pid);
                        if (first !== last) { note('process-identity-changed'); continue; }
                        if (!signal.aborted && !disposed) observed.push({ ...item, start: first, memory });
                    } catch { if (!signal.aborted) note('process-read-unavailable'); }
                }
            }));
            if (signal.aborted || disposed) return null;
            const current = new Map(), types = {}, totals = {};
            let comparable = 0, newCount = 0, reusedCount = 0, resetCount = 0, cpuDelta = 0;
            const counts = { rss: 0, pss: 0 };
            for (const item of observed) {
                current.set(item.pid, { start: item.start, cpu: item.cpu });
                types[item.type] = (types[item.type] || 0) + 1;
                for (const [field, count] of [['rssSumBytes', 'rss'], ['pssSumBytes', 'pss']]) {
                    if (item.memory[field] !== undefined) { totals[field] = (totals[field] || 0) + item.memory[field]; counts[count]++; }
                }
                const prior = previous.get(item.pid);
                if (!prior) newCount++;
                else if (prior.start !== item.start) reusedCount++;
                else if (prior.cpu !== undefined && item.cpu !== undefined) {
                    if (item.cpu < prior.cpu) resetCount++;
                    else { comparable++; cpuDelta += item.cpu - prior.cpu; }
                }
            }
            // A capped listing cannot establish whether an omitted PID exited.
            const exitedCount = truncated ? undefined : [...previous.keys()].filter(pid => !seen.has(pid)).length;
            if (comparable) cumulativeCPU = (cumulativeCPU || 0) + cpuDelta;
            if (cumulativeCPU !== undefined) totals.cpuObservedCumulativeSeconds = cumulativeCPU;
            for (const field of ['rssSumBytes', 'pssSumBytes']) if (totals[field] !== undefined && !Number.isSafeInteger(totals[field])) {
                delete totals[field]; note('process-memory-total-invalid');
            }
            const completeList = !truncated && !invalidCount && candidates.length > 0 && observed.length === candidates.length;
            const result = { ...totals, reportedCount: response.processInfo.length, listedCount: candidates.length,
                observedCount: observed.length, rssObservedCount: counts.rss, pssObservedCount: counts.pss, types,
                rssComplete: completeList && counts.rss === candidates.length && totals.rssSumBytes !== undefined,
                pssComplete: completeList && counts.pss === candidates.length && totals.pssSumBytes !== undefined,
                cpuBaseline: !hasBaseline, cpuComparableCount: comparable,
                cpuIntervalComplete: hasBaseline && completeList && comparable === candidates.length && !exitedCount && !newCount && !reusedCount && !resetCount,
                newProcessCount: newCount, ...(exitedCount === undefined ? {} : { exitedProcessCount: exitedCount }), reusedProcessCount: reusedCount,
                cpuCounterResetCount: resetCount, truncated };
            previous = current; hasBaseline = true;
            return result;
        }
    };
}

async function start(page, options = {}) {
    const engine = ['chromium', 'firefox', 'webkit'].includes(options.engine) ? options.engine : 'unknown';
    const intervalMs = boundedInteger(options.intervalMs, 1000, 250, 10000);
    const maxSamples = boundedInteger(options.maxSamples, 180, 1, 600);
    const commandTimeoutMs = boundedInteger(options.commandTimeoutMs, 1500, 100, 5000);
    const started = performance.now(), samples = [], issues = {}, processIssues = {}, availableFields = new Set();
    let session, timer, inFlight, stopped = false, closed = false, sessionClosed = false, enabled = false, attempts = 0;
    let browserSession, browserClosed = false, processUnsupported = 'browser-context-unavailable';
    let processSampleCount = 0, partialProcessCoverage = false;
    let limitReached = false, cleanupPromise, reportPromise;
    const note = code => { issues[code] = (issues[code] || 0) + 1; };
    const noteProcess = code => { processIssues[code] = (processIssues[code] || 0) + 1; };
    const proc = processSampler(noteProcess);
    const onClose = () => { closed = true; sessionClosed = true; note('session-closed'); clearTimeout(timer); void cleanup(); };
    const onPageClose = () => { closed = true; note('page-closed'); clearTimeout(timer); void cleanup(); };
    const onBrowserClose = () => { browserClosed = true; noteProcess('browser-session-closed'); };
    const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
            clearTimeout(timer); proc.dispose();
            try { page.off?.('close', onPageClose); } catch { note('cleanup-listener-failed'); }
            await Promise.all([
                (async () => {
                    if (!session) return;
                    if (!closed && enabled) await boundedCall(() => session.send('Performance.disable'), commandTimeoutMs);
                    try { session.off?.('close', onClose); } catch { note('cleanup-listener-failed'); }
                    if (!sessionClosed) await boundedCall(() => session.detach(), commandTimeoutMs);
                })(),
                (async () => {
                    if (!browserSession) return;
                    try { browserSession.off?.('close', onBrowserClose); } catch { noteProcess('cleanup-listener-failed'); }
                    if (!browserClosed) await boundedCall(() => browserSession.detach(), commandTimeoutMs);
                })()
            ]);
        })().catch(() => { note('cleanup-failed'); });
        return cleanupPromise;
    };
    const sample = async () => {
        if (closed || !session || attempts >= maxSamples) return;
        attempts++;
        const [heapResult, metricsResult, processResult] = await Promise.all([
            boundedCall(() => session.send('Runtime.getHeapUsage'), commandTimeoutMs),
            enabled ? boundedCall(() => session.send('Performance.getMetrics'), commandTimeoutMs)
                : Promise.resolve(null),
            browserSession && !browserClosed ? boundedCall(signal => proc.collect(browserSession, signal), commandTimeoutMs)
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
        if (processResult?.ok && processResult.value) {
            entry.processes = processResult.value; processSampleCount++;
            if (!entry.processes.rssComplete || !entry.processes.pssComplete
                || (!entry.processes.cpuBaseline && !entry.processes.cpuIntervalComplete)) partialProcessCoverage = true;
            for (const field of PROCESS_FIELDS) if (entry.processes[field] !== undefined) availableFields.add('processes.' + field);
        } else if (processResult && !processResult.ok) noteProcess('process-sampling-' + processResult.code);
        if (entry.heap || entry.performance || entry.processes) samples.push(entry);
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
        for (const group of ['heap', 'performance', 'processes']) {
            const fields = group === 'heap' ? HEAP_FIELDS : group === 'performance' ? PERFORMANCE_FIELDS : PROCESS_FIELDS;
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
    const processCoverage = () => {
        const present = samples.flatMap(item => item.processes ? [item.processes] : []);
        if (!present.length) return undefined;
        const typesPeak = {};
        for (const item of present) for (const [type, count] of Object.entries(item.types)) typesPeak[type] = Math.max(typesPeak[type] || 0, count);
        return {
            maxReportedCount: Math.max(...present.map(item => item.reportedCount)),
            maxListedCount: Math.max(...present.map(item => item.listedCount)),
            maxObservedCount: Math.max(...present.map(item => item.observedCount)),
            rssCompleteSamples: present.filter(item => item.rssComplete).length,
            pssCompleteSamples: present.filter(item => item.pssComplete).length,
            cpuComparableSamples: present.filter(item => item.cpuComparableCount > 0).length,
            cpuCompleteIntervals: present.filter(item => item.cpuIntervalComplete).length,
            truncatedSamples: present.filter(item => item.truncated).length,
            typesPeak
        };
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
                schema: 2, engine,
                status: engine !== 'chromium' ? 'unsupported' : samples.length ? (Object.keys(issues).length ? 'partial' : 'sampled') : 'unavailable',
                supported: !!session,
                scope: 'test-only Chromium target and owning-browser observations; same-host workflow, not machine totals or WAN measurement',
                sampling: { intervalMs, maxSamples, commandTimeoutMs, attempts, count: samples.length, limitReached,
                    elapsedMs: Math.round(performance.now() - started) },
                availableFields: [...availableFields].sort(), issues: { ...issues }, summary: summarize(), samples,
                processes: {
                    status: processUnsupported ? 'unsupported' : processSampleCount ? (partialProcessCoverage || Object.keys(processIssues).length ? 'partial' : 'sampled') : 'unavailable',
                    supported: !!browserSession, ...(processUnsupported ? { reason: processUnsupported } : {}),
                    source: 'owning browser CDP SystemInfo.getProcessInfo; same-uid Linux proc stat identity and smaps_rollup',
                    maxListedPids: 128, sampleCount: processSampleCount, partialCoverageObserved: partialProcessCoverage,
                    issues: { ...processIssues }, ...(processSampleCount ? { coverage: processCoverage() } : {})
                },
                limitations: [...LIMITATIONS]
            };
        })();
        return reportPromise;
    } };

    if (engine !== 'chromium') { processUnsupported = 'cdp-unsupported-engine'; note('cdp-unsupported-engine'); return controller; }
    let attachTimedOut = false;
    const attached = await boundedCall(async () => {
        const attachedSession = await page.context().newCDPSession(page);
        // CDP attachment itself cannot be cancelled. Detach any session created
        // after our deadline rather than retaining an unowned late connection.
        if (attachTimedOut) await boundedCall(() => attachedSession.detach(), commandTimeoutMs);
        return attachedSession;
    }, commandTimeoutMs);
    if (!attached.ok) { attachTimedOut = true; processUnsupported = 'target-cdp-unavailable'; note('attach-' + attached.code); return controller; }
    session = attached.value;
    try { session.on('close', onClose); } catch { note('session-listener-failed'); await cleanup(); return controller; }
    page.on?.('close', onPageClose);
    const enable = await boundedCall(() => session.send('Performance.enable', { timeDomain: 'timeTicks' }), commandTimeoutMs);
    enabled = enable.ok;
    if (!enabled) note('performance-enable-' + enable.code);
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') processUnsupported = 'linux-proc-unavailable';
    else if (!closed) {
        let browser;
        try { browser = page.context().browser?.(); } catch { noteProcess('browser-context-failed'); }
        if (typeof browser?.newBrowserCDPSession === 'function') {
            processUnsupported = null;
            let browserAttachLate = false;
            const attachedBrowser = await boundedCall(async () => {
                const candidate = await browser.newBrowserCDPSession();
                if (browserAttachLate || closed || stopped) await boundedCall(() => candidate.detach(), commandTimeoutMs);
                return candidate;
            }, commandTimeoutMs);
            if (!attachedBrowser.ok) { browserAttachLate = true; noteProcess('browser-attach-' + attachedBrowser.code); }
            else if (!closed && !stopped) {
                browserSession = attachedBrowser.value;
                try { browserSession.on('close', onBrowserClose); } catch { noteProcess('browser-session-listener-failed'); }
            }
        }
    }
    await sample().catch(() => note('sample-failed'));
    schedule();
    return controller;
}

module.exports = { start };
