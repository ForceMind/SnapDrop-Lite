'use strict';
const { openMore } = require('./workspace-ui-helpers.cjs');
const { webkit, firefox, chromium } = require('playwright'); const { startDev } = require('../scripts/dev.cjs'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises');
(async () => {
    const engine = process.env.BROWSER_TYPE || 'webkit'; const server = await startDev(0);
    const errors = [];let browser;
    try {
        browser = await ({webkit,firefox,chromium}[engine]).launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']} : {});
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); page.on('pageerror', error => errors.push(error.message));
        await page.goto(server.origin); await page.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        await page.locator('#createRoomBtn').click(); await page.waitForFunction(() => document.querySelector('#inviteUrl').value.includes('#room='));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await openMore(page);
        if (await page.locator('#sendQueueSection').isVisible()) {
            await page.locator('#sendQueueSection summary').click();
            assert.equal(await page.locator('#saveSendQueue').isDisabled(), true);
            await page.locator('#rememberSendQueue').check();
            assert.equal(await page.locator('#saveSendQueue').isDisabled(), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'open send checklist fits mobile width');
            await page.locator('#rememberSendQueue').uncheck();
            assert.equal(await page.locator('#saveSendQueue').isDisabled(), true);
            await page.locator('#sendQueueSection summary').click();
        }
        assert.ok(await page.locator('#inviteQR').isVisible());
        await page.evaluate(() => {
            window.__smokeRecoverySupported=window.ZeydropRecovery?.supported;
            if(window.ZeydropRecovery)window.ZeydropRecovery.supported=false;
            Events.fire('file-offer', {sender:'ui-smoke-only',id:'00000000000000000000000000000000',name:'UI confirmation',size:1});
            document.querySelector('#recoveryReceiveOptions').hidden=true;
        });
        await page.locator('#fileOfferDialog[show]').waitFor();
        assert.equal(await page.locator('#rejectFileOffer').isVisible(), true);
        // These are UI-only fixtures. Hidden OPFS checkboxes must never become
        // tab-trap endpoints in browsers that cannot persist a partial file.
        await page.locator('#acceptFileOffer').focus();
        await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'rejectFileOffer');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'acceptFileOffer');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'rejectFileOffer');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'acceptFileOffer');
        // Closed receive options expose only their disclosure control.
        await page.evaluate(()=>{document.querySelector('#recoveryReceiveOptions').hidden=false;document.querySelector('#localResumeOption').hidden=true;});
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(()=>document.activeElement.parentElement.id),'recoveryReceiveOptions');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'durableLocalReceive');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'acceptFileOffer');
        await page.evaluate(()=>{const checkbox=document.querySelector('#durableLocalReceive');checkbox.disabled=true;checkbox.tabIndex=0;});
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(()=>document.activeElement.parentElement.id),'recoveryReceiveOptions');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'acceptFileOffer');
        await page.locator('#rejectFileOffer').click();
        assert.equal(await page.locator('#fileOfferDialog').isVisible(), false);
        await page.evaluate(()=>{if(window.ZeydropRecovery)window.ZeydropRecovery.supported=window.__smokeRecoverySupported;});
        await page.locator('#leaveRoomBtn').click(); assert.equal(await page.locator('#inviteCreated').isHidden(), true); assert.deepEqual(errors, []);
        await page.evaluate(()=>{
            window.__smokePeersUI=new PeersUI();
            window.__smokePeersUI.add({id:'ui-only-peer',name:{deviceName:'<strong>UI-only fixture</strong>'}});
            window.__smokePeersUI.state({peerId:'ui-only-peer',state:'connecting',path:{direct:false},candidates:{host:2,srflx:1},ready:false,verified:false});
        });
        assert.equal(await page.locator('#peerPathDetail').isHidden(),true);
        assert.equal(await page.locator('#ui-only-peer .name').innerText(),'<strong>UI-only fixture</strong>');
        assert.equal(await page.locator('#ui-only-peer .name strong').count(),0);
        await openMore(page); await page.locator('#connectionDetails summary').focus();await page.keyboard.press('Enter');
        assert.equal(await page.locator('#peerPathDetail').isVisible(),true);
        assert.match(await page.locator('#peerPathDetail').innerText(),/host 2/);
        await page.evaluate(()=>window.__smokePeersUI.state({peerId:'ui-only-peer',state:'connected',path:{direct:true,protocol:'udp',family:'IPv4',localType:'host',remoteType:'host',rtt:2},candidates:{host:2,srflx:1},ready:true,code:'0000 0000 0000',verified:false}));
        assert.equal(await page.locator('#ui-only-peer input[type=file]').isDisabled(),true);
        assert.equal(await page.locator('#ui-only-peer .verify-peer').isDisabled(),false);
        await page.evaluate(()=>{document.getElementById('ui-only-peer').remove();window.__smokePeersUI.count();});
        await page.evaluate(()=>{
            Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
            Events.fire('text-received',{text:'可手动复制的测试文本'});
        });
        await page.locator('#copy').click();
        assert.equal(await page.locator('#receiveTextDialog[show]').isVisible(),true,'clipboard failure keeps the text available');
        assert.equal(await page.evaluate(()=>getSelection().toString()),'可手动复制的测试文本');
        assert.match(await page.locator('#toast').innerText(),/复制选中的文本/);
        await page.locator('#receiveTextDialog button[close]').click();
        await page.evaluate(()=>Events.fire('text-recipient','ui-only-peer'));
        await page.locator('#textInput').focus();await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'取消');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'textInput');
        await page.keyboard.press('Escape');
        assert.deepEqual(errors,[]);
        const diagnosticDownload = page.waitForEvent('download'); await openMore(page); await page.locator('#exportDiagnostics').click();
        const report = JSON.parse(await fs.readFile(await (await diagnosticDownload).path(), 'utf8'));
        assert.equal(report.product, 'Zeydrop'); assert.ok(report.events.some(event=>event.kind==='signaling' && event.state==='connected'));
        await fs.mkdir('test-results', { recursive:true }); await fs.writeFile('test-results/smoke-'+engine+'.json',JSON.stringify({passed:true, engine, tests:['render','WS session','invite + QR','leave','mobile overflow and capability-gated opt-in send checklist','visible consent dialog and reject','hidden-capability keyboard focus cycles','keyboard connection details and escaped fixture name','file selection blocked before identity confirmation (UI fixture)','clipboard unavailable manual copy and contenteditable keyboard cycle','local diagnostic export'], limitation:'UI smoke only; fixture direct-path state is not a real connection; no Safari WebRTC or iOS device claim'},null,2));
        console.log('PASS', engine, 'UI smoke');
    } finally { await browser?.close(); await server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
