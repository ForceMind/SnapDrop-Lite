'use strict';
// Actual native stateful Workers from built assets. Synthetic local inputs and
// bounded RPC observations establish neither WAN behavior nor whole-browser RSS.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errorType = error => ['AssertionError','TimeoutError','TypeError','RangeError','SecurityError','NotAllowedError',
    'AbortError','HashBusyError','HashClosedError','HashWorkerError','HashReadError','HashProtocolError','HashTimeoutError']
    .includes(error?.name) ? error.name : 'Error';

async function main() {
    const name = process.env.BROWSER_TYPE || 'chromium', engine = { chromium, firefox, webkit }[name];
    if (!engine) throw TypeError('Unknown browser engine');
    const report = { schema: 1, engine: name,
        scope: 'built native incremental SHA Workers and bounded RPC copies; not total-memory, mobile hardware, Safari or WAN evidence',
        phase: 'startup', checks: [], errors: [], passed: false };
    const sentinel = 'ZEYDROP_STREAM_HASH_PRIVATE_SENTINEL.bin';
    const expected = { empty: digest(Buffer.alloc(0)), a: digest('a'), abc: digest('abc'),
        bounded: digest(Buffer.alloc(4 * 256 * 1024, 0x5a)), sentinel: digest(sentinel) };
    let server, browser, context, page, workerCount = 0;
    try {
        await fs.mkdir('test-results', { recursive: true });
        server = await startDev(0);
        browser = await engine.launch({ headless: true, ...(name === 'chromium' && process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version();
        context = await browser.newContext({ serviceWorkers: 'block' }); page = await context.newPage();
        page.on('worker', () => workerCount++);
        page.on('pageerror', error => { if (report.errors.length < 20) report.errors.push({ type: errorType(error), phase: report.phase }); });
        report.network = { httpRequests: 0, uploadAttempts: 0, externalAttempts: 0,
            signalingMessages: 0, signalingBytes: 0, fileDataObserved: false };
        const originalMessage = server.signaling.message.bind(server.signaling);
        server.signaling.message = (peer, raw) => {
            const message = String(raw);
            report.network.signalingMessages++; report.network.signalingBytes += Buffer.byteLength(message);
            if (message.includes(sentinel) || Object.values(expected).some(value => message.includes(value)))
                report.network.fileDataObserved = true;
            return originalMessage(peer, raw);
        };
        await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url()); report.network.httpRequests++;
            if (url.origin !== server.origin) { report.network.externalAttempts++; return route.abort(); }
            if (!['GET','HEAD'].includes(request.method()) || request.postDataBuffer()) {
                report.network.uploadAttempts++; return route.abort();
            }
            return route.continue();
        });
        await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript',
            body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
        await page.goto(server.origin);
        await page.waitForFunction(() => !!window.ZeydropStreamHash && !!window.ZeydropHash);
        report.capabilities = await page.evaluate(() => ({ worker: typeof Worker === 'function',
            chunkBytes: ZeydropStreamHasher.CHUNK_BYTES, maxHandles: ZeydropStreamHasher.MAX_HANDLES,
            maxPending: ZeydropStreamHasher.MAX_PENDING,
            versionQueryMatches: new URL(window.ZeydropStreamHash._url).search
                === new URL(document.querySelector('script[src*="stream-hash.js"]').src).search }));
        assert.equal(report.capabilities.worker, true); assert.equal(report.capabilities.versionQueryMatches, true);
        assert.equal(report.capabilities.chunkBytes, 256 * 1024);
        assert.equal(report.capabilities.maxHandles, 4); assert.equal(report.capabilities.maxPending, 4);

        report.phase = 'native-snapshot-continue-final';
        report.stateful = await page.evaluate(async sentinel => {
            const manager = window.ZeydropStreamHash, original = manager._factory; let factoryCalls = 0;
            manager._factory = () => { factoryCalls++; throw Error('main factory must not run'); };
            try {
                const empty = manager.create(), emptyDigest = await empty.digestHex({ final: true });
                const hash = manager.create(); await hash.update(new TextEncoder().encode('a'));
                const prefix = await hash.digestHex(), repeat = await hash.digestHex({ final: false });
                await hash.update(new TextEncoder().encode('bc'));
                const final = await hash.digestHex({ final: true });
                const afterFinal = await hash.update(new Uint8Array([1])).then(() => 'resolved', error => error.name);
                const privateHash = manager.create(); await privateHash.update(new TextEncoder().encode(sentinel));
                const privateDigest = await privateHash.digestHex({ final: true });
                return { emptyDigest, prefix, repeat, final, afterFinal, privateDigest, bytes: hash.bytes,
                    backend: hash.backend, finalClosed: hash.closed, emptyClosed: empty.closed,
                    remaining: manager._handles.size, factoryCalls };
            } finally { manager.disposeAll(); manager._factory = original; }
        }, sentinel);
        assert.equal(report.stateful.emptyDigest, expected.empty); assert.equal(report.stateful.prefix, expected.a);
        assert.equal(report.stateful.repeat, expected.a); assert.equal(report.stateful.final, expected.abc);
        assert.equal(report.stateful.privateDigest, expected.sentinel); assert.equal(report.stateful.bytes, 3);
        assert.equal(report.stateful.afterFinal, 'HashClosedError'); assert.equal(report.stateful.backend, 'worker');
        assert.equal(report.stateful.finalClosed, true); assert.equal(report.stateful.emptyClosed, true);
        assert.equal(report.stateful.remaining, 0); assert.equal(report.stateful.factoryCalls, 0);
        report.checks.push('native Worker snapshots leave SHA state usable, continuation/final match independent Node SHA, and final releases the handle');

        report.phase = 'immutable-input-and-bounds';
        report.bounds = await page.evaluate(async () => {
            const messages = [];
            class ObservedWorker extends Worker {
                postMessage(message, transfer) {
                    messages.push({ type: message.type, keys: Object.keys(message).sort(), bytes: message.chunk?.byteLength || 0 });
                    super.postMessage(message, transfer);
                }
            }
            let factoryCalls = 0;
            const manager = new ZeydropStreamHasher({ Worker: ObservedWorker,
                hashFactory: () => { factoryCalls++; throw Error('no main fallback'); } });
            try {
                const hash = manager.create(), padded = new Uint8Array([9, 9, 97, 98, 99, 9]);
                const view = new DataView(padded.buffer, 2, 3), pending = hash.update(view);
                padded.fill(0); // update must copy synchronously before any await/transfer.
                await pending;
                const isolated = await hash.digestHex({ final: true });
                const bounded = manager.create(), chunk = new Uint8Array(256 * 1024).fill(0x5a);
                const jobs = Array.from({ length: 4 }, () => bounded.update(chunk));
                const overQueue = await bounded.update(chunk).then(() => 'resolved', error => error.name);
                await Promise.all(jobs);
                const oversized = await bounded.update(new Uint8Array(256 * 1024 + 1)).then(() => 'resolved', error => error.name);
                const lookalike = await bounded.update({ buffer: chunk.buffer, byteLength: chunk.length }).then(() => 'resolved', error => error.name);
                const final = await bounded.digestHex({ final: true });
                const allowed = { init: ['request','session','type'], update: ['chunk','offset','request','session','type'],
                    digest: ['final','offset','request','session','type'] };
                return { isolated, callerBufferBytes: padded.buffer.byteLength, callerBytesRemainMutated: padded.every(value => value === 0),
                    final, bytes: bounded.bytes, overQueue, oversized, lookalike, factoryCalls,
                    maximumRpcChunk: Math.max(...messages.map(item => item.bytes)),
                    rpcEnvelopeOnly: messages.every(item => JSON.stringify(item.keys) === JSON.stringify(allowed[item.type])),
                    updates: messages.filter(item => item.type === 'update').length, remaining: manager._handles.size };
            } finally { manager.disposeAll(); }
        });
        assert.equal(report.bounds.isolated, expected.abc); assert.equal(report.bounds.callerBufferBytes, 6);
        assert.equal(report.bounds.callerBytesRemainMutated, true); assert.equal(report.bounds.final, expected.bounded);
        assert.equal(report.bounds.bytes, 4 * 256 * 1024); assert.equal(report.bounds.overQueue, 'HashBusyError');
        assert.equal(report.bounds.oversized, 'RangeError'); assert.equal(report.bounds.lookalike, 'TypeError');
        assert.equal(report.bounds.maximumRpcChunk, 256 * 1024); assert.equal(report.bounds.updates, 5);
        assert.equal(report.bounds.rpcEnvelopeOnly, true); assert.equal(report.bounds.factoryCalls, 0);
        assert.equal(report.bounds.remaining, 0);
        report.checks.push('native Worker receives only owned copies of exact view ranges; original buffers stay attached, RPC chunks stay <=256 KiB and pending work is capped');

        report.phase = 'capacity-and-isolated-cancel';
        report.cancellation = await page.evaluate(async () => {
            const manager = new ZeydropStreamHasher();
            try {
                const handles = Array.from({ length: 4 }, () => manager.create()); let overHandles;
                try { manager.create(); overHandles = 'created'; } catch (error) { overHandles = error.name; }
                for (const handle of handles) handle.dispose();
                const survivor = manager.create(); await survivor.update(new TextEncoder().encode('a'));
                const victim = manager.create();
                const update = victim.update(new Uint8Array(256 * 1024)).then(() => 'resolved', error => error.name);
                const snapshot = victim.digestHex().then(() => 'resolved', error => error.name);
                await Promise.resolve(); // Native Worker init is posted, with its reply still on the task queue.
                const nativeWorkerStarted = victim._worker instanceof Worker;
                victim.dispose(); victim.dispose();
                const outcomes = await Promise.all([update, snapshot]);
                await survivor.update(new TextEncoder().encode('bc'));
                const final = await survivor.digestHex({ final: true });
                const fresh = manager.create(), freshDigest = await fresh.digestHex({ final: true });
                return { overHandles, nativeWorkerStarted, outcomes, final, freshDigest,
                    victimClosed: victim.closed, remaining: manager._handles.size };
            } finally { manager.disposeAll(); }
        });
        assert.equal(report.cancellation.overHandles, 'HashBusyError'); assert.equal(report.cancellation.nativeWorkerStarted, true);
        assert.deepEqual(report.cancellation.outcomes, ['AbortError','AbortError']);
        assert.equal(report.cancellation.final, expected.abc); assert.equal(report.cancellation.freshDigest, expected.empty);
        assert.equal(report.cancellation.victimClosed, true); assert.equal(report.cancellation.remaining, 0);
        report.checks.push('four-handle cap holds; disposing one native Worker rejects its pending operations without interrupting another stateful Worker or future sessions');

        for (const mode of ['crash','timeout']) {
            report.phase = 'native-worker-' + mode;
            await page.route('**/stream-hash-worker.js?synthetic-' + mode + '=1', route => route.fulfill({
                contentType: 'text/javascript', body: mode === 'crash'
                    ? 'self.onmessage=()=>{throw new Error("SyntheticStreamHashWorkerFailure");};'
                    : 'self.onmessage=()=>{};' }));
            report[mode] = await page.evaluate(async mode => {
                let factoryCalls = 0;
                const manager = new ZeydropStreamHasher({
                    workerUrl: new URL('/scripts/stream-hash-worker.js?synthetic-' + mode + '=1', location.origin).href,
                    timeoutMs: mode === 'timeout' ? 50 : 30000,
                    hashFactory: () => { factoryCalls++; throw Error('must not fallback'); } });
                const hash = manager.create();
                try { await hash.update(new Uint8Array([97])); return { resolved: true, factoryCalls }; }
                catch (error) { return { resolved: false, errorName: error.name, factoryCalls,
                    closed: hash.closed, workerReleased: hash._worker === null, remaining: manager._handles.size }; }
                finally { manager.disposeAll(); }
            }, mode);
            assert.equal(report[mode].resolved, false);
            assert.equal(report[mode].errorName, mode === 'crash' ? 'HashWorkerError' : 'HashTimeoutError');
            assert.equal(report[mode].factoryCalls, 0); assert.equal(report[mode].closed, true);
            assert.equal(report[mode].workerReleased, true); assert.equal(report[mode].remaining, 0);
        }
        report.checks.push('native Worker runtime failure and stalled RPC both reject and release resources without silently recomputing on the main thread');

        report.phase = 'cleanup-and-network-check';
        await page.evaluate(() => window.ZeydropStreamHash.disposeAll());
        await page.waitForTimeout(100); // Surface late native errors before the final assertion.
        assert.ok(workerCount >= 6, 'actual native Workers must be observed');
        assert.equal(report.network.uploadAttempts, 0); assert.equal(report.network.externalAttempts, 0);
        assert.equal(report.network.fileDataObserved, false); assert.deepEqual(report.errors, []);
        report.nativeWorkersCreated = workerCount; report.phase = 'complete'; report.passed = true;
    } catch (error) {
        report.failure = errorType(error);
        // Keep an actionable, fixed diagnostic without retaining browser paths,
        // arbitrary Worker text, local names or command lines in the report.
        if (/Executable doesn't exist/.test(String(error?.message))) report.failureCode = 'browser-executable-unavailable';
        else if (/Operation not permitted|\bEPERM\b/.test(String(error?.message))) report.failureCode = 'runtime-operation-denied';
        const line = String(error?.stack || '').match(/stream-hash-browser\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        throw error;
    } finally {
        try {
            await fs.mkdir('test-results', { recursive: true });
            await fs.writeFile('test-results/stream-hash-' + name + '.json', JSON.stringify(report, null, 2) + '\n');
        } finally {
            if (page) await page.evaluate(() => window.ZeydropStreamHash?.disposeAll()).catch(() => {});
            await Promise.allSettled([context?.close(), browser?.close(), server?.close()]);
        }
    }
    console.log('Stream-hash browser evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Stream-hash browser test failed:', errorType(error)); process.exitCode = 1; });
