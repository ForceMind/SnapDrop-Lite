'use strict';
// Real built Worker / native OPFS. Test-only method gates and a clock advance
// trigger stale listing without waiting 24h; not a hardware/WAN/aging proof.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), crypto = require('node:crypto');
const { chromium } = require('playwright'), { startDev } = require('../scripts/dev.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errorType = error => ['AssertionError','TimeoutError','TypeError','SecurityError','QuotaExceededError',
    'NotAllowedError','NoModificationAllowedError','NotFoundError'].includes(error?.name) ? error.name : 'Error';
const bounded = (promise, ms = 10000) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => {
        const error = Error('Native retirement control timeout'); error.name = 'TimeoutError'; reject(error);
    }, ms); })]).finally(() => clearTimeout(timer));
};
async function main() {
    const report = { schema: 1, engine: 'chromium', phase: 'startup', passed: false, cases: [], errors: [],
        scope: 'actual built Worker, two same-origin documents and native OPFS files/locks; test-only method timing gates and initial stale-list clock advance, not real 24h aging, disk faults, WAN or Safari evidence' };
    let server, browser, context;
    try {
        await fs.mkdir('test-results', { recursive: true }); server = await startDev(0);
        report.network = { uploadAttempts: 0, externalAttempts: 0 };
        browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version(); context = await browser.newContext({ serviceWorkers: 'block' });
        await context.route('**/*', route => {
            const request = route.request();
            if (new URL(request.url()).origin !== server.origin) { report.network.externalAttempts++; return route.abort(); }
            if (!['GET','HEAD'].includes(request.method()) || request.postDataBuffer()) { report.network.uploadAttempts++; return route.abort(); }
            return route.continue();
        });
        const pages = [];
        for (let i = 0; i < 2; i++) {
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => report.errors.push({ endpoint: i, phase: report.phase, type: errorType(error) }));
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript',
                body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.goto(server.origin);
            assert.equal(await page.evaluate(() => window.ZeydropRecovery.available()), true);
            await page.evaluate(() => window.ZeydropRecovery.list());
        }
        const [a, b] = pages, workers = pages.map(page => page.workers().find(worker => new URL(worker.url()).pathname === '/scripts/recovery-worker.js'));
        assert.ok(workers.every(Boolean)); assert.notEqual(workers[0], workers[1]);
        report.revisions = await Promise.all(pages.map(page => page.evaluate(() => document.querySelector('meta[name="build-revision"]').content)));
        assert.ok(report.revisions.every(value => /^[a-f0-9]{16}$/.test(value))); assert.equal(report.revisions[0], report.revisions[1]);
        const metadata = () => ({ id: crypto.randomUUID(), name: 'native-retirement.bin', size: 32768, mime: 'application/octet-stream' });
        async function commit(page, meta, value) {
            const sha256 = digest(Buffer.alloc(16384, value));
            await page.evaluate(async ({ meta, value, sha256 }) => {
                const sink = await window.ZeydropRecovery.open(meta); await sink.write(new Uint8Array(16384).fill(value)); await sink.park(sha256);
            }, { meta, value, sha256 }); return sha256;
        }
        const inspect = (page, id) => page.evaluate(async id => {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
            const raw = await (await (await dir.getFileHandle(id + '.json')).getFile()).text();
            let file; try { file = await (await dir.getFileHandle(id + '.part')).getFile(); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
            const sha256 = file && Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('');
            return { raw, bytes: file?.size ?? null, sha256: sha256 ?? null };
        }, id);
        async function restored(meta, sha256) {
            const result = await b.evaluate(async ({ meta, sha256 }) => {
                const value = await window.ZeydropRecovery.restore(meta.id, meta);
                const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await value.snapshot.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('');
                await value.sink.park(sha256); return { offset: value.offset, bytes: value.snapshot.size, sha256: hash };
            }, { meta, sha256 }); assert.deepEqual(result, { offset: 16384, bytes: 16384, sha256 }); return result;
        }
        report.phase = 'stale-orphan-retirement';
        const orphan = metadata();
        await workers[0].evaluate(async id => { await (await folder()).getFileHandle(id + '.part', { create: true }); }, orphan.id);
        await workers[1].evaluate(async id => {
            const dir = await folder(), descriptor = Object.getOwnPropertyDescriptor(dir, 'getFileHandle');
            const nativeGet = dir.getFileHandle.bind(dir), nativeNow = Date.now;
            let entered, release; const enteredPromise = new Promise(resolve => entered = resolve), released = new Promise(resolve => release = resolve);
            const state = { enteredPromise, gated: false, clockRestored: false, release,
                restore() { Date.now = nativeNow; if (descriptor) Object.defineProperty(dir, 'getFileHandle', descriptor); else delete dir.getFileHandle; } };
            // Only the initial listing snapshot sees the advanced clock. Restore
            // real time before the concurrent writer publishes its fresh record.
            const future = nativeNow() + 25 * 3600000; Date.now = () => future;
            Object.defineProperty(dir, 'getFileHandle', { configurable: true, value: async (name, options) => {
                const handle = await nativeGet(name, options);
                if (name === id + '.part' && !options?.create) {
                    const getFile = handle.getFile.bind(handle);
                    Object.defineProperty(handle, 'getFile', { configurable: true, value: async () => {
                        const file = await getFile();
                        if (!state.gated) { state.gated = true; Date.now = nativeNow; state.clockRestored = true; entered(true); await released; }
                        return file;
                    } });
                }
                return handle;
            } }); globalThis.__retirementControl = state;
        }, orphan.id);
        const oldList = b.evaluate(() => window.ZeydropRecovery.list()); oldList.catch(() => {});
        assert.equal(await bounded(workers[1].evaluate(() => globalThis.__retirementControl.enteredPromise)), true);
        const orphanSha = await commit(a, orphan, 0x5c), before = await inspect(a, orphan.id);
        await workers[1].evaluate(() => globalThis.__retirementControl.release()); await bounded(oldList);
        assert.deepEqual(await inspect(a, orphan.id), before);
        const clock = await workers[1].evaluate(() => ({ gated: globalThis.__retirementControl.gated, clockRestored: globalThis.__retirementControl.clockRestored }));
        assert.deepEqual(clock, { gated: true, clockRestored: true });
        report.cases.push({ case: 'stale-orphan-retirement', prefixBytes: before.bytes, exactMetadataAndBodyPreserved: true,
            controlledInitialClockAdvance: true, restoredClockBeforeFreshPublication: true, restore: await restored(orphan, orphanSha) });
        await workers[1].evaluate(() => globalThis.__retirementControl.restore()); await a.evaluate(id => window.ZeydropRecovery.erase(id), orphan.id);
        for (const gap of ['part', 'json']) {
            report.phase = 'manual-' + gap + '-unlink-gap'; const meta = metadata(); await commit(a, meta, 0x31);
            const before = await inspect(a, meta.id);
            await workers[1].evaluate(async ({ id, gap }) => {
                const dir = await folder(), descriptor = Object.getOwnPropertyDescriptor(dir, 'removeEntry'), remove = dir.removeEntry.bind(dir);
                let entered, release; const enteredPromise = new Promise(resolve => entered = resolve), released = new Promise(resolve => release = resolve);
                const state = { enteredPromise, gated: false, release,
                    restore() { if (descriptor) Object.defineProperty(dir, 'removeEntry', descriptor); else delete dir.removeEntry; } };
                Object.defineProperty(dir, 'removeEntry', { configurable: true, value: async (name, options) => {
                    if (!state.gated && name === id + '.' + gap) { state.gated = true; entered(true); await released; }
                    return remove(name, options);
                } }); globalThis.__retirementControl = state;
            }, { id: meta.id, gap });
            const pending = b.evaluate(id => window.ZeydropRecovery.erase(id), meta.id); pending.catch(() => {});
            assert.equal(await bounded(workers[1].evaluate(() => globalThis.__retirementControl.enteredPromise)), true);
            const refused = await a.evaluate(async id => { try { await window.ZeydropRecovery.erase(id); return null; } catch (error) { return error.name; } }, meta.id);
            assert.equal(refused, 'NoModificationAllowedError');
            const during = await inspect(a, meta.id); assert.equal(during.raw, before.raw);
            if (gap === 'part') assert.deepEqual(during, before); else assert.equal(during.bytes, null);
            await assert.rejects(a.evaluate(meta => window.ZeydropRecovery.open(meta), meta), /已有同名断点/);
            await workers[1].evaluate(() => globalThis.__retirementControl.release()); assert.equal(await bounded(pending), true);
            await workers[1].evaluate(() => globalThis.__retirementControl.restore());
            const sha256 = await commit(a, meta, 0x7a), replacement = await inspect(a, meta.id);
            assert.equal(replacement.bytes, 16384); assert.equal(replacement.sha256, sha256);
            const revalidated = await restored(meta, sha256);
            const lock = await workers[0].evaluate(async id => {
                const dir = await folder(), result = {};
                for (const name of ['mutation-lock', id + '.part']) {
                    const file = await dir.getFileHandle(name), access = await file.createSyncAccessHandle();
                    try { result[name === 'mutation-lock' ? 'controlBytes' : 'partBytes'] = access.getSize(); } finally { access.close(); }
                }
                return result;
            }, meta.id); assert.deepEqual(lock, { controlBytes: 0, partBytes: 16384 });
            report.cases.push({ case: 'manual-' + gap + '-unlink-gap', competingEraseRejected: refused, originalMetadataPreservedDuringGap: true,
                freshStartRejectedDuringGap: true, replacementAfterRetirementRestored: revalidated, nativeLockReacquiredWithoutReload: lock });
            await a.evaluate(id => window.ZeydropRecovery.erase(id), meta.id);
        }
        assert.equal((await a.evaluate(() => window.ZeydropRecovery.list())).length, 0);
        assert.equal(report.network.uploadAttempts, 0); assert.equal(report.network.externalAttempts, 0); assert.deepEqual(report.errors, []);
        report.phase = 'complete'; report.passed = true;
    } catch (error) {
        report.failure = errorType(error);
        if (/Executable doesn't exist/.test(String(error?.message))) report.failureCode = 'browser-executable-unavailable';
        else if (/Operation not permitted|\bEPERM\b/.test(String(error?.message))) report.failureCode = 'runtime-operation-denied';
        const line = String(error?.stack || '').match(/recovery-retirement-browser\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        throw error;
    } finally {
        try { await fs.writeFile('test-results/recovery-retirement-chromium.json', JSON.stringify(report, null, 2) + '\n'); }
        finally { await Promise.allSettled([context?.close(), browser?.close(), server?.close()]); }
    }
    console.log('Native recovery retirement evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Recovery retirement browser test failed:', errorType(error)); process.exitCode = 1; });
