'use strict';
const { openJoin, openRecovery } = require('./workspace-ui-helpers.cjs');
// Native Linux Chromium process-group crash on a test-owned persistent profile.
// No graceful page/Worker parking before SIGKILL. Not power-loss/WAN evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { OwnedChromiumProcess } = require('./owned-chromium-process.cjs');
const { startDev } = require('../scripts/dev.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errorType = error => ['AssertionError','TimeoutError','TypeError','RangeError','SecurityError','NotAllowedError',
    'QuotaExceededError','AbortError','BrowserProcessError'].includes(error?.name) ? error.name : 'Error';
async function main() {
    const name = 'native-process-crash-resume.bin', prefix = 1024 * 1024, chunk = 16 * 1024;
    const marker = 'PRIVATE_PROCESS_CRASH_BODY_SENTINEL';
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x73); bytes.write(marker);
    const expectedPrefix = digest(bytes.subarray(0, prefix)), expectedFull = digest(bytes);
    const report = { schema: 1, engine: 'chromium', passed: false, phase: 'startup', checks: [], errors: [],
        scope: 'actual SIGKILL of verified test-owned Chromium group and observed core processes, same-origin persistent-profile OPFS recovery and real same-host RTCDataChannel; STUN disabled; not OS power loss, real disk failure, mobile/Safari or WAN evidence' };
    let server, senderBrowser, senderContext, owned, firstOwned, profileRoot, sender, receiver;
    const executablePath = process.env.CHROMIUM_PATH;
    let retainTestProfile = false;
    let createdAt = 0, oldReceiverId, oldSessionMarker, originalRaw, targetId;
    const install = async page => {
        page.on('pageerror', error => { if (report.errors.length < 20) report.errors.push({ type: errorType(error), phase: report.phase }); });
        await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript',
            body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
        await page.addInitScript(() => {
            window.showSaveFilePicker = undefined; window.__crashStates = {}; window.__crashCompletions = 0;
            window.__freshDocumentMarker = crypto.randomUUID();
            addEventListener('transfer-state', event => { window.__crashStates[event.detail.name] = event.detail;
                if (event.detail.phase === 'complete') window.__crashCompletions++; });
            addEventListener('file-received', () => window.__crashCompletions++);
        });
        await page.goto(server.origin);
        await page.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected'
            && window.ZeydropStreamHash && window.ZeydropRecovery);
        await page.evaluate(() => {
            window.__hashObservation = { handles: 0, workerHandles: 0, mainCalls: 0 }; window.__binaryBytes = 0;
            const hash = window.ZeydropStreamHash, create = hash.create.bind(hash);
            hash._factory = () => { window.__hashObservation.mainCalls++; throw Error('Native Worker is required'); };
            hash.create = () => { const handle = create(); window.__hashObservation.handles++;
                if (handle.backend === 'worker') window.__hashObservation.workerHandles++; return handle; };
            const send = RTCPeer.prototype._send;
            RTCPeer.prototype._send = function(value) { if (typeof value !== 'string') window.__binaryBytes += value.byteLength; return send.call(this, value); };
        });
    };
    const observeRequests = async context => {
        await context.route('**/*', route => {
            const request = route.request();
            if (new URL(request.url()).origin !== server.origin) { report.network.externalApplicationRequests++; return route.abort(); }
            if (!['GET','HEAD'].includes(request.method()) || request.postDataBuffer()) { report.network.uploadAttempts++; return route.abort(); }
            return route.continue();
        });
    };
    const pair = async () => {
        await sender.locator('#createRoomBtn').click();
        await sender.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        await openJoin(receiver); await receiver.locator('#roomInput').fill(await sender.locator('#inviteUrl').inputValue());
        await receiver.locator('#roomBtn').click();
        for (const page of [sender, receiver]) await page.waitForFunction(() => {
            const p = [...zeydrop.peers.peers.values()][0]; return p?._path?.direct && p._remoteHello && p._code && !p._verified;
        }, null, { timeout: 40000 });
        const codes = await Promise.all([sender, receiver].map(page => page.locator('.security-code').innerText()));
        assert.equal(codes[0], codes[1]);
        const paths = await Promise.all([sender, receiver].map(page => page.evaluate(() => {
            const p = [...zeydrop.peers.peers.values()][0]._path;
            return { direct: p.direct, protocol: p.protocol, localType: p.localType, remoteType: p.remoteType };
        })));
        assert.ok(paths.every(p => p.direct && p.protocol === 'udp' && p.localType !== 'relay' && p.remoteType !== 'relay'));
        for (const page of [sender, receiver]) { assert.equal(await page.locator('x-peer input[type=file]').isDisabled(), true); await page.locator('.verify-peer').click(); }
        return paths;
    };
    try {
        await fs.mkdir('test-results', { recursive: true });
        profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-process-crash-'));
        const profile = path.join(profileRoot, 'receiver'); await fs.mkdir(profile);
        server = await startDev(0);
        report.network = { scope: 'application page/context requests and actual signaling; not all browser-internal background traffic',
            uploadAttempts: 0, externalApplicationRequests: 0, signalingMessages: 0, signalingBytes: 0, fileDataObserved: false };
        const message = server.signaling.message.bind(server.signaling);
        server.signaling.message = (peer, raw) => {
            const text = String(raw); report.network.signalingMessages++; report.network.signalingBytes += Buffer.byteLength(text);
            if ([name, marker, expectedPrefix, expectedFull].some(value => text.includes(value))) report.network.fileDataObserved = true;
            return message(peer, raw);
        };
        senderBrowser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
        senderContext = await senderBrowser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
        await observeRequests(senderContext); sender = await senderContext.newPage(); await install(sender);
        owned = await OwnedChromiumProcess.launch(chromium, profile, { executablePath }); firstOwned = owned;
        report.browserVersion = owned.browser.version();
        assert.ok(owned.context.pages().every(page => page.url() === 'about:blank'), 'fresh owned profile starts without restored application pages');
        await observeRequests(owned.context); receiver = await owned.context.newPage(); await install(receiver);
        oldReceiverId = await receiver.evaluate(() => zeydrop.server._peerId);
        oldSessionMarker = await receiver.evaluate(() => window.__freshDocumentMarker);
        report.initialPaths = await pair(); createdAt = Date.now();
        report.phase = 'native-write-before-kill';
        await receiver.evaluate(() => {
            window.__processCrash = { target: null, committedRaw: null, written: 0, held: false, controls: [], storageRetireCalls: 0 };
            const probe = window.__processCrash, write = ZeydropDurableSink.prototype.write;
            ZeydropDurableSink.prototype.write = async function(...args) {
                await write.apply(this, args);
                if (this.id === probe.target) {
                    probe.written = this.size;
                    if (this.size === 1048576 + 16384) { probe.held = true; await new Promise(() => {}); }
                }
            };
            const checkpoint = ZeydropDurableSink.prototype.checkpoint;
            ZeydropDurableSink.prototype.checkpoint = async function(...args) {
                const value = await checkpoint.apply(this, args);
                if (this.id === probe.target && value === 1048576 && !probe.committedRaw) {
                    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
                    probe.committedRaw = await (await (await dir.getFileHandle(this.id + '.json')).getFile()).text();
                }
                return value;
            };
            const request = window.ZeydropRecovery.request.bind(window.ZeydropRecovery);
            window.ZeydropRecovery.request = (type, ...args) => {
                if (args[0] === probe.target && ['park','releaseCommitted','erase','finish'].includes(type)) probe.storageRetireCalls++;
                return request(type, ...args);
            };
            const send = RTCPeer.prototype.sendJSON;
            RTCPeer.prototype.sendJSON = function(msg) {
                if (msg.id === probe.target && probe.controls.length < 128) probe.controls.push({ type: msg.type, offset: msg.offset ?? null });
                return send.call(this, msg);
            };
        });
        const file = { name, mimeType: 'application/octet-stream', buffer: bytes };
        await sender.locator('x-peer input[type=file]').setInputFiles(file);
        await receiver.locator('#fileOfferDialog[show]').waitFor();
        targetId = await receiver.evaluate(() => {
            const id = [...zeydrop.peers.peers.values()][0]._incoming.meta.id; window.__processCrash.target = id; return id;
        });
        assert.equal(await sender.evaluate(() => window.__binaryBytes), 0);
        await openRecovery(receiver); await receiver.locator('#durableLocalReceive').check(); await receiver.locator('#acceptFileOffer').click();
        await receiver.waitForFunction(() => window.__processCrash.held && window.__processCrash.committedRaw, null, { timeout: 60000 });
        const before = await receiver.evaluate(() => ({ ...window.__processCrash, completions: window.__crashCompletions }));
        originalRaw = before.committedRaw; const original = JSON.parse(originalRaw);
        assert.equal(before.written, prefix + chunk); assert.equal(original.offset, prefix); assert.equal(original.prefixSha256, expectedPrefix);
        assert.equal(before.completions, 0); assert.equal(before.storageRetireCalls, 0);
        assert.ok(before.controls.some(msg => msg.type === 'ack' && msg.offset === prefix));
        assert.ok(before.controls.every(msg => msg.type !== 'complete' && (msg.type !== 'ack' || msg.offset <= prefix)));
        report.beforeCrash = { nativeAppendAcknowledgedBytes: before.written, committedOffset: original.offset,
            committedSha256: original.prefixSha256, gracefulStorageRetireCalls: before.storageRetireCalls,
            completionEvents: before.completions, uncheckpointedBytes: chunk };
        report.phase = 'owned-native-process-kill'; report.crash = await owned.crash();
        assert.equal(await sender.evaluate(() => document.readyState), 'complete'); report.senderRemainedAlive = true;
        report.checks.push('the real native OPFS append is held before hash/ACK; the verified owned browser process group is SIGKILLed without park, close, or graceful page exit');

        report.phase = 'same-profile-fresh-process';
        owned = await OwnedChromiumProcess.launch(chromium, profile, { executablePath });
        assert.notEqual(owned.identity.start + ':' + owned.child.pid, firstOwned.identity.start + ':' + firstOwned.child.pid);
        assert.notEqual(owned.endpointToken, firstOwned.endpointToken);
        assert.ok(owned.context.pages().every(page => page.url() === 'about:blank'), 'restart must not automatically restore application pages');
        await observeRequests(owned.context); receiver = await owned.context.newPage(); await install(receiver);
        const newId = await receiver.evaluate(() => zeydrop.server._peerId);
        assert.notEqual(newId, oldReceiverId); assert.notEqual(await receiver.evaluate(() => window.__freshDocumentMarker), oldSessionMarker);
        const inspection = await receiver.evaluate(async id => {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-recovery-v1');
            const raw = await (await (await dir.getFileHandle(id + '.json')).getFile()).text();
            const part = await (await dir.getFileHandle(id + '.part')).getFile();
            return { raw, meta: JSON.parse(raw), partSize: part.size,
                noAutomaticRoom: zeydrop.server._desiredRoomId === null, noInheritedCheckpointObject: window.__processCrash === undefined };
        }, targetId);
        assert.equal(inspection.raw, originalRaw); assert.equal(inspection.meta.offset, prefix);
        assert.equal(inspection.meta.prefixSha256, expectedPrefix); assert.equal(inspection.meta.phase, 'partial');
        assert.ok(inspection.partSize >= prefix && inspection.partSize <= prefix + chunk);
        assert.equal(inspection.noAutomaticRoom, true); assert.equal(inspection.noInheritedCheckpointObject, true);
        report.afterCrash = { samePersistentProfile: true, newOwnedProcessAndEndpoint: true, freshPeerIdentity: true,
            freshDocument: true, metadataByteIdentical: inspection.raw === originalRaw,
            committedOffset: inspection.meta.offset, committedSha256: inspection.meta.prefixSha256, physicalBytes: inspection.partSize,
            uncheckpointedTailMayPersistOrVanish: true, noAutomaticRoom: inspection.noAutomaticRoom };
        await receiver.evaluate(() => {
            window.__freshRestore = { calls: 0 }; const restore = window.ZeydropRecovery.restore.bind(window.ZeydropRecovery);
            window.ZeydropRecovery.restore = async (...args) => {
                const result = await restore(...args); window.__freshRestore.calls++;
                const value = await result.snapshot.arrayBuffer();
                const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
                    .map(byte => byte.toString(16).padStart(2, '0')).join('');
                window.__freshRestore = { calls: window.__freshRestore.calls, offset: result.offset,
                    snapshotBytes: result.snapshot.size, prefixSha256: result.prefixSha256, independentlyReadSha256: sha256 };
                return result;
            };
        });
        assert.equal(await receiver.evaluate(() => window.__freshRestore.calls), 0);
        report.checks.push('after actual process exit, the same profile opens with fresh process/document/identity; committed metadata survives unchanged and the unhashed tail is not advertised as committed');
        await sender.locator('#leaveRoomBtn').click();
        const remaining = 5500 - (Date.now() - createdAt); if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
        report.phase = 'fresh-pair-and-explicit-restore'; report.newPaths = await pair();
        await sender.evaluate(() => { window.__binaryBytes = 0; });
        await sender.locator('x-peer input[type=file]').setInputFiles(file);
        await receiver.locator('#fileOfferDialog[show]').waitFor();
        await openRecovery(receiver); await receiver.locator('#localResumeOption').waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(await receiver.locator('#useLocalCheckpoint').isChecked(), false);
        const stateBefore = await receiver.evaluate(() => {
            const state = [...zeydrop.peers.peers.values()][0]._incoming;
            return { offset: state.offset, sinkAttached: !!state.sink, restoreCalls: window.__freshRestore.calls };
        });
        assert.deepEqual(stateBefore, { offset: 0, sinkAttached: false, restoreCalls: 0 });
        assert.equal(await sender.evaluate(() => window.__binaryBytes), 0);
        await receiver.locator('#useLocalCheckpoint').check(); await receiver.locator('#acceptFileOffer').click();
        await sender.waitForFunction(name => window.__crashStates[name]?.phase === 'complete', name, { timeout: 120000 });
        await receiver.locator('#receiveDialog[show]').waitFor();
        const download = receiver.waitForEvent('download'); await receiver.locator('#download').click();
        const saved = await fs.readFile(await (await download).path()); assert.equal(saved.length, bytes.length); assert.equal(digest(saved), expectedFull);
        report.resume = await receiver.evaluate(() => window.__freshRestore);
        assert.equal(report.resume.calls, 1); assert.equal(report.resume.offset, prefix); assert.equal(report.resume.snapshotBytes, prefix);
        assert.equal(report.resume.prefixSha256, expectedPrefix); assert.equal(report.resume.independentlyReadSha256, expectedPrefix);
        report.resume.sentTailBytes = await sender.evaluate(() => window.__binaryBytes);
        assert.equal(report.resume.sentTailBytes, bytes.length - prefix);
        report.resume.finalBytes = saved.length; report.resume.finalSha256 = digest(saved);
        report.liveHashes = await Promise.all([sender, receiver].map(page => page.evaluate(() => ({ ...window.__hashObservation, active: window.ZeydropStreamHash._handles.size }))));
        assert.ok(report.liveHashes.every(value => value.handles > 0 && value.handles === value.workerHandles && value.mainCalls === 0 && value.active === 0));
        report.checks.push('new invitation, safety-code clicks, file reselection and explicit checkpoint consent truncate/revalidate the old prefix and send exactly the remaining tail; downloaded full SHA matches independent Node crypto');
        assert.equal(report.network.uploadAttempts, 0); assert.equal(report.network.externalApplicationRequests, 0);
        assert.equal(report.network.fileDataObserved, false); assert.deepEqual(report.errors, []);
        for (const record of await receiver.evaluate(() => window.ZeydropRecovery.list())) await receiver.evaluate(id => window.ZeydropRecovery.erase(id), record.id);
        report.phase = 'complete'; report.passed = true;
    } catch (error) {
        retainTestProfile ||= error?.retainTestProfile === true;
        report.failure = errorType(error);
        const safeCodes = ['runtime-operation-denied','browser-executable-unavailable','browser-startup-failed','browser-endpoint-timeout',
            'owned-process-identity-mismatch','owned-process-group-mismatch','observed-browser-core-outside-owned-group',
            'owned-browser-family-still-live','owned-browser-cleanup-failed','owned-browser-exit-timeout','owned-browser-disconnect-timeout'];
        if (safeCodes.includes(error?.code)) report.failureCode = error.code;
        const line = String(error?.stack || '').match(/browser-crash-recovery\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        if (/Executable doesn't exist/.test(String(error?.message))) report.failureCode = 'browser-executable-unavailable';
        else if (/Operation not permitted|\bEPERM\b/.test(String(error?.message))) report.failureCode = 'runtime-operation-denied';
        throw error;
    } finally {
        const cleanupFailures = [];
        try {
            // Raw CDP close alone does not own the OS process. Attempt every
            // cleanup independently; a failed receiver cleanup must not leave
            // the sender or local test server running indefinitely.
            try { await owned?.close(); } catch (error) { retainTestProfile = true; cleanupFailures.push(error); }
            try { await senderContext?.close(); } catch (error) { cleanupFailures.push(error); }
            try { await senderBrowser?.close(); } catch (error) { cleanupFailures.push(error); }
            try { await server?.close(); } catch (error) { cleanupFailures.push(error); }
            if (profileRoot && !retainTestProfile) {
                try { await fs.rm(profileRoot, { recursive: true, force: true }); report.testProfileRemoved = true; }
                catch (error) { cleanupFailures.push(error); }
            } else if (profileRoot) report.testProfileRetainedAfterUnsafeCleanup = true;
            if (cleanupFailures.length) {
                report.passed = false; report.phase = 'cleanup-failed'; report.failure = errorType(cleanupFailures[0]);
                report.failureCode = 'owned-browser-cleanup-failed';
                throw cleanupFailures[0];
            }
        } finally {
            await fs.mkdir('test-results', { recursive: true });
            await fs.writeFile('test-results/browser-crash-recovery-chromium.json', JSON.stringify(report, null, 2) + '\n');
        }
    }

    console.log('Native browser process crash evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Browser process crash test failed:', errorType(error)); process.exitCode = 1; });
