'use strict';
// Production receive UI with controlled completed-file events. This tests
// real anchor downloads, not WebRTC, OPFS durability or WAN connectivity.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
async function main() {
    const engine = process.env.BROWSER_TYPE || 'chromium', engines = { chromium, firefox, webkit };
    assert.ok(engines[engine]);
    const report = { engine, passed: false, phase: 'startup', downloads: [], scope: 'controlled completed-file UI events; native downloads, not transport or OPFS evidence', checks: [] };
    const server = await startDev(0); let browser;
    try {
        browser = await engines[engine].launch({ headless: true });
        const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
            window.__receiveURLs = new Set(); window.__receiveGrace = []; window.__receiveReleases = 0;
            URL.createObjectURL = value => { const url = create(value); window.__receiveURLs.add(url); return url; };
            URL.revokeObjectURL = url => { window.__receiveURLs.delete(url); revoke(url); };
            const schedule = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
            window.setTimeout = (fn, ms, ...args) => {
                const id = schedule(fn, ms, ...args);
                if (ms === 60000) window.__receiveGrace.push(() => { cancel(id); fn(...args); });
                return id;
            };
        });
        await page.goto(server.origin); await page.waitForFunction(() => typeof zeydrop !== 'undefined');
        const offer = async (names, local = true) => page.evaluate(({ names, local }) => {
            for (const name of names) Events.fire('file-received', { name, id: name, sender: 'ui-fixture', size: name.length,
                sha256: 'a'.repeat(64), blob: new Blob([name]), locallyStored: local, release: () => window.__receiveReleases++ });
        }, { names, local });
        const save = async name => {
            report.phase = 'save:' + name;
            await page.locator('#receiveDialog[show]').waitFor();
            const pending = page.waitForEvent('download'); await page.locator('#download').click(); const download = await pending;
            assert.equal(download.suggestedFilename(), name);
            const bytes = await fs.readFile(await download.path()); assert.equal(bytes.toString(), name);
            assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), crypto.createHash('sha256').update(name).digest('hex'));
            report.downloads.push(name);
            await page.waitForFunction(name => document.getElementById('fileName').textContent !== name || !document.getElementById('receiveDialog').hasAttribute('show'), name);
        };
        await offer(['首个文件.txt', '第二个文件.txt']);
        assert.equal(await page.evaluate(() => window.__receiveURLs.size), 0);
        await save('首个文件.txt'); await save('第二个文件.txt');
        report.checks.push('queued native local downloads retain the intended filename and independently checked bytes');
        report.phase = 'dismiss-without-save';
        await offer(['dismissed']); await page.locator('#receiveDialog[show]').press('Escape');
        assert.equal(await page.evaluate(() => window.__receiveURLs.size), 2);
        // Pace the bulk fixture at at most five clicks/second. The first two
        // queued downloads above remain unpaced; no download-policy switches
        // or permission overrides are used for this resource-lifetime check.
        for (let i = 2; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const name = 'capacity-' + i + '.txt'; await offer([name]); await save(name);
        }
        assert.equal(await page.evaluate(() => window.__receiveURLs.size), 20);
        report.phase = 'capacity-rejection';
        await offer(['after-grace.txt']);
        let unexpected = 0; const count = () => unexpected++; page.on('download', count);
        await page.locator('#download').click();
        assert.match(await page.locator('#toast').textContent(), /60/);
        assert.equal(await page.evaluate(() => window.__receiveURLs.size), 20);
        assert.equal(await page.locator('#receiveDialog').getAttribute('show'), '1');
        assert.equal(unexpected, 0); page.off('download', count);
        // Invoke only registered 60-second callbacks: real browser downloads
        // above finished first. This is controlled cleanup, not a timer-duration test.
        await page.evaluate(() => { for (const retire of window.__receiveGrace.splice(0)) retire(); });
        assert.equal(await page.evaluate(() => window.__receiveURLs.size), 0);
        await save('after-grace.txt');
        report.checks.push('twenty live URLs enforce admission without early revocation; controlled grace cleanup restores admission');
        await offer(['ordinary-a.txt', 'ordinary-b.txt'], false);
        await save('ordinary-a.txt'); await save('ordinary-b.txt');
        assert.equal(await page.evaluate(() => window.__receiveReleases), 2);
        report.checks.push('ordinary queued files also preserve anchor filename/content and release both transient sinks');
        assert.deepEqual(errors, []); report.phase = 'complete'; report.passed = true;
        await context.close();
    } catch (error) { report.errorKind = error.name; report.errorStack = error.stack; throw error; }
    finally {
        await fs.mkdir('test-results', { recursive: true });
        await fs.writeFile('test-results/receive-download-' + engine + '.json', JSON.stringify(report, null, 2) + '\n');
        await browser?.close(); await server.close();
    }
    console.log('PASS receive download lifecycle ' + engine);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
