'use strict';
const { openJoin, openMore } = require('./workspace-ui-helpers.cjs');
// Actual UI, two isolated browser contexts and RTCDataChannel. Same host,
// STUN disabled: this is not public NAT, Safari hardware or picker evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const { installRtcTrace, rtcEndpointSnapshot } = require('./rtc-diagnostics.cjs');

const KEY = 'zeydrop-send-queue-v1';
const errorType = error => ['TimeoutError','AssertionError','TypeError','RangeError','QuotaExceededError'].includes(error?.name) ? error.name : 'Error';
async function main() {
    const engineName = process.env.BROWSER_TYPE || 'chromium';
    if (!['chromium','firefox','webkit'].includes(engineName)) throw new TypeError('Unknown browser engine');
    const engine = { chromium, firefox, webkit }[engineName];
    const report = { schema: 1, engine: engineName, network: 'same-host, two contexts, STUN disabled',
        scope: 'opt-in metadata queue, full-hash reselect and manually authorized file transfer; not WAN or real hardware',
        queueFlowExecuted: false, checks: [], errors: [], passed: false };
    const contexts = [], pages = [];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-send-queue-'));
    let server, browser;
    try {
        await fs.mkdir('test-results', { recursive: true });
        server = await startDev(0);
        browser = await engine.launch({ headless: true });
        report.browserVersion = browser.version();
        const bodies = [
            Buffer.concat([Buffer.from('ZEYDROP_QUEUE_BODY_ONE_'), crypto.randomBytes(32771)]),
            Buffer.concat([Buffer.from('ZEYDROP_QUEUE_BODY_TWO_'), crypto.randomBytes(49159)])
        ];
        const names = ['待发 & <一>.bin', 'queue-second.bin'];
        const files = names.map(name => path.join(directory, name));
        const hashes = bodies.map(body => crypto.createHash('sha256').update(body).digest('hex'));
        const modified = new Date('2025-01-02T03:04:05.000Z');
        async function writeFile(index, bytes) { await fs.writeFile(files[index], bytes); await fs.utimes(files[index], modified, modified); }
        for (let index = 0; index < files.length; index++) await writeFile(index, bodies[index]);
        const traffic = { messages: 0, bytes: 0, fileDataObserved: false };
        const originalMessage = server.signaling.message.bind(server.signaling);
        server.signaling.message = (peer, raw) => {
            traffic.messages++; traffic.bytes += Buffer.byteLength(raw);
            const text = raw.toString();
            if ([...names, ...hashes, 'ZEYDROP_QUEUE_BODY_ONE_', 'ZEYDROP_QUEUE_BODY_TWO_'].some(value => text.includes(value)))
                traffic.fileDataObserved = true;
            return originalMessage(peer, raw);
        };
        for (let index = 0; index < 2; index++) {
            const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1080 } });
            contexts.push(context);
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => {
                report.errors.push(errorType(error));
                const source = String(error?.stack || '').match(/scripts\/(ui|network|transfer|send-queue-store)\.js(?:\?v=[a-f0-9]+)?:(\d+):(\d+)/);
                report.pageErrors ||= [];
                if (report.pageErrors.length < 20) report.pageErrors.push({ type: errorType(error), phase: report.phase || 'startup',
                    ...(source ? { script: source[1] + '.js', line: Number(source[2]), column: Number(source[3]) } : {}) });
            });
            await page.addInitScript(installRtcTrace);
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript',
                body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.addInitScript(() => {
                window.showSaveFilePicker = undefined; // Exercise the real bounded Blob/save barrier.
                window.__queueTransfers = {}; window.__queueOffers = 0; window.__queueCompleted = 0;
                window.addEventListener('transfer-state', event => { window.__queueTransfers[event.detail.name] = event.detail; });
                window.addEventListener('file-offer', () => { window.__queueOffers++; });
                window.addEventListener('send-file-complete', () => { window.__queueCompleted++; });
                window.addEventListener('change', event => {
                    if (event.target?.id !== 'sendQueueFiles') return;
                    window.__lastQueueSelection = [...event.target.files].map(file => ({ name: file.name, size: file.size,
                        mime: file.type || 'application/octet-stream', lastModified: file.lastModified }));
                }, true);
            });
        }
        const [sender, receiver] = pages;
        const queue = () => sender.evaluate(() => window.ZeydropSendQueue.load());
        async function queueCount(count) {
            await sender.waitForFunction(async expected => ((await window.ZeydropSendQueue.load())?.files.length || 0) === expected,
                count, { timeout: 15000 });
        }
        async function openQueue() {
            await openMore(sender);
            await sender.locator('#sendQueueSection').waitFor({ state: 'visible' });
            if (!await sender.locator('#sendQueueSection').evaluate(element => element.open))
                await sender.locator('#sendQueueSection summary').click();
        }
        async function choose(button, selected = files) {
            const selection = sender.waitForEvent('filechooser');
            await sender.locator(button).click();
            await (await selection).setFiles(selected);
        }
        async function waitPeer(page) {
            await page.waitForFunction(() => {
                const peer = [...zeydrop.peers.peers.values()][0];
                return peer?._path?.direct && peer?._protocolReady() && peer?._code && peer._isConnected();
            }, null, { timeout: 40000 });
        }
        async function verifyPair() {
            await Promise.all(pages.map(waitPeer));
            const codes = await Promise.all(pages.map(page => page.locator('.security-code').innerText()));
            assert.ok(codes[0]); assert.equal(codes[0], codes[1], 'both endpoints must display the same DTLS-bound code');
            for (const page of pages) {
                assert.equal(await page.evaluate(() => [...zeydrop.peers.peers.values()][0]._verified), false);
                assert.equal(await page.locator('x-peer input[type=file]').isDisabled(), true, 'ordinary file selection also requires safety-code verification');
                await page.locator('.verify-peer').click();
                await page.waitForFunction(() => [...zeydrop.peers.peers.values()][0]?._verified === true);
                await page.waitForFunction(() => !document.querySelector('x-peer input[type=file]').disabled);
                const route = await page.evaluate(() => [...zeydrop.peers.peers.values()][0]._path);
                assert.equal(route.direct, true); assert.equal(route.status, 'selected');
                assert.equal(route.protocol, 'udp'); assert.notEqual(route.localType, 'relay'); assert.notEqual(route.remoteType, 'relay');
            }
        }
        await sender.goto(server.origin);
        await sender.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        await sender.waitForFunction(() => !!window.ZeydropSendQueue);
        report.capabilities = await sender.evaluate(() => ({ webLocks: typeof navigator.locks?.request === 'function',
            storeSupported: window.ZeydropSendQueue?.supported === true, hash: typeof window.ZeydropHash?.create === 'function',
            secureUuid: typeof crypto.randomUUID === 'function', textEncoder: typeof TextEncoder === 'function' }));
        assert.equal(report.capabilities.hash, true); assert.equal(report.capabilities.secureUuid, true); assert.equal(report.capabilities.textEncoder, true);
        if (report.capabilities.webLocks) {
            assert.equal(report.capabilities.storeSupported, true, 'available prerequisites must enable the metadata queue');
            report.queueCapability = 'supported';
            await openQueue();
            assert.equal(await sender.locator('#rememberSendQueue').isChecked(), false);
            assert.equal(await sender.locator('#saveSendQueue').isDisabled(), true, 'metadata persistence must require explicit opt-in');
            assert.equal(await queue(), null);
        } else {
            assert.equal(report.capabilities.storeSupported, false);
            assert.notEqual(await sender.locator('#sendQueueSection').getAttribute('hidden'), null);
            report.queueCapability = 'unsupported'; report.unsupportedReason = 'web-locks-unavailable';
        }
        await sender.locator('#createRoomBtn').click();
        await sender.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        const firstInvitation = await sender.locator('#inviteUrl').inputValue();
        report.phase = 'initial-pair-verification';
        await receiver.goto(firstInvitation); await verifyPair();
        if (report.queueCapability === 'unsupported') {
            // A missing capability is not a passed queue test. Verify that the
            // feature stays hidden while ordinary, authorized P2P still works.
            assert.notEqual(await receiver.locator('#sendQueueSection').getAttribute('hidden'), null);
            await sender.locator('x-peer input[type=file]').setInputFiles(files[0]);
            await receiver.locator('#fileOfferDialog[show]').waitFor();
            assert.equal(await receiver.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.offset), 0);
            await receiver.locator('#acceptFileOffer').click();
            await receiver.locator('#receiveDialog[show]').waitFor();
            await sender.waitForFunction(name => window.__queueTransfers[name]?.phase === 'complete', names[0]);
            const downloaded = receiver.waitForEvent('download'); await receiver.locator('#download').click();
            const disk = await fs.readFile(await (await downloaded).path());
            assert.equal(disk.length, bodies[0].length);
            assert.equal(crypto.createHash('sha256').update(disk).digest('hex'), hashes[0]);
            assert.equal(await sender.evaluate(key => localStorage.getItem(key), KEY), null);
            assert.equal(traffic.fileDataObserved, false); assert.deepEqual(report.errors, []);
            report.checks.push('Web Locks unavailable: persistent queue hidden on both endpoints; queue flow not executed');
            report.checks.push('ordinary file selection still requires real selected UDP path, matching safety codes, receiver acceptance and independent downloaded SHA-256');
            report.normalFileTransferPassed = true; report.signaling = traffic; report.transferredBytes = bodies[0].length; report.passed = true;
            console.log('Send-queue browser evidence:', JSON.stringify(report)); return;
        }
        report.queueFlowExecuted = true;
        report.phase = 'first-save-user-consent';
        const originalSession = await sender.evaluate(() => zeydrop.server._peerId);
        await openQueue(); await sender.locator('#rememberSendQueue').check();
        const saveStarted = Date.now();
        await choose('#saveSendQueue'); await queueCount(2);
        report.phase = 'first-save-metadata-validation';
        await sender.waitForFunction(() => !zeydrop.sendQueue.busy);
        report.hashTiming = { fileCount: files.length, bytesPerPass: bodies.reduce((sum, bytes) => sum + bytes.length, 0),
            saveWallMs: Date.now() - saveStarted,
            configuredChunkBytes: await sender.evaluate(() => ZeydropSendQueueStore.HASH_CHUNK),
            scope: 'small synthetic files on one CI host; wall time includes file chooser/UI/IPC; not CPU, RSS, mobile hardware or WAN performance' };
        assert.equal(report.hashTiming.configuredChunkBytes, 256 * 1024);
        const saved = await queue();
        assert.deepEqual(saved.files.map(file => file.name), names);
        assert.deepEqual(saved.files.map(file => file.sha256), hashes, 'persisted hashes must match independent Node SHA-256');
        const originalMetadata = saved.files.map(({ name, size, mime, lastModified }) => ({ name, size, mime, lastModified }));
        assert.deepEqual(await sender.evaluate(() => window.__lastQueueSelection), originalMetadata);
        const localText = await sender.evaluate(key => localStorage.getItem(key), KEY);
        assert.ok(localText && !localText.includes('ZEYDROP_QUEUE_BODY_ONE_') && !localText.includes('ZEYDROP_QUEUE_BODY_TWO_'));
        assert.equal(await receiver.evaluate(() => window.__queueOffers), 0, 'saving metadata must never send a file offer');
        report.checks.push('explicit opt-in persists only metadata and independently matching complete SHA-256 for two files');

        report.phase = 'refresh-manifest';
        await sender.reload(); await sender.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        await openQueue(); await queueCount(2);
        assert.notEqual(await sender.evaluate(() => zeydrop.server._peerId), originalSession, 'refresh must create a new signaling identity');
        assert.deepEqual((await queue()).files, saved.files);
        assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true, 'refresh must not restore File references or authorization');
        assert.equal(await sender.locator('#rememberSendQueue').isChecked(), false, 'the opt-in control is not a stored send permission');
        await sender.setViewportSize({ width: 390, height: 844 });
        await sender.locator('#sendQueueSection').scrollIntoViewIfNeeded();
        report.mobileLayout = await sender.evaluate(() => {
            const queue = document.querySelector('#sendQueueSection');
            return { viewportWidth: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth,
                queueOverflow: queue.scrollWidth > queue.clientWidth };
        });
        assert.equal(report.mobileLayout.pageOverflow, false); assert.equal(report.mobileLayout.queueOverflow, false);
        report.mobileLayout.screenshot = 'send-queue-mobile-' + engineName + '.png';
        // Component-only capture avoids invitation URLs, QR codes and safety codes.
        await sender.locator('#sendQueueSection').screenshot({ path: 'test-results/' + report.mobileLayout.screenshot });
        if (engineName === 'chromium') await fs.copyFile('test-results/' + report.mobileLayout.screenshot, 'test-results/send-queue-mobile.png');
        await sender.setViewportSize({ width: 1440, height: 1080 });
        report.checks.push('expanded stored queue has no horizontal page/component overflow at a 390px viewport; screenshot is not mobile hardware evidence');
        await receiver.locator('#leaveRoomBtn').click();
        await receiver.waitForFunction(() => zeydrop.server._desiredRoomId === null && zeydrop.peers.peers.size === 0);
        await sender.locator('#createRoomBtn').click();
        await sender.waitForFunction(previous => {
            const next = document.querySelector('#inviteUrl').value; return next.includes('#room=') && next !== previous;
        }, firstInvitation);
        await openJoin(receiver); await receiver.locator('#roomInput').fill(await sender.locator('#inviteUrl').inputValue());
        await receiver.locator('#roomBtn').click();
        await Promise.all(pages.map(waitPeer));
        assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true);
        assert.equal(await receiver.evaluate(() => window.__queueOffers), 0);
        report.checks.push('sender refresh preserves metadata but discards File bindings and old pairing identity; a new invitation does not send files');

        // Same name/size/MIME/mtime, different bytes: this must reach full hashing,
        // rather than passing/failing only because file metadata is different.
        report.phase = 'reselect-originals';
        const wrong = Buffer.from(bodies[0]); wrong[wrong.length - 1] ^= 0xff;
        await openQueue(); await writeFile(0, wrong); await choose('#reselectSendQueue');
        await sender.waitForFunction(() => /不一致|不匹配|未恢复任何|校验失败/.test(document.querySelector('#sendQueueStatus').textContent));
        assert.deepEqual(await sender.evaluate(() => window.__lastQueueSelection), originalMetadata);
        assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true);
        assert.deepEqual((await queue()).files, saved.files, 'a failed reselect cannot rewrite the original manifest');
        assert.equal(await receiver.evaluate(() => window.__queueOffers), 0);
        report.checks.push('same-metadata different-content original is rejected by full SHA-256 without binding or sending any file');
        // Selection order can differ from the original manifest. Only the
        // content-verified File references may be reordered into that manifest.
        await writeFile(0, bodies[0]); const reselectStarted = Date.now();
        await choose('#reselectSendQueue', [...files].reverse());
        await sender.waitForFunction(() => zeydrop.sendQueue?.boundFiles?.length === 2 && !zeydrop.sendQueue.busy);
        report.hashTiming.reselectWallMs = Date.now() - reselectStarted;
        report.hashTiming.totalHashBytes = report.hashTiming.bytesPerPass * 2;
        report.hashTiming.countedOperations = 'successful save and correct reselect only; deliberate wrong-file and quota passes excluded';
        assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true,
            'even correctly rebound original files cannot send before fresh identity verification');
        assert.equal(await receiver.evaluate(() => window.__queueOffers), 0, 'successful reselect is not permission to send');
        await verifyPair();
        await sender.waitForFunction(() => !document.querySelector('#sendStoredQueue').disabled);
        assert.equal(await sender.locator('#moreActions').evaluate(element => element.open), false,
            'confirming the safety code closes the More menu');
        report.checks.push('correct originals selected in reverse order are rebound only after full hashes match; fresh matching safety codes still gate manual sending');

        await sender.evaluate(() => {
            window.__queueBinarySent = 0;
            const send = RTCPeer.prototype._send;
            RTCPeer.prototype._send = function(data) {
                if (typeof data !== 'string') window.__queueBinarySent += data.byteLength;
                return send.call(this, data);
            };
        });
        await receiver.evaluate(firstName => {
            const finish = ReceiveSink.prototype.finish;
            window.__queueFinishEntered = false;
            ReceiveSink.prototype.finish = async function(...args) {
                if (this.meta.name === firstName) {
                    window.__queueFinishEntered = true;
                    await new Promise(resolve => { window.__releaseQueueFinish = resolve; });
                }
                return finish.apply(this, args);
            };
        }, names[0]);
        report.phase = 'manual-queue-transfer';
        await openQueue();
        await sender.locator('#sendStoredQueue').click();
        for (let index = 0; index < files.length; index++) {
            await receiver.locator('#fileOfferDialog[show]').waitFor();
            const incoming = await receiver.evaluate(() => {
                const state = [...zeydrop.peers.peers.values()][0]._incoming;
                return { name: state.meta.name, offset: state.offset };
            });
            assert.equal(incoming.name, names[index]); assert.equal(incoming.offset, 0, 'receiver must authorize each file before any bytes');
            assert.equal(await sender.evaluate(() => window.__queueBinarySent), bodies.slice(0, index).reduce((sum, bytes) => sum + bytes.length, 0));
            await receiver.locator('#acceptFileOffer').click();
            if (index === 0) {
                await receiver.waitForFunction(() => window.__queueFinishEntered === true);
                await sender.waitForFunction(() => [...zeydrop.peers.peers.values()][0]?._outgoing?.phase === 'verifying');
                assert.equal((await queue()).files.length, 2, '100% bytes cannot delete entries before final verified completion');
                assert.equal(await sender.evaluate(() => window.__queueCompleted), 0);
                await receiver.evaluate(() => window.__releaseQueueFinish());
            }
            await receiver.locator('#receiveDialog[show]').waitFor();
            await sender.waitForFunction(name => window.__queueTransfers[name]?.phase === 'complete', names[index]);
            await queueCount(files.length - index - 1);
            const remaining = await queue();
            assert.deepEqual(remaining?.files.map(file => file.entryId) || [], saved.files.slice(index + 1).map(file => file.entryId));
            assert.ok((await receiver.locator('#fileSize').innerText()).includes(hashes[index]));
            if (index === 0) {
                await sender.waitForFunction(() => {
                    const peer = [...zeydrop.peers.peers.values()][0];
                    return !peer._outgoing && !!peer._queueWaitId && peer._filesQueue.length === 1;
                });
                assert.equal(await receiver.evaluate(() => window.__queueOffers), 1, 'second offer must wait for the first Blob to be saved/discarded');
                assert.equal(await receiver.locator('#fileOfferDialog[show]').count(), 0);
            }
            const downloaded = receiver.waitForEvent('download');
            await receiver.locator('#download').click();
            const disk = await fs.readFile(await (await downloaded).path());
            assert.equal(disk.length, bodies[index].length);
            assert.equal(crypto.createHash('sha256').update(disk).digest('hex'), hashes[index]);
        }
        assert.equal(await queue(), null);
        assert.equal(await sender.evaluate(() => window.__queueCompleted), 2);
        assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true);
        assert.equal(await sender.evaluate(() => window.__queueBinarySent), bodies.reduce((sum, bytes) => sum + bytes.length, 0));
        report.checks.push('manual send requires explicit acceptance per file, final verified completion removes one entry at a time, and Blob saving gates the next offer');
        report.checks.push('both downloaded files independently match local Node SHA-256 and byte lengths');

        // Storage failures remain local UI failures and cannot authorize a send.
        report.phase = 'storage-quota';
        await sender.evaluate(key => {
            const setItem = Storage.prototype.setItem;
            window.__queueSetItem = setItem; window.__queueQuotaFailures = 0;
            Storage.prototype.setItem = function(name, value) {
                if (name === key) { window.__queueQuotaFailures++; throw new DOMException('Synthetic test quota', 'QuotaExceededError'); }
                return setItem.call(this, name, value);
            };
        }, KEY);
        await openQueue(); await sender.locator('#rememberSendQueue').check(); await choose('#saveSendQueue');
        await sender.waitForFunction(() => window.__queueQuotaFailures === 1);
        await sender.waitForFunction(() => /空间|存储|失败|无法/.test(document.querySelector('#sendQueueStatus').textContent));
        await sender.evaluate(() => { Storage.prototype.setItem = window.__queueSetItem; delete window.__queueSetItem; });
        assert.equal(await queue(), null); assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true);
        assert.equal(await receiver.evaluate(() => window.__queueOffers), 2);
        report.checks.push('synthetic localStorage quota failure is visible and never binds files or sends an offer');

        report.phase = 'corrupt-metadata';
        await sender.locator('#moreToggle').press('Escape');
        await sender.locator('#leaveRoomBtn').click(); await receiver.locator('#leaveRoomBtn').click();
        await sender.evaluate(key => localStorage.setItem(key, '{invalid-queue'), KEY);
        await sender.reload(); await openQueue();
        await sender.waitForFunction(() => /损坏|不可用|无法读取/.test(document.querySelector('#sendQueueStatus').textContent));
        assert.equal(await sender.evaluate(key => localStorage.getItem(key), KEY), '{invalid-queue', 'corrupt metadata must await an explicit deletion choice');
        assert.equal(await sender.locator('#sendStoredQueue').isDisabled(), true);
        sender.once('dialog', dialog => dialog.accept());
        await sender.locator('#clearSendQueue').click();
        await sender.waitForFunction(key => localStorage.getItem(key) === null, KEY);
        assert.equal(await queue(), null);
        report.checks.push('corrupt metadata remains unsendable and is deleted only after an explicit clear action');
        assert.equal(traffic.fileDataObserved, false, 'file names, complete hashes and body sentinels must never enter WebSocket signaling');
        report.signaling = traffic; report.transferredBytes = bodies.reduce((sum, bytes) => sum + bytes.length, 0);
        assert.deepEqual(report.errors, []);
        report.passed = true; report.phase = 'complete';
    } catch (error) {
        report.failure = errorType(error); report.lastCompletedCase = report.checks.at(-1) || 'startup';
        // Source coordinates and identifier-only error hints locate a failing
        // assertion/API without logging raw URLs, tokens, paths or file names.
        const location = String(error?.stack || '').match(/send-queue-browser\.cjs:(\d+):(\d+)/);
        if (location) report.failureSource = { line: Number(location[1]), column: Number(location[2]) };
        const hint = String(error?.message || '').match(/(?:reading '([A-Za-z_$][\w$]*)'|\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*) is not a function)/);
        if (hint) report.failureIdentifier = (hint[1] || hint[2]).slice(0, 80);
        report.debug = await Promise.all(pages.map(page => page.evaluate(rtcEndpointSnapshot, engineName).catch(() => ({ unavailable: true }))));
        throw error;
    } finally {
        try {
            await fs.mkdir('test-results', { recursive: true });
            await fs.writeFile('test-results/send-queue-browser-' + engineName + '.json', JSON.stringify(report, null, 2) + '\n');
        } finally {
            await Promise.allSettled(contexts.map(context => context.close()));
            await Promise.allSettled([browser?.close(), server?.close(), fs.rm(directory, { recursive: true, force: true })]);
        }
    }
    console.log('Send-queue browser evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Send-queue browser test failed:', errorType(error)); process.exitCode = 1; });
