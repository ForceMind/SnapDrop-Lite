'use strict';
const { openJoin, openMore } = require('./workspace-ui-helpers.cjs');
// Real two-browser-context DataChannel tests. No external NAT claims are made.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os');
const { chromium, firefox, webkit } = require('playwright'); const { startDev } = require('../scripts/dev.cjs');
const { installRtcTrace, rtcEndpointSnapshot } = require('./rtc-diagnostics.cjs');
const { start: startResources } = require('./browser-resources.cjs');
async function main() {
    const server = await startDev(0); const results = { engine: process.env.BROWSER_TYPE || 'chromium', cases: [], network: 'two contexts on the same test host; STUN disabled', errors: [] };
    const engine = { chromium, firefox, webkit }[results.engine];
    const persistent = results.engine === 'chromium' && process.env.LARGE_FILE_TEST === '1';
    const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-e2e-'));
    results.profiles = persistent ? 'two persistent profiles (disk-backed OPFS)' : 'two ephemeral contexts';
    const launchOptions = { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] } : {}) };
    let browser = null;
    const contexts = []; const pages = []; const resourceProbes = [];
    await fs.mkdir('test-results', { recursive: true });
    try {
        if (!persistent) browser = await engine.launch(launchOptions);
        for (let i = 0; i < 2; i++) {
            const contextOptions = { acceptDownloads: true, viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' };
            const context = persistent ? await engine.launchPersistentContext(path.join(profileRoot, String(i)), { ...launchOptions, ...contextOptions }) : await browser.newContext(contextOptions); contexts.push(context);
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => results.errors.push(['TypeError','RangeError','ReferenceError','SyntaxError'].includes(error.name) ? error.name : 'Error'));
            await page.addInitScript(installRtcTrace);
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript', body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.addInitScript(() => {
                window.showSaveFilePicker = undefined; window.__testTransfers = {}; window.__testNotices = [];
                window.addEventListener('transfer-state', event => window.__testTransfers[event.detail.name] = event.detail);
                window.addEventListener('notify-user', event => { window.__testNotices.push(event.detail); if (window.__testNotices.length > 50) window.__testNotices.shift(); });
            });
        }
        const [a, b] = pages;
        await a.goto(server.origin); await a.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        // Fail on any live/prefix hashing fallback while native Workers exist.
        // Independent disk rehashes later deliberately use the Node-checked
        // synchronous implementation and are outside this product hook.
        const instrumentHash = async page => page.evaluate(() => {
            const manager=window.ZeydropStreamHash;
            window.__liveHash={handles:0,mainCalls:0,workerHandles:0};
            manager._factory=()=>{window.__liveHash.mainCalls++;throw Error('Native live hash Worker required');};
            const create=manager.create.bind(manager);
            manager.create=()=>{const hash=create();window.__liveHash.handles++;
                if(hash.backend==='worker')window.__liveHash.workerHandles++;return hash;};
        });
        await instrumentHash(a);
        if (process.env.TEST_CJK_CSS) {
            const base = path.dirname(process.env.TEST_CJK_CSS);
            let css = await fs.readFile(process.env.TEST_CJK_CSS, 'utf8');
            const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]))];
            for (const url of urls) css = css.replaceAll(url, 'data:font/woff2;base64,' + (await fs.readFile(path.resolve(base, url))).toString('base64'));
            await a.addStyleTag({ content: css + '\nbody { font-family: \"Noto Sans SC\",sans-serif !important; }' });
            await a.evaluate(() => document.fonts.ready);
        }
        assert.equal(await a.locator('#createRoomBtn').isVisible(), true);
        assert.equal(await a.locator('#joinRow').isHidden(), true);
        assert.equal(await a.locator('#openTextTools').isHidden(), true);
        assert.equal(server.signaling.rooms.size, 0, 'opening the page does not create an invitation');
        await a.screenshot({ path: 'test-results/desktop-light.png', fullPage: true });
        await a.emulateMedia({ colorScheme: 'dark' }); await a.screenshot({ path: 'test-results/desktop-dark.png', fullPage: true }); await a.emulateMedia({ colorScheme: 'light' });
        await a.setViewportSize({ width: 390, height: 844 }); await a.screenshot({ path: 'test-results/mobile.png', fullPage: true });
        assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow');
        await a.setViewportSize({ width: 1440, height: 1080 });
        await a.locator('#createRoomBtn').click(); await a.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        const invite = await a.locator('#inviteUrl').inputValue(); assert.ok(!invite.includes('?room='));
        await b.goto(invite); await instrumentHash(b);
        for (const page of pages) await page.waitForFunction(() => [...zeydrop.peers.peers.values()][0]?._path?.direct, null, { timeout: 30000 });
        const codes = await Promise.all(pages.map(page => page.locator('.security-code').innerText())); assert.equal(codes[0], codes[1]); console.log('PASS direct connection and DTLS code');
        for (const page of pages) {
            assert.equal(await page.locator('x-peer input').isDisabled(), true);
            assert.equal(await page.locator('.select-files').isHidden(), true);
            await page.locator('.verify-peer').click();
            await page.locator('.select-files').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#pairingArea').isHidden(), true);
            assert.equal(await page.locator('.peer-verification').isHidden(), true);
        }
        const paths = await Promise.all(pages.map(page => page.evaluate(() => [...zeydrop.peers.peers.values()][0]._path)));
        assert.ok(paths.every(info => info.direct && info.protocol === 'udp' && info.localType !== 'relay' && info.remoteType !== 'relay'));
        results.paths = paths; results.cases.push('real UDP DataChannel, selected host path, matching DTLS code');
        // Expiring the invitation must not stop this already sealed pair.
        for (const room of server.signaling.rooms.values()) room.expires=server.signaling.now()-1;
        server.signaling.sweep();
        for (const page of pages) { assert.equal(await page.locator('#inviteQR').isHidden(),true); assert.match(await page.locator('#inviteTitle').innerText(),/已配对/); }
        results.cases.push('sealed pair continues actual file transfers after the invitation deadline');
        const traffic = []; for (const peer of server.signaling.connections.values()) peer.socket.on('message', (bytes, binary) => traffic.push({ binary, text: bytes.toString(), bytes: bytes.length }));
        const file = { name: '闪投 & <视频> PRIVATE_FILE_SENTINEL.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE_FILE_BODY_SENTINEL\n'.repeat(12000)) };
        const chooser = a.waitForEvent('filechooser');
        await a.locator('.select-files').click();
        await (await chooser).setFiles([file, { name: 'queued-after-rejection.txt', mimeType: 'text/plain', buffer: Buffer.from('later') }]);
        await b.locator('#fileOfferDialog[show]').waitFor();
        assert.equal(await b.locator('#offerFileName').textContent(), file.name);
        assert.equal(await b.locator('#durableLocalReceive').isHidden(), true);
        assert.equal(await a.locator('#transferSection').evaluate(el => el.parentElement.id), 'transferWorkspace');
        results.cases.push('compact workspace starts without an invitation; native file chooser appears only after verification, and receiving options stay collapsed');
        const rejectedId = await a.evaluate(() => [...zeydrop.peers.peers.values()][0]._outgoing.meta.id);
        assert.equal(await b.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.offset), 0);
        await b.locator('#rejectFileOffer').click(); await a.waitForFunction(() => ![...zeydrop.peers.peers.values()][0]._outgoing);
        results.cases.push('receiver reject sends zero file bytes');
        assert.equal(await a.evaluate(() => [...zeydrop.peers.peers.values()][0]._filesQueue.length), 1);
        await a.locator('.retry-transfer:visible').click(); await b.locator('#fileOfferDialog[show]').waitFor();
        assert.notEqual(await b.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.meta.id), rejectedId);
        assert.equal(await b.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.offset), 0);
        await b.locator('#acceptFileOffer').click();
        await b.locator('#receiveDialog[show]').waitFor();
        const expected = crypto.createHash('sha256').update(file.buffer).digest('hex'); assert.ok((await b.locator('#fileSize').innerText()).includes(expected));
        const downloadPromise = b.waitForEvent('download'); await b.locator('#download').click(); const download = await downloadPromise;
        assert.deepEqual(await fs.readFile(await download.path()), file.buffer); results.cases.push('fallback save and independent downloaded SHA-256/content equality');
        await b.locator('#fileOfferDialog[show]').waitFor();
        assert.equal(await b.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.meta.name), 'queued-after-rejection.txt');
        await b.locator('#rejectFileOffer').click(); await a.waitForFunction(() => ![...zeydrop.peers.peers.values()][0]._outgoing);
        results.cases.push('rejection preserves pending queue; manual retry uses fresh ID and explicit consent; next offer waits for Blob saving');
        // Synthetic storage failure must stop this file without breaking the direct channel.
        await b.evaluate(() => { window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { throw new DOMException('Test storage quota', 'QuotaExceededError'); }, close: async () => {}, abort: async () => {} }) }); });
        await a.locator('x-peer input[type=file]').setInputFiles({name:'quota-test.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(60000)});
        await b.locator('#fileOfferDialog[show]').waitFor(); await b.locator('#acceptFileOffer').click();
        await a.waitForFunction(() => ![...zeydrop.peers.peers.values()][0]._outgoing);
        const quota = await b.evaluate(() => ({state:window.__testTransfers['quota-test.bin'],connected:[...zeydrop.peers.peers.values()][0]._isConnected()}));
        assert.equal(quota.state.phase,'cancelled'); assert.match(quota.state.error,/保存空间不足/); assert.equal(quota.connected,true);
        results.cases.push('storage quota failure reports cancellation without closing the direct channel');
        // Native browser FileSystemWritableFileStream, with only picker selection supplied by the test.
        await b.evaluate(() => {
            window.showSaveFilePicker = async ({ suggestedName }) => {
                const directory = await navigator.storage.getDirectory();
                return directory.getFileHandle(suggestedName, { create: true });
            };
        });
        results.storageBefore = await b.evaluate(() => navigator.storage.estimate());
        for (const size of [0, 100 * 1024 * 1024, ...(process.env.LARGE_FILE_TEST === '1' ? [1024 ** 3] : [])]) {
            const name = 'stream-' + size + '.bin', local = path.resolve('test-results', name);
            const handle = await fs.open(local, 'w'); await handle.truncate(size); await handle.close();
            const probes = await Promise.all(pages.map(page => startResources(page, { engine: results.engine, intervalMs: 1000, maxSamples: 360 })));
            resourceProbes.push(...probes);
            const start = Date.now(); await a.locator('x-peer input[type=file]').setInputFiles(local);
            await b.locator('#fileOfferDialog[show]').waitFor(); await b.locator('#acceptFileOffer').click();
            await a.waitForFunction(() => ![...zeydrop.peers.peers.values()][0]._outgoing, null, { timeout: 300000 });
            const terminal = await a.evaluate(name => ({ state: window.__testTransfers[name], notices: window.__testNotices }), name);
            assert.equal(terminal.state?.phase, 'complete', 'File did not complete: ' + JSON.stringify(terminal));
            const observations = await Promise.all(probes.map(probe => probe.stop()));
            results.resourceObservations ||= {};
            results.resourceObservations[String(size)] = { sender: observations[0], receiver: observations[1],
                window: 'before automated file selection/consent until verified complete; excludes subsequent independent disk rehash' };
            const actualSize = await b.evaluate(async name => (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).size, name);
            assert.equal(actualSize, size);
            const sha = crypto.createHash('sha256'); for (let offset = 0; offset < size; offset += 1024 * 1024) sha.update(Buffer.alloc(Math.min(1024 * 1024, size - offset)));
            const expectedHash = sha.digest('hex');
            const diskHash = await b.evaluate(async name => {
                const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
                const hash = window.ZeydropHash.create(); const reader = file.stream().getReader();
                while (true) { const { value, done } = await reader.read(); if (done) break; hash.update(value); }
                return hex(hash.digest());
            }, name);
            assert.equal(diskHash, expectedHash);
            results.cases.push('native streamed file ' + size + ' bytes with independent disk SHA-256');
            results['stream' + size] = { ms: Date.now() - start, sha256: expectedHash };
            await b.evaluate(async name => (await navigator.storage.getDirectory()).removeEntry(name), name);
            await fs.rm(local); console.log('PASS streamed file:', size, 'bytes');
        }
        // Real two-profile in-page cross-connection resume: close the receiver WSS
        // while the OPFS sink is actively writing, then require fresh manual code
        // confirmation before the sender can hash the checkpoint and send the tail.
        const resumeName = '恢复文件 & 空 格', resumeFile = Buffer.alloc(8 * 1024 * 1024, 0x6d);
        await a.evaluate(() => {
            window.__resumeBinaryBytes = 0;
            const send = RTCPeer.prototype._send;
            RTCPeer.prototype._send = function(data) {
                if (typeof data !== 'string') window.__resumeBinaryBytes += data.byteLength;
                return send.call(this, data);
            };
        });
        await b.evaluate(() => {
            window.__resumeProbe = { disconnects: 0, writtenAtBreak: 0 };
            window.showSaveFilePicker = async ({ suggestedName }) => {
                const handle = await (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true });
                return { createWritable: async () => {
                    const sink = await handle.createWritable(); let written = 0;
                    return {
                        write: async bytes => {
                            await sink.write(bytes); written += bytes.byteLength;
                            if (written >= 128 * 1024 && window.__resumeProbe.disconnects === 0) {
                                window.__resumeProbe.disconnects = 1;
                                window.__resumeProbe.writtenAtBreak = written;
                                zeydrop.server._socket.close();
                            }
                        },
                        close: () => sink.close(),
                        abort: () => sink.abort()
                    };
                } };
            };
        });
        await a.locator('x-peer input[type=file]').setInputFiles({ name: resumeName, mimeType: '', buffer: resumeFile });
        await b.locator('#fileOfferDialog[show]').waitFor(); await b.locator('#acceptFileOffer').click();
        await b.waitForFunction(() => window.__resumeProbe.disconnects === 1, null, { timeout: 30000 });
        for (const page of pages) {
            await page.waitForFunction(() => {
                const peer = [...zeydrop.peers.peers.values()][0];
                return peer?._path?.direct && peer?._remoteHello && peer?._code && !peer?._verified;
            }, null, { timeout: 60000 });
        }
        const resumedCodes = await Promise.all(pages.map(page => page.locator('.security-code').innerText()));
        assert.equal(resumedCodes[0], resumedCodes[1]);
        for (const page of pages) await page.locator('.verify-peer').click();
        await a.waitForFunction(name => window.__testTransfers[name]?.phase === 'complete', resumeName, { timeout: 180000 });
        const resumeDiskHash = await b.evaluate(async name => {
            const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
            const hash = window.ZeydropHash.create();
            const reader = file.stream().getReader();
            while (true) { const { value, done } = await reader.read(); if (done) break; hash.update(value); }
            return { length: file.size, sha256: hex(hash.digest()) };
        }, resumeName);
        const resumeExpected = crypto.createHash('sha256').update(resumeFile).digest('hex');
        assert.equal(resumeDiskHash.length, resumeFile.length);
        assert.equal(resumeDiskHash.sha256, resumeExpected);
        const resumeBytes = await a.evaluate(() => window.__resumeBinaryBytes);
        assert.ok(resumeBytes >= resumeFile.length && resumeBytes <= resumeFile.length + 256 * 1024,
            'Sender must resume from the recorded checkpoint, not resend the whole file');
        results.resume = { name: resumeName, size: resumeFile.length, writtenAtBreak: await b.evaluate(() => window.__resumeProbe.writtenAtBreak), dataChannelBytes: resumeBytes, sha256: resumeExpected };
        results.cases.push('real WebSocket peer rebuild resumes 8 MiB native OPFS sink after fresh matching safety codes and SHA-256 prefix check');
        await b.evaluate(async name => (await navigator.storage.getDirectory()).removeEntry(name), resumeName);
        results.liveHashWorkers=await Promise.all(pages.map(page=>page.evaluate(()=>({...window.__liveHash,active:window.ZeydropStreamHash._handles.size}))));
        assert.ok(results.liveHashWorkers.every(item=>item.handles>0&&item.workerHandles===item.handles&&item.mainCalls===0&&item.active===0));
        results.cases.push('actual transfer and reconnection prefix hashes use native Workers, with no main fallback and no remaining leases');
        results.peakReceiveQueues = await Promise.all(pages.map(page => page.evaluate(() => [...zeydrop.peers.peers.values()][0]._peakQueuedBytes || 0)));
        assert.ok(results.peakReceiveQueues.every(bytes => bytes <= 1024 * 1024));
        assert.ok(traffic.every(message => !message.binary && !message.text.includes('PRIVATE_FILE_BODY_SENTINEL') && !message.text.includes('PRIVATE_FILE_SENTINEL')));
        const fileHashes = [expected, ...Object.entries(results).filter(([key])=>/^stream\d+$/.test(key)).map(([,value])=>value.sha256)];
        assert.ok(traffic.every(message => fileHashes.every(hash => !message.text.includes(hash))), 'file hashes must stay on DataChannel');
        assert.ok(traffic.reduce((sum, message) => sum + message.bytes, 0) < 512 * 1024);
        results.signaling = { messages: traffic.length, bytes: traffic.reduce((sum, message) => sum + message.bytes, 0), fileBodyObserved: false };
        results.cases.push('server WebSocket captured: no file name, hash or body; no binary frames');
        // Resume the signed WS session and rebuild authenticated P2P pairing.
        const oldId = await a.evaluate(() => zeydrop.server._peerId); await a.evaluate(() => zeydrop.server._socket.close());
        await a.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected' && [...zeydrop.peers.peers.values()][0]?._path?.direct, null, { timeout: 30000 });
        assert.equal(await a.evaluate(() => zeydrop.server._peerId), oldId); results.cases.push('WS disconnect/reconnect preserves server identity and rebuilds P2P');
        // Delay only the answerer's discovery, so real SDP/ICE reaches it first.
        const previousInvite = await a.locator('#inviteUrl').inputValue();
        for (const page of pages) {
            await page.locator('#leaveRoomBtn').click();
            await page.waitForFunction(() => zeydrop.server._desiredRoomId === null && zeydrop.peers.peers.size === 0);
        }
        const ids = await Promise.all(pages.map(page => page.evaluate(() => zeydrop.server._peerId)));
        const answerer = ids.slice().sort()[0]; let delayedFrames = 0;
        for (const page of pages) await page.evaluate(() => { window.__earlySignalsObserved = 0; window.addEventListener('signal', event => { if (!zeydrop.peers.peers.has(event.detail.sender)) window.__earlySignalsObserved++; }); });
        const originalSend = server.signaling.send.bind(server.signaling);
        server.signaling.send = (peer, message) => {
            if (peer?.id === answerer && (message.type === 'peer-joined' || (message.type === 'peers' && message.peers.length))) {
                delayedFrames++; setTimeout(() => originalSend(peer, message), 250);
            } else originalSend(peer, message);
        };
        await a.locator('#createRoomBtn').click();
        await a.waitForFunction(previous => {const value=document.querySelector('#inviteUrl').value;return value.includes('#room=') && value!==previous;}, previousInvite);
        const delayedInvite = await a.locator('#inviteUrl').inputValue();
        await openJoin(b); await b.locator('#roomInput').fill(delayedInvite); await b.locator('#roomBtn').click();
        for (const page of pages) await page.waitForFunction(() => [...zeydrop.peers.peers.values()][0]?._path?.direct, null, {timeout:30000});
        server.signaling.send = originalSend; assert.ok(delayedFrames>0);
        results.delayedEarlySignals = await Promise.all(pages.map(page => page.evaluate(() => window.__earlySignalsObserved)));
        assert.ok(results.delayedEarlySignals.some(count => count>0), 'Test must actually deliver SDP/ICE before discovery');
        results.cases.push('real delayed discovery: earlier SDP/ICE buffered until authorized peer appears');
        const diagnosticDownload = a.waitForEvent('download'); await openMore(a); await a.locator('#exportDiagnostics').click();
        const report = JSON.parse(await fs.readFile(await (await diagnosticDownload).path(), 'utf8'));
        assert.equal(report.schema, 1); assert.match(report.revision, /^[a-f0-9]{16}$/);
        assert.ok(report.events.some(event => event.kind === 'connection' && event.path.direct && event.path.status === 'selected'));
        const reportText = JSON.stringify(report);
        const secrets = await a.evaluate(() => [zeydrop.server._peerId,zeydrop.server._resumeToken,zeydrop.server._desiredRoomId,...[...zeydrop.peers.peers.values()].flatMap(peer=>[peer._peerId,peer._code])]);
        for (const secret of [...secrets,'PRIVATE_FILE_SENTINEL','PRIVATE_FILE_BODY_SENTINEL']) if (secret) assert.ok(!reportText.includes(secret));
        results.cases.push('local diagnostic download records selected path without identities, invitation, tokens or file metadata');
        assert.deepEqual(results.errors, []); results.passed = true;
    } catch (error) {
        results.failure = ['TimeoutError','AssertionError','TypeError','RangeError'].includes(error?.name) ? error.name : 'Error';
        results.lastCompletedCase = results.cases.at(-1) || 'startup';
        // Failure artifacts must not expose raw RTCStatsReport addresses, SDP,
        // returned credentials or arbitrary native exception strings either.
        results.debug = await Promise.all(pages.map(page => page.evaluate(rtcEndpointSnapshot,results.engine).catch(()=>({unavailable:true}))));
        throw error;
    } finally {
        await Promise.allSettled(resourceProbes.map(probe => probe.stop()));
        await fs.writeFile('test-results/browser-' + results.engine + '.json', JSON.stringify(results, null, 2));
        await Promise.all(contexts.map(context => context.close())); await browser?.close(); await server.close(); await fs.rm(profileRoot, { recursive: true, force: true });
        for (const file of await fs.readdir('test-results')) if (/^stream-\d+\.bin$/.test(file)) await fs.rm(path.join('test-results', file));
    }
    console.log(JSON.stringify(results, null, 2));
}
main().catch(error => { console.error('Browser test failed:', ['TimeoutError','AssertionError','TypeError','RangeError'].includes(error?.name) ? error.name : 'Error'); process.exitCode = 1; });
