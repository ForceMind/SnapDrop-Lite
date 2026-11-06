'use strict';
// Two distinct browser engines must exchange files directly in both directions.
// Same CI host, STUN disabled: WebKit Linux is NOT iOS/macOS Safari hardware,
// nor is it evidence of cross-provider NAT success.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');

async function main() {
    const server = await startDev(0);
    const contexts = [], browsers = [], pages = [], errors = [];
    try {
        for (const engine of [chromium, webkit]) {
            const browser = await engine.launch({ headless: true });
            browsers.push(browser);
            const context = await browser.newContext({ acceptDownloads: true });
            contexts.push(context);
            const page = await context.newPage();
            pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/config.js?*', route => route.fulfill({
                contentType: 'text/javascript',
                body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};'
            }));
            await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
        }
        const [chrome, fox] = pages;
        await chrome.goto(server.origin);
        await chrome.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        await chrome.locator('#createRoomBtn').click();
        await chrome.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        await fox.goto(await chrome.locator('#inviteUrl').inputValue());
        for (const page of pages) await page.waitForFunction(() => {
            const peer = [...zeydrop.peers.peers.values()][0];
            return peer?._path?.direct && peer?._remoteHello && peer?._code;
        }, null, { timeout: 30000 });
        const codes = await Promise.all(pages.map(page => page.locator('.security-code').innerText()));
        assert.equal(codes[0], codes[1], 'cross-engine DTLS identity code must match');
        for (const page of pages) {
            await page.locator('.verify-peer').click();
            await page.waitForFunction(() => [...zeydrop.peers.peers.values()][0]?._verified === true);
            const path = await page.evaluate(() => [...zeydrop.peers.peers.values()][0]._path);
            assert.equal(path.direct, true);
            assert.ok(['udp','tcp'].includes(path.protocol));
            assert.notEqual(path.localType, 'relay');
            assert.notEqual(path.remoteType, 'relay');
        }
        const signaling = [];
        for (const peer of server.signaling.connections.values()) {
            peer.socket.on('message', (bytes, binary) => signaling.push({
                binary, raw: bytes.toString(), length: bytes.length
            }));
        }
        async function transfer(sender, receiver, from) {
            const sentinel = 'ZEYDROP_NO_WS_BODY_' + from;
            const bytes = Buffer.concat([
                Buffer.from(sentinel),
                crypto.randomBytes(1024 * 1024 + 133),
                Buffer.from(sentinel)
            ]);
            const name = 'interoperability-' + from + '.bin';
            await sender.locator('x-peer input[type=file]').setInputFiles({
                name, mimeType: 'application/octet-stream', buffer: bytes
            });
            await receiver.locator('#fileOfferDialog[show]').waitFor();
            const before = await receiver.evaluate(() => [...zeydrop.peers.peers.values()][0]._incoming.offset);
            assert.equal(before, 0, 'no file bytes may arrive before receiver click');
            await receiver.locator('#acceptFileOffer').click();
            await receiver.locator('#receiveDialog[show]').waitFor({ timeout: 60000 });
            const expected = crypto.createHash('sha256').update(bytes).digest('hex');
            assert.ok((await receiver.locator('#fileSize').innerText()).includes(expected));
            const downloaded = receiver.waitForEvent('download');
            await receiver.locator('#download').click();
            const result = await downloaded;
            const actual = await fs.readFile(await result.path());
            assert.equal(actual.length, bytes.length);
            assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), expected,
                'downloaded file must match independent local SHA-256');
            await sender.waitForFunction(() => [...zeydrop.peers.peers.values()][0]._outgoing === null);
            assert.ok(signaling.every(f => !f.binary && !f.raw.includes(sentinel)
                && !f.raw.includes(name) && !f.raw.includes(expected)),
                'file name, body and SHA-256 must not leak into signaling');
            return { from, bytes: bytes.length, sha256: expected };
        }
        const results = [];
        results.push(await transfer(chrome, fox, 'chromium-to-webkit'));
        results.push(await transfer(fox, chrome, 'webkit-to-chromium'));
        assert.deepEqual(errors, []);
        console.log('PASS real Chromium <-> WebKit RTCDataChannel, both directions, explicit consent, independent file SHA-256, no WS file body:', JSON.stringify(results));
    } finally {
        await Promise.all(contexts.map(ctx => ctx.close().catch(() => {})));
        await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
        await server.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
