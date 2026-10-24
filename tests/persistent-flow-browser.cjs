'use strict';
// True two-context WebRTC + browser OPFS flow across a receiver page reload.
// This remains a same-host test with STUN disabled, NOT public NAT evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');

async function main() {
    const server = await startDev(0), errors = [], pages = [], contexts = [];
    const browser = await chromium.launch({ headless: true });
    try {
        for (let i = 0; i < 2; i++) {
            const context = await browser.newContext({ acceptDownloads: true });
            contexts.push(context);
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', err => errors.push(err.message));
            await page.route('**/config.js?*', route => route.fulfill({
                contentType: 'text/javascript',
                body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};'
            }));
            await page.addInitScript(() => {
                window.showSaveFilePicker = undefined;
                window.__testTransfers = {};
                window.addEventListener('transfer-state', e => { window.__testTransfers[e.detail.name] = e.detail; });
            });
        }
        const [sender, receiver] = pages;
        const waitPeer = async page => {
            await page.waitForFunction(() => {
                const peer = [...zeydrop.peers.peers.values()][0];
                return peer?._path?.direct && peer?._remoteHello && !!peer?._code;
            }, null, { timeout: 40000 });
        };
        async function pair(url) {
            await receiver.goto(url);
            await Promise.all(pages.map(waitPeer));
            const codes = await Promise.all(pages.map(p => p.locator('.security-code').innerText()));
            assert.equal(codes[0], codes[1]);
            for (const page of pages) await page.locator('.verify-peer').click();
        }
        await sender.goto(server.origin);
        await sender.locator('#createRoomBtn').click();
        await sender.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        await pair(await sender.locator('#inviteUrl').inputValue());
        const name = 'persistent-cross-page.bin';
        const bytes = Buffer.alloc(4 * 1024 * 1024, 0x6b);
        const file = { name, mimeType: 'application/octet-stream', buffer: bytes };
        await receiver.evaluate(() => {
            window.__persistCut = null;
            const base = ZeydropDurableSink.prototype.checkpoint;
            ZeydropDurableSink.prototype.checkpoint = async function(...args) {
                const committed = await base.apply(this, args);
                if (committed >= 1024 * 1024 && !window.__persistCut) {
                    window.__persistCut = committed;
                    zeydrop.server._socket.close(); // interrupt at an actual durable checkpoint
                }
                return committed;
            };
        });
        await sender.locator('x-peer input[type=file]').setInputFiles(file);
        await receiver.locator('#fileOfferDialog[show]').waitFor();
        await receiver.locator('#recoveryReceiveOptions').waitFor({ state: 'visible', timeout: 15000 });
        await receiver.locator('#durableLocalReceive').check();
        await receiver.locator('#acceptFileOffer').click();
        await receiver.waitForFunction(() => window.__persistCut >= 1024 * 1024, null, { timeout: 40000 });
        // Destructively reload both transport/receiver state and the OPFS writer.
        await receiver.reload();
        const partial = await receiver.evaluate(async () => {
            const list = await window.ZeydropRecovery.list();
            return list.find(r => r.name === 'persistent-cross-page.bin');
        });
        assert.ok(partial?.phase === 'partial' && partial.offset >= 1024 * 1024, JSON.stringify(partial));
        await sender.locator('#leaveRoomBtn').click();
        // Keep the production anti-spam 5-second create-room rate limit intact.
        // A fast 1 MiB transfer can finish before that window has elapsed.
        await new Promise(resolve => setTimeout(resolve, 5500));
        await sender.locator('#createRoomBtn').click();
        try {
            await sender.waitForFunction(() =>
                document.querySelector('#inviteUrl').value.includes('#room='), null, { timeout: 15000 });
        } catch (error) {
            const status = await sender.locator('#roomStatus').innerText();
            throw Error('Failed to create a fresh invitation: ' + status + ' / ' + error.message);
        }
        await pair(await sender.locator('#inviteUrl').inputValue());
        await sender.evaluate(() => {
            window.__newSessionBinary = 0;
            const send = RTCPeer.prototype._send;
            RTCPeer.prototype._send = function(data) {
                if (typeof data !== 'string') window.__newSessionBinary += data.byteLength;
                return send.call(this, data);
            };
        });
        await sender.locator('x-peer input[type=file]').setInputFiles(file);
        await receiver.locator('#fileOfferDialog[show]').waitFor();
        await receiver.locator('#localResumeOption').waitFor({ state: 'visible', timeout: 15000 });
        await receiver.locator('#useLocalCheckpoint').check();
        await receiver.locator('#acceptFileOffer').click();
        await sender.waitForFunction(name => window.__testTransfers[name]?.phase === 'complete', name, { timeout: 120000 });
        await receiver.locator('#receiveDialog[show]').waitFor({ timeout: 30000 });
        const waitDownload = receiver.waitForEvent('download');
        await receiver.locator('#download').click();
        const received = await fs.readFile(await (await waitDownload).path());
        assert.equal(received.length, bytes.length);
        assert.equal(crypto.createHash('sha256').update(received).digest('hex'),
            crypto.createHash('sha256').update(bytes).digest('hex'));
        const newSessionBytes = await sender.evaluate(() => window.__newSessionBinary);
        assert.ok(newSessionBytes >= bytes.length - partial.offset
            && newSessionBytes <= bytes.length - partial.offset + 262144,
            'unexpected retransmission amount: ' + newSessionBytes + ' offset ' + partial.offset);
        assert.deepEqual(errors, []);
        console.log('PASS two-context WebRTC OPFS resume after page reload: prefix ' + partial.offset
            + ', resent ' + newSessionBytes + ', file ' + bytes.length + ', independent SHA-256');
    } finally {
        await Promise.all(contexts.map(c => c.close().catch(() => {})));
        await browser.close(); await server.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
