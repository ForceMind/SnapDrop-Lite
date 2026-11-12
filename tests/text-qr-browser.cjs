'use strict';
const { openMore } = require('./workspace-ui-helpers.cjs');
// Native application UI, selected non-relay DataChannel, local QR pixels and
// independent ZBar decoding. All inputs are disposable synthetic test content.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const { decodeQrPng, selfTest } = require('./decode-qr.cjs');
const { rtcEndpointSnapshot } = require('./rtc-diagnostics.cjs');
const engines = { chromium, firefox, webkit };
const kind = error => ['AssertionError','TimeoutError','TypeError','RangeError','QrImageError','QrDecodeError','QrDecoderUnavailable'].includes(error?.name) ? error.name : 'Error';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function nativePath() {
    const peer = [...zeydrop.peers.peers.values()][0], pc = peer?._conn;
    if (!pc) return { selected: false };
    const known = ['host','srflx','prflx'];
    const summarize = (local, remote, method) => ({ selected: true, method,
        localType: local?.candidateType || local?.type || 'unknown', remoteType: remote?.candidateType || remote?.type || 'unknown',
        protocol: local?.protocol || remote?.protocol || 'unknown',
        direct: known.includes(local?.candidateType || local?.type) && known.includes(remote?.candidateType || remote?.type)
            && (local?.protocol || remote?.protocol) === 'udp' && (!local?.protocol || !remote?.protocol || local.protocol === remote.protocol) });
    const stats = await pc.getStats(); let pair;
    for (const item of stats.values()) if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId);
    if (!pair) pair = [...stats.values()].find(item => item.type === 'candidate-pair' && item.selected === true && item.state === 'succeeded');
    if (pair?.state === 'succeeded') return summarize(stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId), 'selected RTCStats pair');
    const selected = pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
    return selected?.local && selected?.remote ? summarize(selected.local, selected.remote, 'RTCIceTransport selected pair') : { selected: false };
}
async function layout(page) {
    const result = await page.evaluate(() => ({ documentFits: document.documentElement.scrollWidth <= innerWidth,
        dialogs: [...document.querySelectorAll('x-dialog[show] x-paper')].map(el => ({ fits: el.scrollWidth <= el.clientWidth + 1,
            insideViewport: el.getBoundingClientRect().left >= -1 && el.getBoundingClientRect().right <= innerWidth + 1 })) }));
    assert.equal(result.documentFits, true); assert.ok(result.dialogs.every(item => item.fits && item.insideViewport));
}
async function main() {
    const engine = process.env.BROWSER_TYPE || 'chromium'; assert.ok(engines[engine]);
    const report = { schema: 1, engine, phase: 'startup', cases: [], screenshots: [], errors: [], passed: false,
        scope: 'actual built UI + native same-host two-context UDP P2P + local PNG/ZBar; STUN disabled; not WAN, Safari/mobile hardware, delivery-ACK protocol, physical offline or camera scanning evidence' };
    let browser, server; const contexts = [], pages = [];
    const payloads = new Set(['PRIVATE_P2P_TEXT_SENTINEL','PRIVATE_P2P_FILE_BODY_SENTINEL','PRIVATE_P2P_FILE_NAME_SENTINEL','LOCAL_QR_PRIVATE_SENTINEL']);
    const leaks = value => [...payloads].some(marker => value.includes(marker) || value.includes(encodeURIComponent(marker)) || value.includes(JSON.stringify(marker).slice(1,-1)));
    const traffic = { websocketFrames: 0, websocketBytes: 0, binaryFrames: 0, websocketPayloadObserved: false,
        httpRequests: 0, httpBodyBytes: 0, httpPayloadObserved: false, uploadAttempts: 0, externalRequests: 0 };
    try {
        await fs.mkdir('test-results', { recursive: true }); report.decoder = await selfTest(); server = await startDev(0);
        server.signaling._wss.on('connection', socket => socket.on('message', (bytes, binary) => {
            traffic.websocketFrames++; traffic.websocketBytes += bytes.length; if (binary) traffic.binaryFrames++;
            if (leaks(bytes.toString())) traffic.websocketPayloadObserved = true;
        }));
        browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox','--disable-dev-shm-usage'] } : {}) });
        report.browserVersion = browser.version();
        for (let i = 0; i < 2; i++) {
            const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); contexts.push(context);
            context.on('request', request => {
                const body = request.postDataBuffer(); traffic.httpRequests++; traffic.httpBodyBytes += body?.length || 0;
                if (leaks(request.url()) || (body && leaks(body.toString()))) traffic.httpPayloadObserved = true;
                const url = new URL(request.url()); if (['http:','https:'].includes(url.protocol) && url.origin !== server.origin) traffic.externalRequests++;
                if (!['GET','HEAD'].includes(request.method()) || body?.length) traffic.uploadAttempts++;
            });
            await context.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                if ((['http:','https:'].includes(url.protocol) && url.origin !== server.origin) || !['GET','HEAD'].includes(request.method()) || request.postDataBuffer()?.length) return route.abort();
                return route.continue();
            });
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => { if (report.errors.length < 20) report.errors.push({ phase: report.phase, type: kind(error) }); });
            await page.route('**/config.js?*', route => route.fulfill({ contentType: 'text/javascript', body: 'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};' }));
            await page.addInitScript(() => {
                window.showSaveFilePicker = undefined; window.__observedText = [];
                window.addEventListener('text-received', event => { window.__observedText.push(event.detail.text); if (window.__observedText.length > 20) window.__observedText.shift(); });
            });
        }
        const [a,b] = pages;
        const screenshot = async (page, name, scheme, viewport) => {
            await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize(viewport); await page.evaluate(() => document.fonts.ready);
            const verifiedPair = name.startsWith('verified-pair-');
            if (verifiedPair) await page.waitForFunction(() => {
                const toast = document.getElementById('toast');
                return !toast || (!toast.hasAttribute('show') && Number(getComputedStyle(toast).opacity) === 0);
            }, null, { timeout: 7000 }); // Observe its own timer/CSS; never hide or alter the toast.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await layout(page);
            // A fixed QR overlay covers this viewport. Full-page stitching can
            // append offscreen background that was never part of the screen.
            const fullPage = !name.startsWith('qr-');
            const path = 'test-results/text-qr-' + engine + '-' + name + '.png'; await page.screenshot({ path, fullPage }); report.screenshots.push(path);
            (report.screenshotModes ||= {})[name] = { fullPage, viewport, ...(verifiedPair ? { toastHiddenNaturally: true } : {}) };
        };
        const qrBytes = async page => Buffer.from((await page.locator('#textQR').evaluate(canvas => canvas.toDataURL('image/png'))).split(',')[1], 'base64');
        const generate = async (page, text) => {
            await page.locator('#qrTextInput').fill(text); assert.equal(await page.locator('#qrTextInput').inputValue(), text);
            await page.locator('#generateTextQR').click(); await page.locator('#textQR:visible').waitFor(); await page.locator('#saveTextQR:visible').waitFor();
            assert.deepEqual(decodeQrPng(await qrBytes(page)), Buffer.from(text, 'utf8'));
        };
        const closeReceive = async page => page.locator('#receiveTextDialog button[close]').click();
        const sendText = async text => {
            await openMore(a); await a.locator('#sendTextAction').click(); await a.locator('#sendTextDialog[show]').waitFor();
            await a.locator('#textInput').fill(text); await a.locator('#sendTextDialog button[type=submit]').click();
            await a.locator('#sendTextDialog').waitFor({ state: 'hidden' });
        };
        await a.goto(server.origin); await a.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        report.revision = await a.locator('meta[name=build-revision]').getAttribute('content');
        report.phase = 'native-home-screenshots';
        await screenshot(a,'home-desktop-light','light',{width:1440,height:1000});
        await screenshot(a,'home-desktop-dark','dark',{width:1440,height:1000});
        await screenshot(a,'home-mobile-light','light',{width:390,height:844});
        report.phase = 'local-offline-qr';
        await openMore(a); await a.locator('#openTextTools').click(); assert.equal(await a.locator('#generateTextQR').isDisabled(),true);
        assert.equal(await a.locator('#textQR').isHidden(),true); assert.equal(await a.locator('#saveTextQR').isHidden(),true);
        await contexts[0].setOffline(true);
        const privateQr = '  LOCAL_QR_PRIVATE_SENTINEL\n中文 👋 <em>literal</em>\nhttps://example.test/a?x=1&y=2  ';
        await generate(a,privateQr); assert.deepEqual(decodeQrPng(await a.locator('#textQR').screenshot()),Buffer.from(privateQr));
        const downloadWait = a.waitForEvent('download'); await a.locator('#saveTextQR').click(); const download = await downloadWait;
        assert.deepEqual(decodeQrPng(await fs.readFile(await download.path())),Buffer.from(privateQr));
        await a.locator('#qrTextInput').fill('changed draft'); assert.equal(await a.locator('#textQR').isHidden(),true); assert.equal(await a.locator('#saveTextQR').isHidden(),true);
        assert.ok(!await a.locator('#saveTextQR').getAttribute('href'));
        const tooLarge = '汉'.repeat(267); await a.locator('#qrTextInput').fill(tooLarge);
        assert.equal(await a.locator('#generateTextQR').isDisabled(),true); assert.match(await a.locator('#qrTextStatus').innerText(),/800/);
        assert.equal(await a.locator('#qrTextInput').inputValue(),tooLarge); assert.equal(await a.locator('#textQR').isHidden(),true);
        await generate(a,'a'.repeat(800)); await a.locator('#clearTextQR').click(); assert.equal(await a.locator('#qrTextInput').inputValue(),'');
        assert.equal(await a.locator('#textQR').isHidden(),true); assert.equal(await a.locator('#saveTextQR').isHidden(),true);
        report.cases.push('loaded page generates/independently decodes native QR preview and downloaded PNG while HTTP is offline; UTF-8/whitespace/800-byte boundary and invalidation verified');
        await contexts[0].setOffline(false); await a.waitForFunction(() => document.querySelector('#signalStatus').dataset.state === 'connected');
        const visibleQr = '给朋友的一条消息 👋\n闪投，让分享更直接。\nDirect by design.'; payloads.add(visibleQr); await generate(a,visibleQr);
        report.phase = 'native-qr-screenshots';
        await screenshot(a,'qr-desktop-light','light',{width:1440,height:1000});
        await screenshot(a,'qr-desktop-dark','dark',{width:1440,height:1000});
        await screenshot(a,'qr-mobile-light','light',{width:390,height:844});
        await a.setViewportSize({width:320,height:740}); await layout(a); await a.setViewportSize({width:1440,height:1000});
        report.phase = 'qr-async-retirement';
        // Delay actual encoder execution, not its output or connection state.
        // The successful visual captures above precede this isolated fault seam.
        await a.evaluate(() => { const qr=window.ZeydropQR; window.__qrOriginal=qr.toCanvas;
            qr.toCanvas=(...args)=>new Promise((resolve,reject)=>{window.__qrRelease=()=>Promise.resolve(window.__qrOriginal.apply(qr,args)).then(resolve,reject);}); });
        try {
            await a.locator('#qrTextInput').fill('old delayed value'); await a.locator('#generateTextQR').click(); await a.waitForFunction(()=>typeof window.__qrRelease==='function');
            await a.locator('#qrTextInput').fill('new draft survives'); await a.evaluate(()=>window.__qrRelease());
            assert.equal(await a.locator('#qrTextInput').inputValue(),'new draft survives'); assert.equal(await a.locator('#textQR').isHidden(),true); assert.equal(await a.locator('#saveTextQR').isHidden(),true);
            await a.evaluate(()=>{delete window.__qrRelease;}); await a.locator('#qrTextInput').fill('delayed then closed'); await a.locator('#generateTextQR').click(); await a.waitForFunction(()=>typeof window.__qrRelease==='function');
            await a.locator('#closeTextQR').click(); await a.evaluate(()=>window.__qrRelease());
            assert.equal(await a.locator('#textQrDialog').isHidden(),true); assert.equal(await a.locator('#qrTextInput').inputValue(),''); assert.equal(await a.locator('#textQR').isHidden(),true);
        } finally { await a.evaluate(()=>{window.ZeydropQR.toCanvas=window.__qrOriginal;delete window.__qrOriginal;delete window.__qrRelease;}); }
        report.cases.push('explicitly delayed real encoder cannot publish over a changed draft or reopen a closed tool; no connection/UI-success fixture used');
        report.phase = 'native-pair';
        await a.locator('#createRoomBtn').click(); await a.waitForFunction(()=>document.querySelector('#inviteUrl').value.includes('#room='));
        await b.goto(await a.locator('#inviteUrl').inputValue());
        for (const page of pages) await page.waitForFunction(()=>[...zeydrop.peers.peers.values()][0]?._path?.direct,null,{timeout:45000});
        const codes=await Promise.all(pages.map(page=>page.locator('.security-code').innerText())); assert.equal(codes[0],codes[1]);
        for (const page of pages) await page.locator('.verify-peer').click();
        for (const page of pages) await page.waitForFunction(()=>[...zeydrop.peers.peers.values()][0]?._canSend());
        report.paths=await Promise.all(pages.map(page=>page.evaluate(nativePath))); assert.ok(report.paths.every(path=>path.selected&&path.direct&&path.protocol==='udp'));
        report.phase = 'controlled-canvas-resource-fault';
        for (const mode of ['null', 'throw']) {
            await openMore(a); await a.locator('#openTextTools').click(); await generate(a, 'LOCAL_QR_PRIVATE_SENTINEL canvas resource probe');
            await a.evaluate(mode => {
                const canvas = document.getElementById('textQR');
                window.__canvasOwnContext = Object.getOwnPropertyDescriptor(canvas, 'getContext');
                Object.defineProperty(canvas, 'getContext', { configurable: true, value: () => {
                    if (mode === 'throw') throw new DOMException('Synthetic canvas resource fault', 'InvalidStateError');
                    return null;
                } });
            }, mode);
            try {
                await a.locator('#qrTextInput').fill('LOCAL_QR_PRIVATE_SENTINEL draft remains editable');
                assert.equal(await a.locator('#generateTextQR').isDisabled(), true);
                assert.match(await a.locator('#qrTextStatus').innerText(), /无法生成二维码/);
                assert.equal(await a.locator('#textQR').isHidden(), true);
                assert.equal(await a.locator('#saveTextQR').getAttribute('href'), null);
                await a.locator('#clearTextQR').click(); assert.equal(await a.locator('#qrTextInput').inputValue(), '');
                await a.locator('#closeTextQR').click(); await a.locator('#textQrDialog').waitFor({ state: 'hidden' });
            } finally {
                await a.evaluate(() => {
                    const canvas = document.getElementById('textQR');
                    if (window.__canvasOwnContext) Object.defineProperty(canvas, 'getContext', window.__canvasOwnContext);
                    else delete canvas.getContext;
                    delete window.__canvasOwnContext;
                });
            }
            for (const page of pages) assert.equal(await page.evaluate(() => [...zeydrop.peers.peers.values()][0]._canSend()), true);
        }
        await openMore(a); await a.locator('#openTextTools').click(); await generate(a, 'LOCAL_QR_PRIVATE_SENTINEL recovers without reconnecting'); await a.locator('#closeTextQR').click();
        report.cases.push('controlled per-canvas null/throw faults retire the old QR/download, allow editing/clear/close, preserve the native verified peer and recover real encoding without reconnecting');
        report.cases.push('real native selected non-relay UDP path and matching DTLS codes; each user confirmation clicked before sending');
        report.phase = 'native-text-and-qr-return';
        const text='PRIVATE_P2P_TEXT_SENTINEL\n中文与 emoji 👋\n<em data-untrusted>原样文字</em>\nhttps://example.test/a?x=1&y=2';
        await sendText(text); await b.locator('#receiveTextDialog[show]').waitFor(); assert.equal(await b.locator('#text').textContent(),text);
        assert.equal(await b.locator('#text em, #text a').count(),0);
        // Controlled clipboard timing only: native messages and modal state are
        // real. A late copy must not consume/choose hidden received content.
        await b.evaluate(() => {
            window.__clipOwn = Object.getOwnPropertyDescriptor(navigator,'clipboard'); window.__clipHadOwn = !!window.__clipOwn; window.__clipCalls = [];
            Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText(){return new Promise((resolve,reject)=>window.__clipCalls.push({resolve,reject}));}}});
        });
        for (const outcome of ['resolve','reject']) {
            await b.locator('#copy').click(); await b.waitForFunction(()=>window.__clipCalls.length===1);
            await b.locator('#receiveTextQR').click(); await b.locator('#textQrDialog[show]').waitFor();
            await b.evaluate(mode=>{const call=window.__clipCalls.shift();if(mode==='resolve')call.resolve();else call.reject(new DOMException('Synthetic delayed clipboard rejection','NotAllowedError'));},outcome);
            await b.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            assert.equal(await b.locator('x-dialog[show]').count(),1); assert.equal(await b.locator('#textQrDialog').isVisible(),true);
            assert.equal(await b.evaluate(()=>document.getElementById('textQrDialog').contains(document.activeElement)),true);
            assert.equal(await b.evaluate(()=>{const text=document.getElementById('text'),selection=getSelection();return text.contains(selection?.anchorNode)||text.contains(selection?.focusNode);}),false);
            await b.locator('#closeTextQR').click(); await b.locator('#receiveTextDialog[show]').waitFor(); assert.equal(await b.locator('#text').textContent(),text);
        }
        report.cases.push('controlled late clipboard resolution/rejection cannot consume the real received message or select/focus behind QR');
        await b.locator('#receiveTextQR').click(); await b.locator('#textQrDialog[show]').waitFor(); assert.equal(await b.locator('#qrTextInput').inputValue(),text);
        await b.locator('#generateTextQR').click(); await b.locator('#textQR:visible').waitFor(); assert.deepEqual(decodeQrPng(await qrBytes(b)),Buffer.from(text));
        const queued='PRIVATE_P2P_TEXT_SENTINEL queued while QR remains active'; await sendText(queued);
        await b.waitForFunction(value=>window.__observedText.at(-1)===value,queued);
        await b.waitForFunction(()=>document.querySelector('#textQrDialog').hasAttribute('show')&&document.querySelector('#textQrDialog').contains(document.activeElement));
        assert.equal(await b.locator('#receiveTextDialog').isHidden(),true); assert.equal(await b.locator('#qrTextInput').inputValue(),text);
        await b.locator('#closeTextQR').click(); await b.locator('#receiveTextDialog[show]').waitFor(); assert.equal(await b.locator('#text').textContent(),text);
        await b.locator('#copy').click(); await b.locator('#copy').click(); await b.waitForFunction(()=>window.__clipCalls.length===2);
        await b.evaluate(()=>window.__clipCalls.shift().resolve()); await b.waitForFunction(value=>document.getElementById('text').textContent===value,queued);
        await b.evaluate(()=>window.__clipCalls.shift().resolve()); await b.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await b.locator('#receiveTextDialog').isVisible(),true); assert.equal(await b.locator('#text').textContent(),queued);
        await closeReceive(b);
        await b.evaluate(()=>{if(window.__clipHadOwn)Object.defineProperty(navigator,'clipboard',window.__clipOwn);else delete navigator.clipboard;delete window.__clipOwn;delete window.__clipHadOwn;delete window.__clipCalls;});
        report.cases.push('two delayed copies of the first real message cannot consume its queued successor');
        await openMore(a); await a.locator('#sendTextAction').click(); const draft='  待发送的草稿 👋\n保持原文  '; await a.locator('#textInput').fill(draft); await a.locator('#sendTextQR').click();
        assert.equal(await a.locator('#qrTextInput').inputValue(),draft); await a.locator('#closeTextQR').click(); await a.locator('#sendTextDialog[show]').waitFor(); assert.equal(await a.locator('#textInput').inputValue(),draft);
        await a.setViewportSize({width:320,height:740}); await layout(a); await a.setViewportSize({width:1440,height:1000});
        const submit=a.locator('#sendTextDialog button[type=submit]'); await a.locator('#textInput').fill('');
        if (await submit.isEnabled()) await submit.click(); assert.equal(await a.locator('#sendTextDialog').isVisible(),true); assert.equal(await a.locator('#textInput').inputValue(),'');
        await a.locator('#textInput').fill('x'.repeat(4097));
        if (await submit.isEnabled()) await submit.click(); assert.equal(await a.locator('#sendTextDialog').isVisible(),true); assert.equal(await a.locator('#textInput').inputValue(),'x'.repeat(4097));
        await a.locator('#sendTextDialog button[close]').click();
        const newlines='\n'.repeat(4096); await sendText(newlines); await b.locator('#receiveTextDialog[show]').waitFor(); assert.equal(await b.locator('#text').textContent(),newlines); await closeReceive(b);
        report.cases.push('real Unicode/newline/HTML-literal text arrives intact; QR return preserves original drafts, incoming text does not steal QR focus, 4097 remains a draft and 4096 newlines transfer');
        report.phase = 'native-file-and-modal-queue';
        await openMore(b); await b.locator('#openTextTools').click(); await b.locator('#qrTextInput').fill('本机工具保持焦点');
        const file={name:'PRIVATE_P2P_FILE_NAME_SENTINEL.txt',mimeType:'text/plain',buffer:Buffer.from('PRIVATE_P2P_FILE_BODY_SENTINEL\n'.repeat(4096))}; payloads.add(hash(file.buffer));
        await a.locator('x-peer input[type=file]').setInputFiles(file);
        await b.waitForFunction(()=>!![...zeydrop.peers.peers.values()][0]?._incoming);
        assert.equal(await b.locator('#textQrDialog').isVisible(),true); assert.equal(await b.locator('#fileOfferDialog').isHidden(),true);
        assert.equal(await b.evaluate(()=>document.getElementById('textQrDialog').contains(document.activeElement)),true);
        assert.equal(await b.evaluate(()=>[...zeydrop.peers.peers.values()][0]._incoming.offset),0);
        await b.locator('#closeTextQR').click(); await b.locator('#fileOfferDialog[show]').waitFor(); await b.locator('#acceptFileOffer').click(); await b.locator('#receiveDialog[show]').waitFor();
        assert.match(await b.locator('#fileSize').innerText(),new RegExp(hash(file.buffer)));
        const fileWait=b.waitForEvent('download');await b.locator('#download').click();const received=await fs.readFile(await(await fileWait).path());assert.deepEqual(received,file.buffer);
        await a.waitForFunction(()=>![...zeydrop.peers.peers.values()][0]._outgoing);report.file={bytes:received.length,sha256:hash(received)};
        report.cases.push('real file offer waits behind QR without focus theft or pre-consent bytes; downloaded content and independent SHA-256 match');
        report.phase = 'native-verified-pair-screenshot';await screenshot(a,'verified-pair-desktop-light','light',{width:1440,height:1000});
        report.phase = 'native-send-failure-draft';
        await openMore(a); await a.locator('#sendTextAction').click();const failedDraft='PRIVATE_P2P_TEXT_SENTINEL unsent after channel close';await a.locator('#textInput').fill(failedDraft);
        await a.evaluate(()=>[...zeydrop.peers.peers.values()][0]._channel.close());await a.waitForFunction(()=>![...zeydrop.peers.peers.values()][0]?._canSend());
        if(await submit.isEnabled())await submit.click();else await a.locator('#sendTextDialog form').evaluate(form=>form.requestSubmit());
        assert.equal(await a.locator('#sendTextDialog').isVisible(),true);assert.equal(await a.locator('#textInput').inputValue(),failedDraft);
        report.cases.push('a real native DataChannel close makes send fail while retaining the draft; UI does not claim delivered acknowledgement');
        assert.equal(traffic.binaryFrames,0);assert.equal(traffic.websocketPayloadObserved,false);assert.equal(traffic.httpPayloadObserved,false);
        assert.equal(traffic.httpBodyBytes,0);assert.equal(traffic.uploadAttempts,0);assert.equal(traffic.externalRequests,0);assert.deepEqual(report.errors,[]);
        report.receivedTextEvents=await b.evaluate(()=>window.__observedText.length);
        report.network=traffic;report.cases.push('observed server WS and browser HTTP contain no text/file body or file hash; no binary WS, upload or external request');
        report.passed=true;report.phase='complete';
    } catch(error) {
        report.failure=kind(error);const line=String(error?.stack||'').match(/text-qr-browser\.cjs:(\d+):(\d+)/);if(line)report.failureLine={line:Number(line[1]),column:Number(line[2])};
        if(/Executable doesn't exist/.test(String(error?.message)))report.failureCode='browser-executable-unavailable';
        else if(/Operation not permitted|\bEPERM\b/.test(String(error?.message)))report.failureCode='runtime-operation-denied';
        report.network=traffic;report.debug=await Promise.all(pages.map(page=>page.evaluate(rtcEndpointSnapshot,engine).catch(()=>({unavailable:true}))));throw error;
    } finally {
        await fs.mkdir('test-results',{recursive:true});await fs.writeFile('test-results/text-qr-'+engine+'.json',JSON.stringify(report,null,2)+'\n');
        await Promise.allSettled(contexts.map(context=>context.close()));await browser?.close();await server?.close();
    }
    console.log('Text/QR native browser evidence:',JSON.stringify(report));
}
main().catch(error=>{console.error('Text/QR browser test failed:',kind(error));process.exitCode=1;});
