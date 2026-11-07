'use strict';
// Native Chromium OPFS + two-context WebRTC. Only the first receiver's real
// built SHA Worker is fault-injected. Same host/STUN off is not WAN evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errorType = error => ['AssertionError','TimeoutError','TypeError','RangeError','SecurityError','NotAllowedError',
    'QuotaExceededError','AbortError','HashWorkerError','HashReadError','HashProtocolError','HashTimeoutError']
    .includes(error?.name) ? error.name : 'Error';

async function main() {
    const name = 'native-hash-crash-resume.bin', prefixBytes = 1024 * 1024, chunkBytes = 16 * 1024;
    const bodyMarker = 'PRIVATE_HASH_CRASH_BODY_SENTINEL';
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x6d); bytes.write(bodyMarker);
    const expected = { prefix: digest(bytes.subarray(0, prefixBytes)), full: digest(bytes),
        independentPrefix: digest(Buffer.alloc(2048, 0x42)),
        independentFull: digest(Buffer.concat([Buffer.alloc(2048, 0x42), Buffer.alloc(2048, 0x43)])) };
    const report = { schema: 1, engine: 'chromium',
        scope: 'real built SHA Worker fault after native OPFS append, direct two-context transfer and explicitly authorized recovery; same host/STUN disabled, not WAN/Safari/mobile evidence',
        phase: 'startup', checks: [], errors: [], nativeWorkers: [], passed: false };
    let server, browser; const contexts = [], pages = [];
    let injectedWorkers = 0, createTime = 0;
    try {
        await fs.mkdir('test-results', { recursive: true }); server = await startDev(0);
        const builtWorker = await fs.readFile('dist/scripts/stream-hash-worker.js', 'utf8');
        browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version();
        report.network = { uploadAttempts: 0, externalAttempts: 0, signalingMessages: 0, signalingBytes: 0, fileDataObserved: false };
        const originalMessage = server.signaling.message.bind(server.signaling);
        server.signaling.message = (peer, raw) => {
            const text = String(raw); report.network.signalingMessages++; report.network.signalingBytes += Buffer.byteLength(text);
            if ([name, bodyMarker, ...Object.values(expected)].some(value => text.includes(value))) report.network.fileDataObserved = true;
            return originalMessage(peer, raw);
        };
        for (let index = 0; index < 2; index++) {
            const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' }); contexts.push(context);
            await context.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== server.origin) { report.network.externalAttempts++; return route.abort(); }
                if (!['GET','HEAD'].includes(request.method()) || request.postDataBuffer()) {
                    report.network.uploadAttempts++; return route.abort();
                }
                return route.continue();
            });
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => { if (report.errors.length < 20) report.errors.push({ type: errorType(error), phase: report.phase, endpoint: index }); });
            page.on('worker', worker => {
                const url = new URL(worker.url()), script = url.pathname.split('/').at(-1);
                if (report.nativeWorkers.length < 32 && ['stream-hash-worker.js','recovery-worker.js'].includes(script))
                    report.nativeWorkers.push({ script, endpoint: index, phase: report.phase,
                        version: /^[a-f0-9]{16}$/.test(url.searchParams.get('v') || '') ? url.searchParams.get('v') : null });
            });
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript',
                body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.addInitScript(() => {
                window.showSaveFilePicker = undefined; window.__states = {}; window.__completions = 0;
                addEventListener('transfer-state', event => {
                    window.__states[event.detail.name] = event.detail;
                    if (event.detail.phase === 'complete') window.__completions++;
                });
                addEventListener('file-received', () => window.__completions++);
            });
        }
        const [sender, receiver] = pages;
        // Preserve the full built hashing implementation; inject only a native
        // runtime exception for its first update beyond the committed prefix.
        await contexts[1].route('**/stream-hash-worker.js?*', route => {
            if (injectedWorkers) return route.continue();
            injectedWorkers++;
            return route.fulfill({ contentType: 'text/javascript', body: builtWorker + '\n;{const base=self.onmessage;let failed=false;self.onmessage=function(event){const item=event.data;if(!failed&&item?.type==="update"&&item.offset>=1048576){failed=true;throw new Error("SyntheticStreamHashAfterAppendFailure");}return base.call(self,event);};}\n' });
        });
        const guard = async page => page.evaluate(() => {
            const manager = window.ZeydropStreamHash;
            window.__liveHashes = { created: 0, native: 0, mainCalls: 0 }; window.__binaryBytes = 0;
            manager._factory = () => { window.__liveHashes.mainCalls++; throw Error('Native hash Worker required'); };
            const create = manager.create.bind(manager);
            manager.create = () => { const hash = create(); window.__liveHashes.created++;
                if (hash.backend === 'worker') window.__liveHashes.native++; return hash; };
            const send = RTCPeer.prototype._send;
            RTCPeer.prototype._send = function(data) { if (typeof data !== 'string') window.__binaryBytes += data.byteLength; return send.call(this, data); };
        });
        const waitPeer = page => page.waitForFunction(() => {
            const peer = [...zeydrop.peers.peers.values()][0];
            return peer?._path?.direct && peer?._remoteHello && peer?._code && !peer?._verified;
        }, null, { timeout: 40000 });
        const pair = async url => {
            await receiver.locator('#roomInput').fill(url); await receiver.locator('#roomBtn').click();
            await Promise.all(pages.map(waitPeer));
            const codes = await Promise.all(pages.map(page => page.locator('.security-code').innerText())); assert.equal(codes[0], codes[1]);
            const paths = await Promise.all(pages.map(page => page.evaluate(() => [...zeydrop.peers.peers.values()][0]._path)));
            assert.ok(paths.every(path => path.direct && path.protocol === 'udp' && path.localType !== 'relay' && path.remoteType !== 'relay'));
            for (const page of pages) { assert.equal(await page.locator('x-peer input[type=file]').isDisabled(), true); await page.locator('.verify-peer').click(); }
            return paths.map(path => ({ protocol: path.protocol, localType: path.localType, remoteType: path.remoteType, direct: path.direct }));
        };
        await sender.goto(server.origin); await receiver.goto(server.origin);
        for (const page of pages) { await page.waitForFunction(() => !!window.ZeydropStreamHash && !!window.ZeydropRecovery); await guard(page); }
        report.phase = 'native-independent-record';
        report.independentSeed = await receiver.evaluate(async sha => {
            const store = window.ZeydropRecovery; if (!await store.available()) throw Error('Native OPFS unavailable');
            const meta = { id: crypto.randomUUID(), name: 'independent-retained-record.bin', size: 4096, mime: 'application/octet-stream' };
            const sink = await store.open(meta); await sink.write(new Uint8Array(2048).fill(0x42)); await sink.checkpoint(sha, true);
            window.__independentSink = sink; window.__independentMeta = meta;
            return { nativeRecoveryWorker: store.worker instanceof Worker, committed: sink.lastCommitted };
        }, expected.independentPrefix);
        assert.equal(report.independentSeed.nativeRecoveryWorker, true); assert.equal(report.independentSeed.committed, 2048);

        report.phase = 'initial-pair-and-consent'; createTime = Date.now();
        await sender.locator('#createRoomBtn').click();
        await sender.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        report.initialPaths = await pair(await sender.locator('#inviteUrl').inputValue());
        await receiver.evaluate(() => {
            window.__fault = { targetId: null, baseline: null, nativeErrors: 0, releases: 0, releasedOffset: null,
                erased: 0, physicalWritten: 0, controls: [] };
            const NativeWorker = Worker;
            window.ZeydropStreamHash._Worker = class extends NativeWorker {
                constructor(url) { super(url); this.addEventListener('error', event => {
                    if (String(event.message).includes('SyntheticStreamHashAfterAppendFailure')) window.__fault.nativeErrors++;
                }); }
            };
            const write = ZeydropDurableSink.prototype.write;
            ZeydropDurableSink.prototype.write = async function(...args) {
                await write.apply(this, args);
                if (this.id === window.__fault.targetId) window.__fault.physicalWritten = this.size;
            };
            const checkpoint = ZeydropDurableSink.prototype.checkpoint;
            ZeydropDurableSink.prototype.checkpoint = async function(...args) {
                const committed = await checkpoint.apply(this, args);
                if (this.id === window.__fault.targetId && committed === 1048576 && !window.__fault.baseline) {
                    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
                    const raw = await (await (await dir.getFileHandle(this.id + '.json')).getFile()).text();
                    window.__fault.baseline = { raw, meta: JSON.parse(raw) };
                }
                return committed;
            };
            const request = window.ZeydropRecovery.request.bind(window.ZeydropRecovery);
            window.ZeydropRecovery.request = async function(type, ...args) {
                if (args[0] === window.__fault.targetId && type === 'erase') window.__fault.erased++;
                const result = await request(type, ...args);
                if (args[0] === window.__fault.targetId && type === 'releaseCommitted') {
                    window.__fault.releases++; window.__fault.releasedOffset = result;
                }
                return result;
            };
            const send = RTCPeer.prototype.sendJSON;
            RTCPeer.prototype.sendJSON = function(message) {
                if (message.id === window.__fault.targetId && window.__fault.controls.length < 128)
                    window.__fault.controls.push({ type: message.type, offset: message.offset ?? null });
                return send.call(this, message);
            };
        });
        const file = { name, mimeType: 'application/octet-stream', buffer: bytes };
        await sender.locator('x-peer input[type=file]').setInputFiles(file);
        await receiver.locator('#fileOfferDialog[show]').waitFor();
        await receiver.locator('#recoveryReceiveOptions').waitFor({ state: 'visible', timeout: 15000 });
        await receiver.evaluate(() => { window.__fault.targetId = [...zeydrop.peers.peers.values()][0]._incoming.meta.id; });
        assert.equal(await sender.evaluate(() => window.__binaryBytes), 0);
        assert.equal(await receiver.locator('#useLocalCheckpoint').isChecked(), false);
        await receiver.locator('#durableLocalReceive').check(); report.phase = 'fault-after-native-append';
        await receiver.locator('#acceptFileOffer').click();
        await receiver.waitForFunction(() => window.__fault.nativeErrors === 1 && window.__fault.releases === 1
            && [...zeydrop.peers.peers.values()].every(peer => !peer._incoming && peer._queuedBytes === 0)
            && window.ZeydropStreamHash._handles.size === 0, null, { timeout: 60000 });
        await sender.waitForFunction(name => window.__states[name]?.phase === 'cancelled'
            && ![...zeydrop.peers.peers.values()][0]._outgoing && window.ZeydropStreamHash._handles.size === 0, name, { timeout: 30000 });
        report.fault = await receiver.evaluate(async () => {
            const fault = window.__fault, dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
            const raw = await (await (await dir.getFileHandle(fault.targetId + '.json')).getFile()).text(), meta = JSON.parse(raw);
            const part = await (await dir.getFileHandle(fault.targetId + '.part')).getFile();
            return { nativeErrors: fault.nativeErrors, releases: fault.releases, releasedOffset: fault.releasedOffset,
                erased: fault.erased, physicalWritten: fault.physicalWritten, physicalSize: part.size,
                metadataUnchanged: raw === fault.baseline?.raw, offset: meta.offset, prefixSha256: meta.prefixSha256,
                baselineOffset: fault.baseline?.meta.offset, baselineSha256: fault.baseline?.meta.prefixSha256,
                phase: meta.phase, completionEvents: window.__completions, controls: fault.controls };
        });
        report.fault.injectedWorkerRequests = injectedWorkers;
        assert.equal(report.fault.injectedWorkerRequests, 1); assert.equal(report.fault.nativeErrors, 1);
        assert.equal(report.fault.releases, 1); assert.equal(report.fault.releasedOffset, prefixBytes);
        assert.equal(report.fault.erased, 0); assert.equal(report.fault.physicalWritten, prefixBytes + chunkBytes);
        assert.equal(report.fault.physicalSize, prefixBytes + chunkBytes); assert.equal(report.fault.metadataUnchanged, true);
        assert.equal(report.fault.baselineOffset, prefixBytes); assert.equal(report.fault.offset, prefixBytes);
        assert.equal(report.fault.baselineSha256, expected.prefix); assert.equal(report.fault.prefixSha256, expected.prefix);
        assert.equal(report.fault.phase, 'partial'); assert.equal(report.fault.completionEvents, 0);
        assert.equal(await sender.evaluate(() => window.__completions), 0);
        assert.equal(report.fault.controls.some(message => message.type === 'complete'), false);
        const acks = report.fault.controls.filter(message => message.type === 'ack').map(message => message.offset);
        assert.ok(acks.includes(prefixBytes)); assert.ok(acks.every(offset => offset <= prefixBytes));
        report.checks.push('native SHA Worker crashes after a real uncheckpointed 16 KiB append; original 1 MiB metadata stays byte-for-byte unchanged, no erase/false complete/new ACK occurs');

        report.phase = 'native-lock-release-before-reload';
        report.lock = await receiver.evaluate(async () => {
            const store = window.ZeydropRecovery, fault = window.__fault, meta = fault.baseline.meta;
            // This runs before any navigation or recovery Worker termination:
            // successful native reacquisition cannot be credited to page reload.
            const restored = await store.restore(fault.targetId, meta);
            const bytes = await restored.snapshot.arrayBuffer();
            const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
                .map(value => value.toString(16).padStart(2, '0')).join('');
            await restored.sink.park(restored.prefixSha256);
            return { reacquiredBeforeReload: true, offset: restored.offset, snapshotBytes: restored.snapshot.size,
                sha256, nativeRecoveryWorker: store.worker instanceof Worker };
        });
        assert.equal(report.lock.reacquiredBeforeReload, true); assert.equal(report.lock.nativeRecoveryWorker, true);
        assert.equal(report.lock.offset, prefixBytes); assert.equal(report.lock.snapshotBytes, prefixBytes);
        assert.equal(report.lock.sha256, expected.prefix);
        report.independent = await receiver.evaluate(async sha256 => {
            const sink = window.__independentSink; await sink.write(new Uint8Array(2048).fill(0x43));
            const result = await sink.finish(sha256), bytes = await result.blob.arrayBuffer();
            const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
                .map(value => value.toString(16).padStart(2, '0')).join('');
            return { bytes: result.blob.size, sha256: actual, locallyStored: result.locallyStored,
                nativeRecoveryWorker: window.ZeydropRecovery.worker instanceof Worker };
        }, expected.independentFull);
        assert.equal(report.independent.bytes, 4096); assert.equal(report.independent.sha256, expected.independentFull);
        assert.equal(report.independent.locallyStored, true); assert.equal(report.independent.nativeRecoveryWorker, true);
        report.checks.push('the same live recovery Worker releases the native file lock, restore truncates the tail and verifies the old prefix before reload; a separate active OPFS record survives and finishes correctly');

        report.phase = 'fresh-page-and-invitation';
        await sender.locator('#leaveRoomBtn').click(); await receiver.locator('#leaveRoomBtn').click();
        await receiver.reload(); await receiver.waitForFunction(() => !!window.ZeydropStreamHash && !!window.ZeydropRecovery);
        await guard(receiver);
        await receiver.evaluate(() => {
            window.__resume = { calls: 0 }; const store = window.ZeydropRecovery, restore = store.restore.bind(store);
            store.restore = async function(id, meta) {
                const result = await restore(id, meta); window.__resume.calls++;
                const bytes = await result.snapshot.arrayBuffer();
                const independentSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
                    .map(value => value.toString(16).padStart(2, '0')).join('');
                window.__resume = { calls: window.__resume.calls, offset: result.offset, snapshotBytes: result.snapshot.size,
                    prefixSha256: result.prefixSha256, independentSha256 };
                return result;
            };
        });
        const remaining = 5500 - (Date.now() - createTime); if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
        await sender.locator('#createRoomBtn').click();
        await sender.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        report.freshPaths = await pair(await sender.locator('#inviteUrl').inputValue());
        assert.equal(await receiver.evaluate(() => window.__resume.calls), 0);
        await sender.evaluate(() => { window.__binaryBytes = 0; });
        await sender.locator('x-peer input[type=file]').setInputFiles(file);
        await receiver.locator('#fileOfferDialog[show]').waitFor();
        await receiver.locator('#localResumeOption').waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(await receiver.locator('#useLocalCheckpoint').isChecked(), false);
        const beforeConsent = await receiver.evaluate(() => {
            const state = [...zeydrop.peers.peers.values()][0]._incoming;
            return { offset: state.offset, sinkAttached: !!state.sink, restores: window.__resume.calls };
        });
        assert.deepEqual(beforeConsent, { offset: 0, sinkAttached: false, restores: 0 });
        assert.equal(await sender.evaluate(() => window.__binaryBytes), 0);
        await receiver.locator('#useLocalCheckpoint').check(); report.phase = 'authorized-prefix-resume';
        await receiver.locator('#acceptFileOffer').click();
        await sender.waitForFunction(name => window.__states[name]?.phase === 'complete', name, { timeout: 120000 });
        await receiver.locator('#receiveDialog[show]').waitFor({ timeout: 30000 });
        report.resume = await receiver.evaluate(() => window.__resume);
        assert.equal(report.resume.calls, 1); assert.equal(report.resume.offset, prefixBytes);
        assert.equal(report.resume.snapshotBytes, prefixBytes); assert.equal(report.resume.prefixSha256, expected.prefix);
        assert.equal(report.resume.independentSha256, expected.prefix);
        const download = receiver.waitForEvent('download'); await receiver.locator('#download').click();
        const received = await fs.readFile(await (await download).path());
        assert.equal(received.length, bytes.length); assert.equal(digest(received), expected.full);
        report.resume.fileBytes = received.length; report.resume.finalSha256 = digest(received);
        report.resume.dataChannelBytes = await sender.evaluate(() => window.__binaryBytes);
        assert.equal(report.resume.dataChannelBytes, bytes.length - prefixBytes);
        report.checks.push('fresh page/invitation, new safety-code clicks, file reselection and explicit local-checkpoint consent restore only after approval; the 3 MiB tail completes with independently verified 4 MiB downloaded SHA');

        report.phase = 'cleanup-and-privacy';
        report.liveHashes = await Promise.all(pages.map(page => page.evaluate(() => ({ ...window.__liveHashes,
            active: window.ZeydropStreamHash._handles.size }))));
        assert.ok(report.liveHashes.every(item => item.created > 0 && item.created === item.native && item.mainCalls === 0 && item.active === 0));
        const records = await receiver.evaluate(() => window.ZeydropRecovery.list());
        assert.equal(records.length, 2); assert.ok(records.every(record => record.phase === 'complete'));
        await receiver.evaluate(async () => { for (const record of await window.ZeydropRecovery.list()) await window.ZeydropRecovery.erase(record.id); });
        assert.equal((await receiver.evaluate(() => window.ZeydropRecovery.list())).length, 0);
        assert.equal(injectedWorkers, 1); assert.equal(report.network.uploadAttempts, 0);
        assert.equal(report.network.externalAttempts, 0); assert.equal(report.network.fileDataObserved, false);
        await receiver.waitForTimeout(100); assert.deepEqual(report.errors, []);
        assert.ok(report.nativeWorkers.some(worker => worker.script === 'stream-hash-worker.js' && worker.endpoint === 1));
        report.passed = true; report.phase = 'complete';
    } catch (error) {
        report.failure = errorType(error);
        if (/Executable doesn't exist/.test(String(error?.message))) report.failureCode = 'browser-executable-unavailable';
        else if (/Operation not permitted|\bEPERM\b/.test(String(error?.message))) report.failureCode = 'runtime-operation-denied';
        const line = String(error?.stack || '').match(/stream-hash-recovery-browser\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        throw error;
    } finally {
        try {
            await fs.mkdir('test-results', { recursive: true });
            await fs.writeFile('test-results/stream-hash-recovery-chromium.json', JSON.stringify(report, null, 2) + '\n');
        } finally {
            await Promise.allSettled(contexts.map(context => context.close()));
            await browser?.close(); await server?.close();
        }
    }
    console.log('Native stream-hash recovery evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Stream-hash recovery browser test failed:', errorType(error)); process.exitCode = 1; });
