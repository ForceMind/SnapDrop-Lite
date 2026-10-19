'use strict';
const { webkit, firefox, chromium } = require('playwright'); const { startDev } = require('../scripts/dev.cjs'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises');
(async () => {
    const engine = process.env.BROWSER_TYPE || 'webkit'; const server = await startDev(0), browser = await ({webkit,firefox,chromium}[engine]).launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']} : {});
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); page.on('pageerror', error => errors.push(error.message));
        await page.goto(server.origin); await page.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        await page.locator('#createRoomBtn').click(); await page.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(await page.locator('#inviteQR').isVisible());
        await page.evaluate(() => Events.fire('file-offer', {sender:'ui-smoke-only',id:'00000000000000000000000000000000',name:'UI confirmation',size:1}));
        await page.locator('#fileOfferDialog[show]').waitFor();
        assert.equal(await page.locator('#rejectFileOffer').isVisible(), true);
        await page.locator('#rejectFileOffer').click();
        assert.equal(await page.locator('#fileOfferDialog').isVisible(), false);
        await page.locator('#leaveRoomBtn').click(); assert.equal(await page.locator('#inviteCreated').isHidden(), true); assert.deepEqual(errors, []);
        const diagnosticDownload = page.waitForEvent('download'); await page.locator('#exportDiagnostics').click();
        const report = JSON.parse(await fs.readFile(await (await diagnosticDownload).path(), 'utf8'));
        assert.equal(report.product, 'Zeydrop'); assert.ok(report.events.some(event=>event.kind==='signaling' && event.state==='connected'));
        await fs.mkdir('test-results', { recursive:true }); await fs.writeFile('test-results/smoke-'+engine+'.json',JSON.stringify({passed:true, engine, tests:['render','WS session','invite + QR','leave','mobile overflow','visible consent dialog and reject','local diagnostic export'], limitation:'UI smoke only; no Safari WebRTC or iOS device claim'},null,2));
        console.log('PASS', engine, 'UI smoke');
    } finally { await browser.close(); await server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
