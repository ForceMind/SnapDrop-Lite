'use strict';
// Real Chromium ServiceWorker install/wait/activate/rollback on one private
// loopback origin. Only copied build fixtures and synthetic origin-local OPFS
// are used; this is not an installed/mobile PWA or operating-system test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { ZeydropServer } = require('../server');
const run = promisify(execFile), root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const workerScripts = ['file-hash-worker.js', 'recovery-worker.js', 'stream-hash-worker.js'];
const errorType = error => ['AssertionError','TimeoutError','TypeError','SecurityError','NotAllowedError',
    'QuotaExceededError','AbortError','FixtureBuildError'].includes(error?.name) ? error.name : 'Error';

async function fixtures(temporary) {
    const { PUBLIC_CLIENT_FILES, readApprovedSourceFile } = await import(pathToFileURL(path.join(root, 'scripts/public-assets.mjs')));
    // Match the production build's explicit inputs. Real copies preserve its
    // non-symlink source/parent validation, also without a .git directory.
    const names = [...PUBLIC_CLIENT_FILES, 'package.json', 'package-lock.json', 'server/index.js',
        'server/package.json', 'server/package-lock.json', 'scripts/build.mjs', 'scripts/public-assets.mjs',
        'deploy.sh', 'scripts/rollback.sh', 'scripts/check-signaling.cjs', 'deployment/nginx.conf',
        'deployment/zeydrop.service', 'LICENSE', 'NOTICE'];
    const source = path.join(temporary, 'source'); await fs.mkdir(source);
    const inputHash = crypto.createHash('sha256');
    for (const name of names) {
        const bytes = await readApprovedSourceFile(root, name);
        inputHash.update(name); inputHash.update(bytes);
        await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
        await fs.writeFile(path.join(source, name), bytes);
    }
    // Only locked dependency directories are shared; no public source or
    // working dist directory is symlinked, mutated or copied back.
    await fs.symlink(await fs.realpath(path.join(root, 'node_modules')), path.join(source, 'node_modules'), 'dir');
    await fs.symlink(await fs.realpath(path.join(root, 'server/node_modules')), path.join(source, 'server/node_modules'), 'dir');
    async function build(label) {
        try { await run(process.execPath, ['scripts/build.mjs'], { cwd: source, timeout: 60000, maxBuffer: 128 * 1024 }); }
        catch { const error = Error('Copied fixture build failed'); error.name = 'FixtureBuildError'; throw error; }
        const target = path.join(temporary, label); await fs.cp(path.join(source, 'dist'), target, { recursive: true });
        const buildInfo = JSON.parse(await fs.readFile(path.join(target, 'build.json'), 'utf8'));
        assert.match(buildInfo.revision, /^[a-f0-9]{16}$/);
        const script = await fs.readFile(path.join(target, 'service-worker.js'), 'utf8');
        assert.ok(script.includes("const CACHE = 'zeydrop-shell-" + buildInfo.revision + "';"));
        const assetText = script.match(/^const ASSETS = (\[[^\n]+\]);$/m);
        assert.ok(assetText, 'the actual built precache array must be present');
        const assets = JSON.parse(assetText[1]); assert.equal(new Set(assets).size, assets.length);
        const files = new Map();
        async function collect(directory, prefix = '') {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const relative = prefix + entry.name;
                if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative + '/');
                else { assert.equal(entry.isFile(), true); files.set('/' + relative, await fs.readFile(path.join(directory, entry.name))); }
            }
        }
        await collect(target);
        const expected = assets.map(asset => {
            assert.ok(typeof asset === 'string' && asset.startsWith('/') && !asset.startsWith('//'));
            const parsed = new URL(asset, 'http://fixture.invalid');
            assert.equal(parsed.origin, 'http://fixture.invalid'); assert.equal(parsed.hash, '');
            const bytes = files.get(parsed.pathname === '/' ? '/index.html' : parsed.pathname); assert.ok(bytes);
            return { asset: parsed.pathname + parsed.search, status: 200, sha256: digest(bytes) };
        }).sort((a, b) => a.asset.localeCompare(b.asset));
        return { label, revision: buildInfo.revision, files, expected };
    }
    const A = await build('A'), originalCss = await fs.readFile(path.join(source, 'client/styles.css'));
    // Fixed, approved public input delta, local to this private fixture. Both
    // versions still execute the unmodified production SW and application.
    await fs.writeFile(path.join(source, 'client/styles.css'), Buffer.concat([originalCss,
        Buffer.from('\n/* zeydrop-native-pwa-upgrade-fixture-B */\n')]));
    const B = await build('B'); assert.notEqual(A.revision, B.revision);
    const sourceInputSha256 = inputHash.digest('hex');
    assert.equal(A.revision, sourceInputSha256.slice(0, 16), 'actual A build revision must derive from its exact approved source bytes');
    return { A, B, sourceInputSha256, delta: 'one fixed comment appended to the copied approved styles.css input' };
}

async function fixtureServer(A, B) {
    let current = A, broken = false;
    const evidence = { rejectedInstallAssetRequests: 0, nonReadMethods: 0, requestBodies: 0 };
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
    const server = http.createServer((request, response) => {
        if (!['GET', 'HEAD'].includes(request.method)) { evidence.nonReadMethods++; response.writeHead(405); response.end(); return; }
        if (request.headers['content-length'] || request.headers['transfer-encoding']) evidence.requestBodies++;
        let url;
        try { url = new URL(request.url, 'http://fixture.invalid'); } catch { response.writeHead(400); response.end(); return; }
        // A real failing fetch during cache.addAll, not a SW/Cache mock or
        // page route (which would not reliably cover native install fetches).
        if (broken && current === B && url.pathname === '/scripts/stream-hash-worker.js'
            && url.search === '?v=' + B.revision) {
            evidence.rejectedInstallAssetRequests++; response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end(); return;
        }
        const name = url.pathname === '/' ? '/index.html' : url.pathname, bytes = current.files.get(name);
        if (!bytes) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        response.end(request.method === 'HEAD' ? undefined : bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const signaling = new ZeydropServer({ noServer: true, origins: origin });
    server.on('upgrade', (request, socket, head) => signaling._wss.handleUpgrade(request, socket, head,
        ws => signaling._wss.emit('connection', ws, request)));
    return { origin, evidence, select(version, failAsset = false) { current = version; broken = failAsset; },
        async close() { await signaling.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function readCache(revision) {
    const name = 'zeydrop-shell-' + revision, names = await caches.keys();
    if (!names.includes(name)) throw Error('Expected native shell cache absent');
    const cache = await caches.open(name), keys = await cache.keys(), entries = [];
    for (const request of keys) {
        const url = new URL(request.url);
        if (url.origin !== location.origin) throw Error('Unexpected cache origin');
        const response = await cache.match(request);
        const bytes = await response.arrayBuffer(), sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
        entries.push({ asset: url.pathname + url.search, status: response.status, sha256 });
    }
    return { names: names.filter(value => value.startsWith('zeydrop-shell-')).sort(),
        entries: entries.sort((a, b) => a.asset.localeCompare(b.asset)) };
}
async function assertCache(execution, fixture, sole = false) {
    const found = await execution.evaluate(readCache, fixture.revision);
    assert.deepEqual(found.entries, fixture.expected, 'all native cached responses must match the actual fixture bytes');
    if (sole) assert.deepEqual(found.names, ['zeydrop-shell-' + fixture.revision]);
    return { revision: fixture.revision, entryCount: found.entries.length, manifestSha256: digest(JSON.stringify(found.entries)),
        allBytesMatchFixture: true, shellCacheCount: found.names.length };
}
async function waitUntil(action, timeout = 30000) {
    const deadline = Date.now() + timeout;
    do { const value = await action(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    while (Date.now() < deadline);
    const error = Error('Native lifecycle deadline exceeded'); error.name = 'TimeoutError'; throw error;
}
async function lifecycle(execution) {
    return execution.evaluate(async () => ({ cache: CACHE, active: self.registration.active?.state || null,
        waiting: self.registration.waiting?.state || null, installing: self.registration.installing?.state || null,
        clients: (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length }));
}
async function waitingWorker(context, fixture) {
    return waitUntil(async () => {
        for (const worker of [...context.serviceWorkers()].reverse()) {
            let state; try { state = await lifecycle(worker); } catch { continue; }
            if (state.cache === 'zeydrop-shell-' + fixture.revision && state.waiting === 'installed') return worker;
        }
        return null;
    });
}
async function watchController(page) {
    await page.evaluate(async () => {
        window.__pwaController = navigator.serviceWorker.controller; window.__pwaControllerChanges = 0;
        window.__pwaInstallStates = []; window.__pwaRegistration = await navigator.serviceWorker.getRegistration('/');
        navigator.serviceWorker.addEventListener('controllerchange', () => window.__pwaControllerChanges++);
        window.__pwaRegistration.addEventListener('updatefound', () => {
            const worker = window.__pwaRegistration.installing;
            if (worker) worker.addEventListener('statechange', () => {
                if (window.__pwaInstallStates.length < 30) window.__pwaInstallStates.push(worker.state);
            });
        });
    });
}
async function assertOldClient(page, fixture) {
    const result = await page.evaluate(() => ({ revision: document.querySelector('meta[name="build-revision"]').content,
        unchanged: navigator.serviceWorker.controller === window.__pwaController,
        controllerChanges: window.__pwaControllerChanges, active: navigator.serviceWorker.controller?.state,
        waiting: window.__pwaRegistration.waiting?.state || null }));
    assert.equal(result.revision, fixture.revision); assert.equal(result.unchanged, true);
    assert.equal(result.controllerChanges, 0); assert.equal(result.active, 'activated'); return result;
}
async function checkpointState(page, id) {
    return page.evaluate(async id => {
        const listing = await window.ZeydropRecovery.list(), record = listing.find(item => item.id === id);
        if (listing.length !== 1 || !record) throw Error('Synthetic checkpoint absent or changed');
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
        const data = await (await directory.getFileHandle(id + '.part')).getFile();
        const metadata = await (await directory.getFileHandle(id + '.json')).getFile();
        const sha = async file => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { phase: record.phase, offset: record.offset, prefixSha256: record.prefixSha256,
            physicalSize: data.size, dataSha256: await sha(data), metadataSha256: await sha(metadata) };
    }, id);
}
async function noBinding(page) {
    const state = await page.evaluate(() => ({ peers: zeydrop.peers.peers.size, roomAbsent: zeydrop.server._desiredRoomId === null,
        held: zeydrop.peers._resumeSlots.size, boundFilesAbsent: zeydrop.sendQueue.boundFiles === null,
        fileInputsEmpty: [...document.querySelectorAll('input[type=file]')].every(input => !input.files.length),
        rememberUnchecked: !document.querySelector('#rememberSendQueue').checked,
        storageMutations: { ...window.__pwaStorageMutations } }));
    assert.deepEqual(state, { peers: 0, roomAbsent: true, held: 0, boundFilesAbsent: true, fileInputsEmpty: true,
        rememberUnchecked: true, storageMutations: { start: 0, resume: 0, append: 0, checkpoint: 0, park: 0, finish: 0, erase: 0 } });
    return state;
}

async function main() {
    const report = { schema: 1, engine: 'chromium', phase: 'fixture-build', passed: false, checks: [], errors: [],
        scope: 'native same-origin ServiceWorker failed install, waiting, all-clients-closed activation and rollback; exact copied-build Cache Storage and browser-emulated offline dedicated Workers; synthetic native OPFS checkpoint preserved without automatic binding; not physical network loss, installed/mobile PWA, Safari, OS upgrade or real-host deployment evidence',
        versions: [], transitions: [], offlineWorkers: [] };
    let temporary, browser, context, server, currentPage;
    const recordId = crypto.randomUUID(), prefixBytes = 64 * 1024, expectedPrefix = digest(Buffer.alloc(prefixBytes, 0x5d));
    let baseline;
    const installPage = async () => {
        const page = await context.newPage(); currentPage = page;
        page.on('pageerror', error => { if (report.errors.length < 20) report.errors.push({ type: errorType(error), phase: report.phase }); });
        page.on('worker', worker => {
            if (!report.phase.startsWith('offline-')) return;
            try { const url = new URL(worker.url()), script = url.pathname.split('/').at(-1), revision = url.searchParams.get('v');
                if (workerScripts.includes(script)) report.offlineWorkers.push({ phase: report.phase, script,
                    revision: /^[a-f0-9]{16}$/.test(revision || '') ? revision : null }); } catch {}
        });
        await page.goto(server.origin);
        await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated'
            && window.ZeydropFileHash && window.ZeydropStreamHash && window.ZeydropRecovery, null, { timeout: 30000 });
        return page;
    };
    const activeVersion = async (page, fixture, stage) => {
        report.phase = 'active-' + stage;
        assert.equal(await page.locator('meta[name="build-revision"]').getAttribute('content'), fixture.revision);
        const before = await noBinding(page); const cache = await assertCache(page, fixture, true);
        assert.deepEqual(await checkpointState(page, recordId), baseline);
        const session = await context.newCDPSession(page);
        await session.send('Network.clearBrowserCache'); await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        report.phase = 'offline-' + stage;
        await context.setOffline(true);
        await session.send('Network.overrideNetworkState', { offline: true, latency: 0, downloadThroughput: -1,
            uploadThroughput: -1, connectionType: 'none' });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => navigator.onLine === false && navigator.serviceWorker.controller?.state === 'activated'
            && window.ZeydropFileHash && window.ZeydropStreamHash && window.ZeydropRecovery, null, { timeout: 30000 });
        assert.equal(await page.locator('meta[name="build-revision"]').getAttribute('content'), fixture.revision);
        const probe = await page.evaluate(async () => {
            const abort = new AbortController(); let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 5000);
            try { await fetch('/build.json', { cache: 'no-store', signal: abort.signal }); return { rejected: false, timedOut }; }
            catch (error) { return { rejected: true, timedOut, type: ['TypeError','AbortError'].includes(error.name) ? error.name : 'Error' }; }
            finally { clearTimeout(timer); }
        });
        assert.deepEqual(probe, { rejected: true, timedOut: false, type: 'TypeError' });
        const hashes = await page.evaluate(async () => {
            const full = await window.ZeydropFileHash.hash(new File(['abc'], 'synthetic-pwa-fixture.bin'));
            const handle = window.ZeydropStreamHash.create();
            try {
                await handle.update(new TextEncoder().encode('a')); const prefix = await handle.digestHex();
                await handle.update(new TextEncoder().encode('bc')); const sha256 = await handle.digestHex({ final: true });
                return { file: { backend: full.backend, bytes: full.bytes, sha256: full.sha256 },
                    stream: { backend: handle.backend, bytes: handle.bytes, closed: handle.closed, prefix, sha256 },
                    recovery: { available: await window.ZeydropRecovery.available(), nativeWorker: window.ZeydropRecovery.worker instanceof Worker } };
            } finally { handle.dispose(); }
        });
        assert.deepEqual(hashes, { file: { backend: 'worker', bytes: 3, sha256: digest('abc') },
            stream: { backend: 'worker', bytes: 3, closed: true, prefix: digest('a'), sha256: digest('abc') },
            recovery: { available: true, nativeWorker: true } });
        for (const script of workerScripts) assert.ok(report.offlineWorkers.some(worker => worker.phase === report.phase
            && worker.script === script && worker.revision === fixture.revision), 'each offline document must create all three exact-version native Workers');
        const after = await noBinding(page); assert.deepEqual(await checkpointState(page, recordId), baseline);
        await assertCache(page, fixture, true);
        report.versions.push({ stage, revision: fixture.revision, cache, offlineProbe: probe, hashes,
            checkpointUnchanged: true, checkpoint: baseline, noAutomaticBinding: before, offlineNoAutomaticBinding: after,
            offlineDriver: 'Playwright BrowserContext.setOffline plus CDP Network.overrideNetworkState; HTTP cache cleared and disabled' });
        await session.send('Network.overrideNetworkState', { offline: false, latency: 0, downloadThroughput: -1,
            uploadThroughput: -1, connectionType: 'ethernet' });
        await context.setOffline(false); await session.detach();
    };
    const transition = async (oldPage, heldPage, from, to, stage) => {
        report.phase = 'waiting-' + stage; await watchController(oldPage); await watchController(heldPage);
        server.select(to); await oldPage.evaluate(() => window.__pwaRegistration.update());
        const worker = await waitingWorker(context, to);
        await oldPage.waitForTimeout(500);
        const both = [await assertOldClient(oldPage, from), await assertOldClient(heldPage, from)];
        assert.ok(both.every(item => item.waiting === 'installed'));
        await assertCache(oldPage, from); await assertCache(oldPage, to);
        await heldPage.close(); await oldPage.waitForTimeout(200);
        const one = await assertOldClient(oldPage, from); assert.equal(one.waiting, 'installed');
        assert.equal((await lifecycle(worker)).clients, 1);
        report.phase = 'activating-' + stage; await oldPage.close(); currentPage = null;
        assert.equal(context.pages().length, 0, 'no old window client may survive activation');
        const activated = await waitUntil(async () => {
            // A lost worker handle is a hard failure, not a fallback allowing
            // a new window to obscure whether natural activation happened.
            const state = await lifecycle(worker);
            return state.cache === 'zeydrop-shell-' + to.revision && state.active === 'activated'
                && state.waiting === null && state.installing === null && state.clients === 0 ? state : null;
        });
        const cache = await assertCache(worker, to, true);
        report.transitions.push({ stage, from: from.revision, to: to.revision, bothClients: both,
            oneClient: one, afterAllClientsClosed: activated, cache, forcedActivation: false });
        report.checks.push(stage + ': native waiting worker leaves old documents/controllers unchanged, then activates only after every old window closes');
        return installPage();
    };
    try {
        await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-pwa-upgrade-'));
        const built = await fixtures(temporary), { A, B } = built;
        report.fixtures = { A: A.revision, B: B.revision, sourceInputSha256: built.sourceInputSha256, delta: built.delta,
            copiedSourceRealDirectories: true, sharedDependencyDirectoriesOnly: true, productionSourceOrDistMutated: false };
        report.phase = 'browser-startup';
        browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? {
            executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version(); context = await browser.newContext({ serviceWorkers: 'allow' });
        await context.addInitScript(() => {
            // Observation only. All native Worker calls/arguments are forwarded
            // unchanged; no user/file values or message bodies are retained.
            window.__pwaStorageMutations = { start: 0, resume: 0, append: 0, checkpoint: 0, park: 0, finish: 0, erase: 0 };
            const post = Worker.prototype.postMessage;
            Worker.prototype.postMessage = function(value, ...args) {
                if (value && Object.hasOwn(window.__pwaStorageMutations, value.type)) window.__pwaStorageMutations[value.type]++;
                return post.call(this, value, ...args);
            };
        });
        report.phase = 'fixture-server'; server = await fixtureServer(A, B);
        report.phase = 'initial-A'; let page = await installPage();
        await page.reload(); await page.waitForFunction(() => !!window.ZeydropRecovery && !!navigator.serviceWorker.controller);
        await page.evaluate(async ({ id, sha256, bytes }) => {
            const store = window.ZeydropRecovery;
            if (!await store.available()) throw Error('Native OPFS unavailable');
            const sink = await store.open({ id, name: 'synthetic-pwa-checkpoint.bin', size: bytes * 2, mime: 'application/octet-stream' });
            for (let offset = 0; offset < bytes; offset += 16 * 1024)
                await sink.write(new Uint8Array(Math.min(16 * 1024, bytes - offset)).fill(0x5d));
            await sink.checkpoint(sha256, true); await sink.park(sha256);
        }, { id: recordId, sha256: expectedPrefix, bytes: prefixBytes });
        baseline = await checkpointState(page, recordId);
        assert.equal(baseline.phase, 'partial'); assert.equal(baseline.offset, prefixBytes);
        assert.equal(baseline.physicalSize, prefixBytes); assert.equal(baseline.dataSha256, expectedPrefix);
        assert.equal(baseline.prefixSha256, expectedPrefix);
        // A fresh document resets observation after the explicitly authorized
        // synthetic seed. Future documents must not bind or mutate that file.
        await page.reload(); await page.waitForFunction(() => !!window.ZeydropRecovery && !!navigator.serviceWorker.controller);
        await activeVersion(page, A, 'initial-A'); const heldA = await installPage();
        report.phase = 'failed-B-install'; await watchController(page); await watchController(heldA);
        server.select(B, true); await page.evaluate(() => window.__pwaRegistration.update());
        await page.waitForFunction(() => window.__pwaInstallStates.includes('redundant')
            && !window.__pwaRegistration.installing && !window.__pwaRegistration.waiting, null, { timeout: 30000 });
        assert.ok(server.evidence.rejectedInstallAssetRequests > 0);
        const failed = { rejectionObserved: true, asset: 'stream-hash-worker.js',
            clients: [await assertOldClient(page, A), await assertOldClient(heldA, A)], cache: await assertCache(page, A),
            checkpointUnchanged: true, states: await page.evaluate(() => [...window.__pwaInstallStates]) };
        assert.deepEqual(await checkpointState(page, recordId), baseline);
        assert.ok(failed.clients.every(client => client.waiting === null));
        report.failedInstall = failed;
        report.checks.push('a real 503 during B precache makes that installer redundant while A controls both old clients and retains every exact cached byte and the native OPFS checkpoint');
        // The retry invokes the real registration update with the same B
        // script now fully fetchable; it never unregisters A or forces waiting.
        page = await transition(page, heldA, A, B, 'upgrade-A-to-B');
        await activeVersion(page, B, 'upgraded-B'); const heldB = await installPage();
        page = await transition(page, heldB, B, A, 'rollback-B-to-A');
        await activeVersion(page, A, 'rolled-back-A');
        report.phase = 'cleanup-owned-record'; await page.evaluate(id => window.ZeydropRecovery.erase(id), recordId);
        assert.equal(await page.evaluate(async () => (await window.ZeydropRecovery.list()).length), 0);
        assert.equal(server.evidence.nonReadMethods, 0); assert.equal(server.evidence.requestBodies, 0);
        report.server = server.evidence; assert.deepEqual(report.errors, []);
        report.checks.push('A, upgraded B and rolled-back A each reload the exact complete cached shell offline, create all three revision-bound native Workers, and independently verify SHA without automatically binding the stored file');
        report.passed = true; report.phase = 'complete';
    } catch (error) {
        report.failure = errorType(error);
        const line = String(error?.stack || '').match(/pwa-upgrade-browser\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        if (['EPERM','EACCES','ENOENT'].includes(error?.code)) report.failureCode = error.code;
        if (report.phase === 'browser-startup') {
            // Playwright wraps native stderr in a launch Error. Classify only
            // fixed known conditions; never publish that raw message/command.
            const message = String(error?.message || '');
            if (/EPERM|Operation not permitted/i.test(message)) report.startupFailure = 'native-operation-not-permitted';
            else if (/EACCES|Permission denied/i.test(message)) report.startupFailure = 'native-access-denied';
            else if (/Executable doesn.t exist|ENOENT/i.test(message)) report.startupFailure = 'browser-executable-unavailable';
            else report.startupFailure = 'native-browser-launch-failed';
        }
        if (currentPage) report.failureDocument = await currentPage.evaluate(() => ({
            controlled: !!navigator.serviceWorker.controller, controllerState: navigator.serviceWorker.controller?.state || null,
            online: navigator.onLine, recoveryPresent: !!window.ZeydropRecovery })).catch(() => ({ unavailable: true }));
        throw error;
    } finally {
        try {
            await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
            await fs.writeFile(path.join(root, 'test-results/pwa-upgrade-chromium.json'), JSON.stringify(report, null, 2) + '\n');
        } finally {
            await Promise.allSettled([context?.close(), browser?.close(), server?.close()]);
            if (temporary) await fs.rm(temporary, { recursive: true, force: true });
        }
    }
    console.log('PWA upgrade browser evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('PWA upgrade browser test failed:', errorType(error)); process.exitCode = 1; });
