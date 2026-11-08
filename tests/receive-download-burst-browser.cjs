'use strict';
// A diagnostic control for Issue #10, not transfer or release acceptance.
// Fresh Chromium processes keep each probe's download-policy history separate.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
async function probe(origin, mode) {
    const browser = await chromium.launch({ headless: true });
    const result = { mode, browserVersion: browser.version(), attempted: 0, downloaded: 0, firstMissing: null, console: [], errors: [] };
    const started = Date.now();
    try {
        const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage();
        page.on('pageerror', error => result.errors.push(error.message));
        page.on('console', event => {
            const message = event.text();
            if (/download|throttl|blocked/i.test(message)) result.console.push(message.slice(0, 600));
        });
        await page.goto(origin); await page.waitForFunction(() => typeof zeydrop !== 'undefined');
        const names = ['首个文件.txt', '第二个文件.txt', ...Array.from({ length: 18 }, (_, i) => 'capacity-' + (i + 2) + '.txt')];
        const emit = async names => page.evaluate(names => {
            for (const name of names) {
                const blob = new Blob([name]);
                Events.fire('file-received', { name, id: name, sender: 'burst-ui-fixture', size: blob.size,
                    sha256: 'a'.repeat(64), blob, locallyStored: true });
            }
        }, names);
        if (mode === 'app') await emit(names.slice(0, 2));
        else await page.evaluate(() => {
            const link = document.createElement('a'); link.id = 'independentDownloadControl'; link.textContent = 'Save control';
            Object.assign(link.style, { position: 'fixed', top: '10px', left: '10px', zIndex: '99999', padding: '15px', background: 'white', color: 'black' });
            document.body.append(link);
        });
        for (let i = 0; i < names.length; i++) {
            const name = names[i]; result.attempted++;
            if (mode === 'app') {
                if (i >= 2) await emit([name]);
                await page.locator('#receiveDialog[show]').waitFor();
            } else await page.evaluate(name => {
                const link = document.getElementById('independentDownloadControl');
                link.href = URL.createObjectURL(new Blob([name])); link.download = name;
            }, name);
            const pending = page.waitForEvent('download', { timeout: 2000 }).catch(error => {
                if (error.name !== 'TimeoutError') throw error;
                return null;
            });
            await page.locator(mode === 'app' ? '#download' : '#independentDownloadControl').click();
            const download = await pending;
            if (!download) { result.firstMissing = name; break; }
            assert.equal(download.suggestedFilename(), name);
            assert.equal((await fs.readFile(await download.path())).toString(), name);
            result.downloaded++;
            if (mode === 'app') await page.waitForFunction(name => document.getElementById('fileName').textContent !== name || !document.getElementById('receiveDialog').hasAttribute('show'), name);
            if (i === 1) {
                if (mode === 'app') { await emit(['dismissed']); await page.locator('#receiveDialog[show]').press('Escape'); }
                else await page.keyboard.press('Escape');
            }
        }
        assert.deepEqual(result.errors, []);
    } finally { result.elapsedMs = Date.now() - started; await browser.close(); }
    return result;
}
async function main() {
    const server = await startDev(0);
    const report = { schema: 1, issue: 10, completed: false, scope: 'unpaced completed-file UI versus independent native anchor; not WebRTC/OPFS/WAN, hardware or an acceptance pass' };
    try {
        report.app = await probe(server.origin, 'app');
        report.control = await probe(server.origin, 'independent-anchor');
        report.interpretation = report.app.downloaded === 20 ? 'application-burst-not-reproduced'
            : report.control.downloaded < 20 ? 'native-anchor-control-also-missed-download; investigate policy diagnostics, not proof of identical cause'
            : 'application-only-missing-download; retain product investigation';
        report.completed = true;
        // An application-only failure is actionable; a control reproduction is
        // recorded explicitly, never rewritten as twenty successful downloads.
        assert.ok(report.app.downloaded === 20 || report.control.downloaded < 20, report.interpretation);
        console.log(JSON.stringify(report));
    } finally {
        await fs.mkdir('test-results', { recursive: true });
        await fs.writeFile('test-results/receive-download-burst.json', JSON.stringify(report, null, 2) + '\n');
        await server.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
