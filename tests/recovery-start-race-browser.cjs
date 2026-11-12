'use strict';
// Native Chromium OPFS across two pages/workers. A test-only gate delays one
// native getFileHandle call; every file, metadata commit and lock remains real.
// This is not a public-network, power-loss, storage-quota or Safari proof.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errorType = error => ['AssertionError','TimeoutError','TypeError','RangeError','SecurityError',
    'QuotaExceededError','NotAllowedError','NoModificationAllowedError','NotFoundError'].includes(error?.name) ? error.name : 'Error';
const bounded = (promise, ms = 10000) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        const error = Error('Native start race control timeout'); error.name = 'TimeoutError'; reject(error);
    }, ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
async function main() {
    const report = { schema: 1, engine: 'chromium', phase: 'startup', passed: false,
        scope: 'actual built recovery Worker and native OPFS same-ID start contention across two pages; test-only native-method timing gate, not mocked files, remote authorization, WAN or Safari evidence',
        cases: [], errors: [], checks: [] };
    let server, browser, context; const pages = [];
    const names = ['native-original-partial.bin','native-original-complete.bin','native-original-corrupt.bin','native-replacement.bin'];
    const hashes = [];
    try {
        await fs.mkdir('test-results', { recursive: true }); server = await startDev(0);
        report.network = { uploadAttempts: 0, externalAttempts: 0, signalingMessages: 0,
            signalingBytes: 0, fileDataObserved: false };
        const message = server.signaling.message.bind(server.signaling);
        server.signaling.message = (peer, raw) => {
            const text = String(raw); report.network.signalingMessages++;
            report.network.signalingBytes += Buffer.byteLength(text);
            if (names.some(name => text.includes(name)) || hashes.some(hash => text.includes(hash))) report.network.fileDataObserved = true;
            return message(peer, raw);
        };
        browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version();
        // One storage partition, two documents and two actual dedicated Workers.
        context = await browser.newContext({ serviceWorkers: 'block' });
        await context.route('**/*', route => {
            const request = route.request();
            if (new URL(request.url()).origin !== server.origin) { report.network.externalAttempts++; return route.abort(); }
            if (!['GET','HEAD'].includes(request.method()) || request.postDataBuffer()) {
                report.network.uploadAttempts++; return route.abort();
            }
            return route.continue();
        });
        for (let index = 0; index < 2; index++) {
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => { if (report.errors.length < 20) report.errors.push({ endpoint: index, type: errorType(error), phase: report.phase }); });
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript',
                body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.goto(server.origin);
            assert.equal(await page.evaluate(() => window.ZeydropRecovery.available()), true);
        }
        const [a, b] = pages;
        const workers = await Promise.all(pages.map(async page => {
            const found = page.workers().find(worker => new URL(worker.url()).pathname === '/scripts/recovery-worker.js');
            assert.ok(found, 'the actual native recovery Worker must be visible'); return found;
        }));
        assert.notEqual(workers[0], workers[1]);
        report.nativeWorkers = await Promise.all(pages.map(page => page.evaluate(() => ({
            actualDedicatedWorker: window.ZeydropRecovery.worker instanceof Worker,
            revision: document.querySelector('meta[name="build-revision"]').content
        }))));
        assert.ok(report.nativeWorkers.every(item => item.actualDedicatedWorker && /^[a-f0-9]{16}$/.test(item.revision)));
        assert.equal(report.nativeWorkers[0].revision, report.nativeWorkers[1].revision);

        for (const [index, phase] of ['partial','complete','corrupt'].entries()) {
            report.phase = 'same-id-' + phase;
            const id = crypto.randomUUID(), bytes = Buffer.alloc(16384, 0x5a + index), sha256 = digest(bytes);
            hashes.push(sha256);
            const meta = { id, name: names[index], size: phase === 'complete' ? bytes.length : bytes.length * 2,
                mime: 'application/octet-stream' };
            // Gate only B's target data-file creation, after start() has already
            // checked metadata/listing. The native bound method runs on release.
            await workers[1].evaluate(async id => {
                const dir = await folder();
                const fileDescriptor = Object.getOwnPropertyDescriptor(dir, 'getFileHandle');
                const removeDescriptor = Object.getOwnPropertyDescriptor(dir, 'removeEntry');
                const nativeFile = dir.getFileHandle.bind(dir), nativeRemove = dir.removeEntry.bind(dir);
                let entered, release;
                const enteredPromise = new Promise(resolve => { entered = resolve; });
                const releasePromise = new Promise(resolve => { release = resolve; });
                const state = { enteredPromise, gated: false, released: false, targetRemovals: 0,
                    release() { state.released = true; release(); },
                    restore() {
                        if (fileDescriptor) Object.defineProperty(dir, 'getFileHandle', fileDescriptor); else delete dir.getFileHandle;
                        if (removeDescriptor) Object.defineProperty(dir, 'removeEntry', removeDescriptor); else delete dir.removeEntry;
                    }
                };
                Object.defineProperty(dir, 'getFileHandle', { configurable: true, value: async (name, options) => {
                    if (!state.gated && name === id + '.part' && options?.create === true) {
                        state.gated = true; entered(true); await releasePromise;
                    }
                    return nativeFile(name, options);
                } });
                Object.defineProperty(dir, 'removeEntry', { configurable: true, value: async (name, options) => {
                    if ([id + '.part', id + '.json'].includes(name)) state.targetRemovals++;
                    return nativeRemove(name, options);
                } });
                globalThis.__startRaceControl = state;
            }, id);
            const delayedStart = b.evaluate(async meta => {
                try { window.__raceReplacementSink = await window.ZeydropRecovery.open(meta); return { resolved: true }; }
                catch (error) { return { resolved: false, errorName: ['QuotaExceededError','NotAllowedError','NoModificationAllowedError'].includes(error?.name) ? error.name : 'Error' }; }
            }, { ...meta, name: names[3] });
            // Always consume the delayed promise if an earlier assertion fails.
            delayedStart.catch(() => {});
            assert.equal(await bounded(workers[1].evaluate(() => globalThis.__startRaceControl.enteredPromise)), true);
            await a.evaluate(async ({ meta, value, sha256, phase }) => {
                const sink = await window.ZeydropRecovery.open(meta);
                await sink.write(new Uint8Array(16384).fill(value));
                if (phase === 'complete') await sink.finish(sha256);
                else await sink.park(sha256);
                if (phase === 'corrupt') {
                    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
                    const writer = await (await dir.getFileHandle(meta.id + '.json')).createWritable({ mode: 'exclusive' });
                    await writer.write('{synthetic-corrupt-header'); await writer.close();
                }
            }, { meta, value: 0x5a + index, sha256, phase });
            const inspect = page => page.evaluate(async id => {
                const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
                const header = await (await dir.getFileHandle(id + '.json')).getFile();
                const part = await (await dir.getFileHandle(id + '.part')).getFile();
                const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await part.arrayBuffer())))
                    .map(value => value.toString(16).padStart(2, '0')).join('');
                const raw = await header.text(); let metadata = null;
                try { const parsed = JSON.parse(raw); metadata = { offset: parsed.offset, phase: parsed.phase, sha256: parsed.prefixSha256 }; } catch {}
                return { raw, bytes: part.size, sha256, metadata };
            }, id);
            const before = await inspect(a);
            assert.equal(before.bytes, bytes.length); assert.equal(before.sha256, sha256);
            await workers[1].evaluate(() => globalThis.__startRaceControl.release());
            const second = await bounded(delayedStart), after = await inspect(a);
            const control = await workers[1].evaluate(() => ({ gated: globalThis.__startRaceControl.gated,
                released: globalThis.__startRaceControl.released, removals: globalThis.__startRaceControl.targetRemovals }));
            const observed = { phase, secondStartRejected: !second.resolved, beforeBytes: before.bytes, afterBytes: after.bytes,
                rawMetadataUnchanged: before.raw === after.raw, bodyUnchanged: before.sha256 === after.sha256,
                metadata: after.metadata, gateExecuted: control.gated && control.released, destructiveRemovals: control.removals };
            report.cases.push(observed);
            assert.equal(second.resolved, false, 'stale start must refuse a same-ID record published while its native file operation was pending');
            assert.equal(observed.rawMetadataUnchanged, true); assert.equal(observed.bodyUnchanged, true);
            assert.equal(after.bytes, bytes.length); assert.equal(control.removals, 0);
            // A same-worker lock probe immediately after rejection proves B
            // closed its own access handle; no navigation/termination/retry helps.
            observed.lock = await workers[0].evaluate(async id => {
                const file = await (await folder()).getFileHandle(id + '.part');
                const access = await file.createSyncAccessHandle();
                try { return { reacquired: true, bytes: access.getSize() }; } finally { access.close(); }
            }, id);
            assert.deepEqual(observed.lock, { reacquired: true, bytes: bytes.length });
            if (phase === 'partial') {
                observed.restore = await a.evaluate(async ({ id, meta, sha256 }) => {
                    const restored = await window.ZeydropRecovery.restore(id, meta);
                    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await restored.snapshot.arrayBuffer())))
                        .map(value => value.toString(16).padStart(2, '0')).join('');
                    await restored.sink.park(sha256); return { offset: restored.offset, bytes: restored.snapshot.size, sha256: actual };
                }, { id, meta, sha256 });
                assert.deepEqual(observed.restore, { offset: bytes.length, bytes: bytes.length, sha256 });
            } else if (phase === 'complete') {
                observed.completed = await a.evaluate(async id => {
                    const result = await window.ZeydropRecovery.completed(id);
                    return { bytes: result.blob.size, phase: result.meta.phase };
                }, id);
                assert.deepEqual(observed.completed, { bytes: bytes.length, phase: 'complete' });
            } else {
                const listing = await a.evaluate(() => window.ZeydropRecovery.list());
                assert.equal(listing.length, 1); assert.equal(listing[0].phase, 'invalid');
            }
            await workers[1].evaluate(() => globalThis.__startRaceControl.restore());
            await a.evaluate(id => window.ZeydropRecovery.erase(id), id);
            assert.equal((await a.evaluate(() => window.ZeydropRecovery.list())).length, 0);
        }
        report.checks.push('two actual same-origin dedicated Workers contend for one remote-chosen file ID using a native getFileHandle timing gate');
        report.checks.push('partial, completed and corrupt records published by another worker survive stale start without metadata replacement, body truncation or erase');
        report.checks.push('rejection closes the losing native data handle immediately; original partial restore, completed lookup and manual corrupt-record deletion remain available');
        assert.equal(report.network.uploadAttempts, 0); assert.equal(report.network.externalAttempts, 0);
        assert.equal(report.network.fileDataObserved, false); assert.deepEqual(report.errors, []);
        report.passed = true; report.phase = 'complete';
    } catch (error) {
        report.failure = errorType(error);
        if (/Executable doesn't exist/.test(String(error?.message))) report.failureCode = 'browser-executable-unavailable';
        else if (/Operation not permitted|\bEPERM\b/.test(String(error?.message))) report.failureCode = 'runtime-operation-denied';
        const line = String(error?.stack || '').match(/recovery-start-race-browser\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        throw error;
    } finally {
        try {
            await fs.mkdir('test-results', { recursive: true });
            await fs.writeFile('test-results/recovery-start-race-chromium.json', JSON.stringify(report, null, 2) + '\n');
        } finally { await Promise.allSettled([context?.close(), browser?.close(), server?.close()]); }
    }
    console.log('Native recovery start-race evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Recovery start-race browser test failed:', errorType(error)); process.exitCode = 1; });
