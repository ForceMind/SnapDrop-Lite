'use strict';
// Experimental *diagnostic*, not a WebKit compatibility pass/fail test.
// No raw candidate/SDP/IP ever leaves process memory or enters logs.
// Isolates browser WebRTC ICE primitives from Zeydrop's signaling protocol.
const http=require('node:http');
const {chromium,webkit}=require('playwright');
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function runPair(label,engines,url) {
    const browsers=[],pages=[],queues=[[],[]],ready=[false,false];
    const trace={label,send:[0,0],received:[0,0],addFailures:[],stages:[]};
    try {
        for(let i=0;i<2;i++) {
            const browser=await engines[i].launch({headless:true});
            browsers.push(browser);
            const page=await browser.newPage();
            pages.push(page);
            await page.exposeFunction('__emitIce',async candidate=>{
                if(typeof candidate?.candidate!=='string'||!/ typ (host|srflx|prflx)( |$)/.test(candidate.candidate))return;
                trace.send[i]++;
                const dest=1-i;
                if(!ready[dest]){queues[dest].push(candidate);return;}
                try{await pages[dest].evaluate(c=>window.__pc.addIceCandidate(c),candidate);trace.received[dest]++;}
                catch(e){trace.addFailures.push(String(e?.name||'ICE error').slice(0,50));}
            });
            await page.goto(url);
            await page.evaluate(()=>{
                window.__pc=new RTCPeerConnection({iceServers:[]});
                window.__channelOpen=false;
                window.__pc.onicecandidate=e=>{if(e.candidate)void window.__emitIce(e.candidate.toJSON());};
                window.__pc.ondatachannel=e=>{
                    window.__remoteChannel=e.channel;
                    e.channel.onopen=()=>{window.__channelOpen=true;};
                };
            });
        }
        await pages[0].evaluate(()=>{
            window.__localChannel=window.__pc.createDataChannel('primitive-probe',{ordered:true});
            window.__localChannel.onopen=()=>{window.__channelOpen=true;};
        });
        const offer=await pages[0].evaluate(async()=>{
            const x=await window.__pc.createOffer();
            await window.__pc.setLocalDescription(x);
            return {type:x.type,sdp:x.sdp};
        });
        const answer=await pages[1].evaluate(async x=>{
            await window.__pc.setRemoteDescription(x);
            const y=await window.__pc.createAnswer();
            await window.__pc.setLocalDescription(y);
            return {type:y.type,sdp:y.sdp};
        },offer);
        await pages[0].evaluate(async x=>window.__pc.setRemoteDescription(x),answer);
        trace.stages.push('offer-and-answer-installed');
        ready[0]=ready[1]=true;
        for(let i=0;i<2;i++)for(const candidate of queues[i]) {
            try{await pages[i].evaluate(c=>window.__pc.addIceCandidate(c),candidate);trace.received[i]++;}
            catch(e){trace.addFailures.push(String(e?.name||'ICE error').slice(0,50));}
        }
        const until=Date.now()+15000;
        let state;
        do {
            state=await Promise.all(pages.map(page=>page.evaluate(async()=>{
                const pc=window.__pc;
                let stats;
                try{stats=await pc.getStats();}catch{}
                const entries=stats?[...stats.values()]:[];
                const ice=pc.sctp?.transport?.iceTransport;
                const pair=ice?.getSelectedCandidatePair?.();
                return {rtc:pc.connectionState,ice:pc.iceConnectionState,
                    gathering:pc.iceGatheringState,channelOpen:window.__channelOpen===true,
                    selectedPairPresent:!!pair,
                    selectedStatsPresent:entries.some(s=>s.type==='transport'&&!!s.selectedCandidatePairId),
                    pairSucceeded:entries.some(s=>s.type==='candidate-pair'&&s.state==='succeeded'),
                    localCandidateCount:entries.filter(s=>s.type==='local-candidate').length,
                    remoteCandidateCount:entries.filter(s=>s.type==='remote-candidate').length};
            })));
            if(state.every(v=>v.channelOpen))break;
            await sleep(300);
        }while(Date.now()<until);
        return { ...trace,connected:state.every(v=>v.channelOpen),endpoints:state,
            explanation:state.every(v=>v.channelOpen)?'Primitive DataChannel opened without Zeydrop signaling':
                'Bare WebRTC primitive did not open DataChannel within 15 s; this is diagnostic, not a product success or Safari hardware verdict'};
    } catch(e) {
        return {...trace,connected:false,protocolErrorType:String(e?.name||'Error').slice(0,50),
            explanation:'Bare RTCPeerConnection attempt did not finish negotiation'};
    } finally {
        await Promise.all(pages.map(page=>page.evaluate(()=>window.__pc?.close()).catch(()=>{})));
        await Promise.all(browsers.map(browser=>browser.close().catch(()=>{})));
    }
}
async function main() {
    const server=http.createServer((_,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>RTC primitive probe</title>');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        const url='http://127.0.0.1:'+server.address().port;
        const mixed=await runPair('chromium-webkit',[chromium,webkit],url);
        const webkitOnly=await runPair('webkit-webkit',[webkit,webkit],url);
        console.log('Sanitized browser-primitive control:',JSON.stringify({mixed,webkitOnly,
            warning:'Same CI host, STUN off. The probe does not attest to NAT topology, public reachability or iOS Safari.'}));
        // Do not assert that WebKit supports this CI environment; the separate
        // WebKit direct-file test remains the strict release blocker.
    } finally { await new Promise(resolve=>server.close(resolve)); }
}
main().catch(err=>{console.error('Primitive probe infrastructure error:',String(err?.name||'Error'));process.exitCode=1;});
