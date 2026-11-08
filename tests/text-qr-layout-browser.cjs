'use strict';
// Real built modal geometry and local QR pixels. Viewport emulation does not
// certify a phone, camera, browser keyboard or hardware accessibility behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium, firefox, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const { decodeQrPng } = require('./decode-qr.cjs');

const engines = { chromium, firefox, webkit };
const shapes = [
    { name: 'phone-390', width: 390, height: 844, completeInitially: true },
    { name: 'phone-320', width: 320, height: 740 },
    { name: 'phone-320-short', width: 320, height: 568 },
    { name: 'landscape', width: 844, height: 390 },
    { name: 'desktop', width: 1440, height: 1000, completeInitially: true }
];
const text = '给朋友的一条消息 👋\n闪投，让分享更直接。\nDirect by design.';
function errorKind(error) {
    return ['AssertionError', 'TimeoutError', 'QrDecodeError', 'QrImageError', 'QrDecoderUnavailable'].includes(error?.name) ? error.name : 'Error';
}
async function settled(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function geometry(page) {
    return page.evaluate(() => {
        const paper = document.querySelector('#textQrDialog x-paper');
        const box = el => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const viewport = { width: innerWidth, height: innerHeight }, rect = box(paper);
        const within = el => {
            const r = box(el);
            return r.x >= rect.x && r.right <= rect.right && r.y >= rect.y && r.bottom <= rect.bottom
                && r.y >= 0 && r.bottom <= viewport.height;
        };
        const canvas = document.getElementById('textQR');
        return {
            viewport, paper: rect, paperScrollTop: paper.scrollTop, paperScrollHeight: paper.scrollHeight, paperClientHeight: paper.clientHeight,
            documentFits: document.documentElement.scrollWidth <= innerWidth,
            paperFits: paper.scrollWidth <= paper.clientWidth + 1,
            actions: [...document.querySelectorAll('.text-qr-actions button')].map(box),
            canvas: { ...box(canvas), widthPixels: canvas.width, heightPixels: canvas.height },
            initial: Object.fromEntries(['qrPrivacy', 'closeTextQR', 'saveTextQR'].map(id => [id, within(document.getElementById(id))]))
        };
    });
}
async function reachable(page, id) {
    await page.locator('#' + id).scrollIntoViewIfNeeded(); await settled(page);
    const result = await page.evaluate(id => {
        const el = document.getElementById(id), paper = document.querySelector('#textQrDialog x-paper');
        const r = el.getBoundingClientRect(), p = paper.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
        return { within: r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom && r.top >= 0 && r.bottom <= innerHeight,
            hit: !!hit && (hit === el || el.contains(hit)) };
    }, id);
    assert.equal(result.within, true, id + ' stays inside the scrolled paper/viewport');
    assert.equal(result.hit, true, id + ' has a real unobscured hit target');
}
async function main() {
    const engine = process.env.BROWSER_TYPE || 'chromium'; assert.ok(engines[engine]);
    const report = { schema: 1, engine, passed: false, phase: 'startup', cases: [], errors: [], screenshots: [],
        scope: 'actual built UI and QR, browser viewport simulation; not phone/camera/keyboard/accessibility hardware or WAN evidence' };
    let browser, context, server;
    try {
        await fs.mkdir('test-results', { recursive: true }); server = await startDev(0);
        browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version();
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, reducedMotion: 'reduce' });
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on('pageerror', error => { if (report.errors.length < 10) report.errors.push(errorKind(error)); });
        await page.goto(server.origin);
        await page.waitForFunction(() => typeof document.getElementById('openTextTools').onclick === 'function');
        report.revision = await page.locator('meta[name=build-revision]').getAttribute('content');
        for (const shape of shapes) for (const scheme of ['light', 'dark']) {
            report.phase = shape.name + '-' + scheme;
            await page.setViewportSize({ width: shape.width, height: shape.height }); await page.emulateMedia({ colorScheme: scheme });
            await page.locator('#openTextTools').click();
            await page.locator('#qrTextInput').fill(text); await page.locator('#generateTextQR').click();
            await page.locator('#textQR:visible').waitFor(); await settled(page);
            await page.locator('#textQrDialog x-paper').evaluate(paper => { paper.scrollTop = 0; }); await settled(page);
            const g = await geometry(page);
            assert.equal(g.documentFits, true); assert.equal(g.paperFits, true, 'modal has no horizontal overflow');
            assert.ok(g.paper.x >= 15 && g.paper.right <= shape.width - 15 && g.paper.y >= 15 && g.paper.bottom <= shape.height - 15,
                'paper remains bounded to its viewport with the intended inset');
            assert.ok(g.actions.every(box => box.width >= 44 && box.height >= 44), 'every action keeps a 44px touch target');
            assert.ok(Math.max(...g.actions.map(box => box.y)) - Math.min(...g.actions.map(box => box.y)) <= 1, 'three actions occupy one row');
            assert.equal(g.canvas.widthPixels, 512); assert.equal(g.canvas.heightPixels, 512);
            assert.ok(Math.abs(g.canvas.width - g.canvas.height) <= 1 && g.canvas.width <= 256, 'preview remains square and bounded');
            if (shape.completeInitially) {
                assert.equal(g.paperScrollTop, 0); assert.ok(Object.values(g.initial).every(Boolean), 'privacy, close and save are visible without initial scrolling');
            } else if (shape.name.startsWith('phone-320')) {
                assert.equal(g.initial.qrPrivacy, true, 'narrow portrait shows plaintext privacy before the preview');
                assert.equal(g.initial.closeTextQR, true, 'narrow portrait shows the close action before scrolling');
            }
            const png = Buffer.from((await page.locator('#textQR').evaluate(canvas => canvas.toDataURL('image/png'))).split(',')[1], 'base64');
            assert.deepEqual(decodeQrPng(png), Buffer.from(text, 'utf8'));
            await reachable(page, 'qrPrivacy'); await reachable(page, 'saveTextQR');
            const downloadWait = page.waitForEvent('download'); await page.locator('#saveTextQR').click();
            assert.deepEqual(decodeQrPng(await fs.readFile(await (await downloadWait).path())), Buffer.from(text, 'utf8'));
            await reachable(page, 'closeTextQR');
            if (shape.name === 'phone-390' || (scheme === 'light' && shape.name === 'phone-320')) {
                await page.locator('#textQrDialog x-paper').evaluate(paper => { paper.scrollTop = 0; }); await settled(page);
                const file = 'test-results/qr-layout-' + engine + '-' + shape.name + '-' + scheme + '.png';
                await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file);
            }
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#textQrDialog').isHidden(), true);
            assert.equal(await page.locator('#qrTextInput').inputValue(), '', 'closing still clears the local tool');
            report.cases.push({ name: report.phase, geometry: g, pngDecoded: true, downloadedPngDecoded: true, controlsReachable: true, keyboardClose: true });
        }
        assert.deepEqual(report.errors, []); report.passed = true; report.phase = 'complete';
    } catch (error) {
        report.failure = errorKind(error);
        const message = String(error?.message || '');
        if (/Executable doesn't exist/.test(message)) report.failureCode = 'browser-executable-unavailable';
        else if (/Operation not permitted|\bEPERM\b/.test(message)) report.failureCode = 'runtime-operation-denied';
        const line = String(error?.stack || '').match(/text-qr-layout-browser\.cjs:(\d+):(\d+)/);
        if (line) report.failureLine = { line: Number(line[1]), column: Number(line[2]) };
        throw error;
    } finally {
        await fs.mkdir('test-results', { recursive: true });
        await fs.writeFile('test-results/qr-layout-' + engine + '.json', JSON.stringify(report, null, 2) + '\n');
        await context?.close(); await browser?.close(); await server?.close();
    }
    console.log('Text QR layout evidence:', JSON.stringify(report));
}
main().catch(error => { console.error('Text QR layout failed:', errorKind(error)); process.exitCode = 1; });
