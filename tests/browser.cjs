'use strict';
// Real two-browser-context DataChannel tests. No external NAT claims are made.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright'); const { startDev } = require('../scripts/dev.cjs');
async function main() {
    const server = await startDev(0); const results = { engine: process.env.BROWSER_TYPE || 'chromium', cases: [], network: 'two contexts on the same test host; STUN disabled', errors: [] };
    const engine = { chromium, firefox, webkit }[results.engine];
    const browser = await engine.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] } : {}) });
    const contexts = []; const pages = [];
    await fs.mkdir('test-results', { recursive: true });
    try {
        for (let i = 0; i < 2; i++) {
            const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' }); contexts.push(context);
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => results.errors.push(error.message));
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript', body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
        }
        const [a, b] = pages;
        await a.goto(server.origin); await a.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        if (process.env.TEST_CJK_CSS) {
            const base = path.dirname(process.env.TEST_CJK_CSS);
            let css = await fs.readFile(process.env.TEST_CJK_CSS, 'utf8');
            const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]))];
            for (const url of urls) css = css.replaceAll(url, 'data:font/woff2;base64,' + (await fs.readFile(path.resolve(base, url))).toString('base64'));
            await a.addStyleTag({ content: css + '\nbody { font-family: \"Noto Sans SC\",sans-serif !important; }' });
            await a.evaluate(() => document.fonts.ready);
        }
        await a.screenshot({ path: 'test-results/desktop-light.png', fullPage: true });
        await a.emulateMedia({ colorScheme: 'dark' }); await a.screenshot({ path: 'test-results/desktop-dark.png', fullPage: true }); await a.emulateMedia({ colorScheme: 'light' });
        await a.setViewportSize({ width: 390, height: 844 }); await a.screenshot({ path: 'test-results/mobile.png', fullPage: true });
        assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow');
        await a.setViewportSize({ width: 1440, height: 1080 });
        await a.locator('#createRoomBtn').click(); await a.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        const invite = await a.locator('#inviteUrl').inputValue(); assert.ok(!invite.includes('?room='));
        await b.goto(invite);
        for (const page of pages) await page.waitForFunction(() => [...zeydrop.peers.peers.values()][0]?._path?.direct, null, { timeout: 30000 });
        const codes = await Promise.all(pages.map(page => page.locator('.security-code').innerText())); assert.equal(codes[0], codes[1]); console.log('PASS direct connection and DTLS code');
        for (const page of pages) { assert.equal(await page.locator('x-peer input').isDisabled(), true); await page.locator('.verify-peer').click(); }
        const paths = await Promise.all(pages.map(page => page.evaluate(() => [...zeydrop.peers.peers.values()][0]._path)));
        assert.ok(paths.every(info => info.direct && info.protocol === 'udp' && info.localType !== 'relay' && info.remoteType !== 'relay'));
        results.paths = paths; results.cases.push('real UDP DataChannel, selected host path, matching DTLS code');
        const traffic = []; for (const peer of server.signaling.connections.values()) peer.socket.on('message', (bytes, binary) => traffic.push({ binary, text: bytes.toString(), bytes: bytes.length }));
        const file = { name: 'PRIVATE_FILE_SENTINEL.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE_FILE_BODY_SENTINEL\n'.repeat(12000)) };
        const send = () => a.locator('x-peer input[type=file]').setInputFiles(file);
        await send(); await b.locator('#fileOfferDialog[show]').waitFor();
        assert.equal(await b.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.offset), 0);
        await b.locator('#rejectFileOffer').click(); await a.waitForFunction(() => ![...zeydrop.peers.peers.values()][0]._outgoing);
        results.cases.push('receiver reject sends zero file bytes');
        await send(); await b.locator('#fileOfferDialog[show]').waitFor(); await b.locator('#acceptFileOffer').click();
        await b.locator('#receiveDialog[show]').waitFor();
        const expected = crypto.createHash('sha256').update(file.buffer).digest('hex'); assert.ok((await b.locator('#fileSize').innerText()).includes(expected));
        const downloadPromise = b.waitForEvent('download'); await b.locator('#download').click(); const download = await downloadPromise;
        assert.deepEqual(await fs.readFile(await download.path()), file.buffer); results.cases.push('fallback save and independent downloaded SHA-256/content equality');
        // Native browser FileSystemWritableFileStream, with only picker selection supplied by the test.
        await b.evaluate(() => {
            window.showSaveFilePicker = async ({ suggestedName }) => {
                const directory = await navigator.storage.getDirectory();
                return directory.getFileHandle(suggestedName, { create: true });
            };
        });
        for (const size of [0, 100 * 1024 * 1024, ...(process.env.LARGE_FILE_TEST === '1' ? [1024 ** 3] : [])]) {
            const name = 'stream-' + size + '.bin', local = path.resolve('test-results', name);
            const handle = await fs.open(local, 'w'); await handle.truncate(size); await handle.close();
            const start = Date.now(); await a.locator('x-peer input[type=file]').setInputFiles(local);
            await b.locator('#fileOfferDialog[show]').waitFor(); await b.locator('#acceptFileOffer').click();
            await a.waitForFunction(() => ![...zeydrop.peers.peers.values()][0]._outgoing, null, { timeout: 300000 });
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
            await fs.rm(local); console.log('PASS streamed file:', size, 'bytes');
        }
        assert.ok(traffic.every(message => !message.binary && !message.text.includes('PRIVATE_FILE_BODY_SENTINEL') && !message.text.includes('PRIVATE_FILE_SENTINEL')));
        assert.ok(traffic.reduce((sum, message) => sum + message.bytes, 0) < 512 * 1024);
        results.signaling = { messages: traffic.length, bytes: traffic.reduce((sum, message) => sum + message.bytes, 0), fileBodyObserved: false };
        results.cases.push('server WebSocket captured: no file name, hash or body; no binary frames');
        // Resume the signed WS session and rebuild authenticated P2P pairing.
        const oldId = await a.evaluate(() => zeydrop.server._peerId); await a.evaluate(() => zeydrop.server._socket.close());
        await a.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected' && [...zeydrop.peers.peers.values()][0]?._path?.direct, null, { timeout: 30000 });
        assert.equal(await a.evaluate(() => zeydrop.server._peerId), oldId); results.cases.push('WS disconnect/reconnect preserves server identity and rebuilds P2P');
        assert.deepEqual(results.errors, []); results.passed = true;
    } catch (error) {
        results.failure = error.message;
        results.debug = await Promise.all(pages.map(page => page.evaluate(async () => ({ signal: zeydrop.server._ready, peers: await Promise.all([...zeydrop.peers.peers.values()].map(async peer => ({state: peer._state, ice: peer._conn.iceConnectionState, connection: peer._conn.connectionState, signaling: peer._conn.signalingState, candidates: peer._candidateCounts, channel: peer._channel?.readyState, code: Boolean(peer._code), path:peer._path, stats: [...(await peer._conn.getStats()).values()].filter(s => ['transport','candidate-pair','local-candidate','remote-candidate'].includes(s.type)) }))) })))) ;
        throw error;
    } finally {
        await fs.writeFile('test-results/browser-' + results.engine + '.json', JSON.stringify(results, null, 2));
        await Promise.all(contexts.map(context => context.close())); await browser.close(); await server.close();
    }
    console.log(JSON.stringify(results, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
