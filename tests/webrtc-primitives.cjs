'use strict';
// Diagnostic control: actual browser primitives, with no Zeydrop signaling or
// candidate rewriting. A failed probe is recorded, never a product success.
const http = require('node:http');
const fs = require('node:fs/promises');
const { chromium, firefox, webkit } = require('playwright');
const { installRtcTrace, rtcEndpointSnapshot } = require('./rtc-diagnostics.cjs');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const engines = { chromium, firefox, webkit };
const matrix = [['chromium','chromium'],['firefox','firefox'],['chromium','firefox'],
    ['chromium','webkit'],['firefox','webkit'],['webkit','webkit']];
async function runPair(names, url, mode = 'trickle', chromiumUnmask = false) {
    const browsers = [], pages = [], queues = [[],[]], ready = [false,false];
    const chains = [Promise.resolve(),Promise.resolve()];
    const trace = { engines:names, mode, candidatePolicy:chromiumUnmask?'chromium-mDNS-disabled-test-control':'browser-default', emitted:[0,0], emittedEndMarkers:[0,0], delivered:[0,0], addFailures:[], stages:[] };
    let closing = false;
    const deliver = (target, candidate) => {
        chains[target] = chains[target].then(async () => {
            if (closing) return;
            try { await pages[target].evaluate(c => window.__primitivePeer.addIceCandidate(c), candidate); trace.delivered[target]++; }
            catch (error) { trace.addFailures.push(['TypeError','OperationError','InvalidStateError'].includes(error?.name) ? error.name : 'Error'); }
        });
        return chains[target];
    };
    try {
        for (let i=0;i<2;i++) {
            // This is an isolated test control, not a product recommendation.
            // Chromium's flag only helps isolate mDNS resolution from ICE itself.
            const browser = await engines[names[i]].launch({headless:true,...(chromiumUnmask && names[i]==='chromium'?{args:['--disable-features=WebRtcHideLocalIpsWithMdns']}:{})}); browsers.push(browser);
            (trace.browserVersions ||= []).push(browser.version());
            const page = await browser.newPage(); pages.push(page);
            await page.addInitScript(installRtcTrace);
            await page.exposeFunction('__emitIce', async candidate => {
                if (typeof candidate?.candidate !== 'string')return;
                if(candidate.candidate==='') {
                    trace.emittedEndMarkers[i]++;
                    if(mode!=='trickle-end-marker')return;
                } else if (!/ typ (host|srflx|prflx)( |$)/.test(candidate.candidate)) return;
                trace.emitted[i]++;
                if (mode === 'gathered-sdp') return;
                const target=1-i;
                if (!ready[target]) { queues[target].push(candidate); return; }
                await deliver(target,candidate);
            });
            await page.goto(url);
            await page.evaluate(() => {
                const pc=window.__primitivePeer=new RTCPeerConnection({iceServers:[]});
                window.__probeReceived=0;
                const bind=channel=>{
                    window.__primitiveChannel=channel;
                    channel.onmessage=event=>{if(event.data==='zeydrop-primitive-probe')window.__probeReceived++;};
                };
                window.__bindProbeChannel=bind;
                pc.onicecandidate=event=>{if(event.candidate)void window.__emitIce(event.candidate.toJSON());};
                pc.ondatachannel=event=>bind(event.channel);
            });
        }
        await pages[0].evaluate(() => window.__bindProbeChannel(window.__primitivePeer.createDataChannel('primitive-probe',{ordered:true})));
        const offer = await pages[0].evaluate(async mode => {
            const pc=window.__primitivePeer,offer=await pc.createOffer(); await pc.setLocalDescription(offer);
            if(mode==='gathered-sdp' && pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('ICE gathering timeout')),8000);
                pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});
            });
            return {type:pc.localDescription.type,sdp:pc.localDescription.sdp};
        },mode);
        const answer = await pages[1].evaluate(async ({offer,mode}) => {
            const pc=window.__primitivePeer; await pc.setRemoteDescription(offer);
            await pc.setLocalDescription(await pc.createAnswer());
            if(mode==='gathered-sdp' && pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('ICE gathering timeout')),8000);
                pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});
            });
            return {type:pc.localDescription.type,sdp:pc.localDescription.sdp};
        },{offer,mode});
        await pages[0].evaluate(answer=>window.__primitivePeer.setRemoteDescription(answer),answer);
        trace.stages.push('offer-and-answer-installed'); ready[0]=ready[1]=true;
        for(let i=0;i<2;i++)for(const candidate of queues[i].splice(0))await deliver(i,candidate);
        const deadline=Date.now()+15000;
        let endpoints;
        do {
            endpoints=await Promise.all(pages.map((page,i)=>page.evaluate(rtcEndpointSnapshot,names[i])));
            if(endpoints.every(endpoint=>endpoint.channelState==='open'))break;
            await sleep(250);
        }while(Date.now()<deadline);
        const channelOpened=endpoints.every(endpoint=>endpoint.channelState==='open');
        let dataDelivered=false;
        if(channelOpened) {
            for(const page of pages)await page.evaluate(()=>window.__primitiveChannel.send('zeydrop-primitive-probe'));
            await Promise.all(pages.map(page=>page.waitForFunction(()=>window.__probeReceived===1,null,{timeout:3000})));
            dataDelivered=true;
        }
        return {...trace,channelOpened,dataDelivered,endpoints,
            interpretation:channelOpened ? 'Native DataChannel opened; this does not validate Zeydrop authorization or WAN topology' :
                'Native DataChannel did not open within 15 seconds without any Zeydrop signaling; no Safari hardware conclusion'};
    } catch(error) {
        return {...trace,channelOpened:false,dataDelivered:false,errorType:['TypeError','TimeoutError','OperationError'].includes(error?.name)?error.name:'Error',
            interpretation:'Browser primitive probe could not finish; no successful transfer claim'};
    } finally {
        closing=true;
        await Promise.all(chains.map(p=>p.catch(()=>{})));
        await Promise.all(pages.map(page=>page.evaluate(()=>window.__primitivePeer?.close()).catch(()=>{})));
        await Promise.all(browsers.map(browser=>browser.close().catch(()=>{})));
    }
}
async function main() {
    const server=http.createServer((_,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>RTC primitive probe</title>');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        const url='http://127.0.0.1:'+server.address().port,results=[];
        for(const pair of matrix)results.push(await runPair(pair,url));
        // Compare full-gathered SDP to trickle for two failing controls. Neither
        // mode rewrites candidate addresses or grants an unproven product path.
        for(const pair of [['chromium','webkit'],['webkit','webkit']]) {
            if(!results.find(result=>result.engines.join('-')===pair.join('-')).channelOpened)
                results.push(await runPair(pair,url,'gathered-sdp'));
        }
        if(!results.find(result=>result.engines.join('-')==='chromium-webkit').channelOpened) {
            results.push(await runPair(['chromium','webkit'],url,'trickle-end-marker'));
            results.push(await runPair(['chromium','webkit'],url,'trickle-end-marker',true));
        }
        const report={schema:1,playwright:require('playwright/package.json').version,platform:process.platform,results,
            scope:'same-host native primitive control; STUN disabled; no file/SDP/IP or candidate strings in output; not WAN or real Safari evidence'};
        await fs.mkdir('test-results',{recursive:true});
        await fs.writeFile('test-results/webrtc-primitives.json',JSON.stringify(report,null,2)+'\n');
        console.log('Sanitized browser primitive matrix:',JSON.stringify(report));
        // Diagnostic matrix intentionally does not turn an unavailable WebKit
        // backend into success. webkit-transfer.cjs remains a strict gate.
    } finally {await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error('Primitive probe infrastructure error:',error?.name||'Error');process.exitCode=1;});
