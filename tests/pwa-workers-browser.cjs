'use strict';
// Chromium's real service worker and Cache Storage, with native offline
// dedicated Workers. Fresh isolated context; no peer, account, or user file.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const{chromium}=require('playwright');
const{startDev}=require('../scripts/dev.cjs');
const errorType=error=>['AssertionError','TimeoutError','TypeError','SecurityError','QuotaExceededError',
    'HashWorkerError','HashTimeoutError','HashReadError'].includes(error?.name)?error.name:'Error';
async function main(){
    const report={schema:1,engine:'chromium',scope:'current-version cached shell and native hash/recovery Workers in a fresh offline document; not update activation, Safari, mobile hardware, or public-network evidence',
        phase:'startup',checks:[],errors:[],offlineWorkers:[],passed:false};
    let server,browser,context,page,serviceWorker;
    try{
        await fs.mkdir('test-results',{recursive:true});server=await startDev(0);
        browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{
            executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{} )});
        report.browserVersion=browser.version();context=await browser.newContext({serviceWorkers:'allow'});page=await context.newPage();
        page.on('pageerror',error=>{if(report.errors.length<20)report.errors.push({type:errorType(error),phase:report.phase});});
        page.on('worker',worker=>{
            if(!report.phase.startsWith('offline'))return;
            try{
                const url=new URL(worker.url()),script=url.pathname.split('/').at(-1);
                if(!['file-hash-worker.js','recovery-worker.js'].includes(script))return;
                report.offlineWorkers.push({script,version:/^[a-f0-9]{16}$/.test(url.searchParams.get('v')||'')?url.searchParams.get('v'):null,
                    phase:report.phase});
            }catch{}
        });
        report.phase='install-and-control';await page.goto(server.origin);
        await page.evaluate(()=>navigator.serviceWorker.ready);
        await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:30000});
        await page.reload();
        await page.waitForFunction(()=>!!navigator.serviceWorker.controller&&!!window.ZeydropFileHash&&!!window.ZeydropRecovery);
        report.cache=await page.evaluate(async()=>{
            const build=await(await fetch('/build.json',{cache:'no-store'})).json(),name='zeydrop-shell-'+build.revision;
            const cacheNames=await caches.keys();if(!cacheNames.includes(name))throw Error('Current shell cache is absent');
            const cache=await caches.open(name),requests=await cache.keys();
            const entries=requests.map(request=>new URL(request.url));
            const workerEntry=script=>{
                const matching=entries.filter(url=>url.pathname==='/scripts/'+script);
                const versioned=matching.find(url=>url.search==='?v='+build.revision);
                return{script,count:matching.length,exactVersionCached:!!versioned,
                    version:versioned?.searchParams.get('v')||null};
            };
            return{revision:build.revision,name,entryCount:requests.length,controllerActivated:navigator.serviceWorker.controller.state==='activated',
                workers:[workerEntry('recovery-worker.js'),workerEntry('file-hash-worker.js')],
                hashWorkerStillLazy:window.ZeydropFileHash._worker===null,peerCount:zeydrop.peers.peers.size};
        });
        assert.match(report.cache.revision,/^[a-f0-9]{16}$/);assert.equal(report.cache.controllerActivated,true);
        assert.equal(report.cache.hashWorkerStillLazy,true);assert.equal(report.cache.peerCount,0);
        for(const worker of report.cache.workers){assert.equal(worker.exactVersionCached,true);assert.equal(worker.version,report.cache.revision);}
        report.checks.push('the activated controlling service worker precaches both exact worker URLs with the current build revision');

        serviceWorker=context.serviceWorkers().find(worker=>{
            try{return new URL(worker.url()).pathname==='/service-worker.js';}catch{return false;}
        });
        assert.ok(serviceWorker,'actual service worker execution context must be visible');
        // Observation only: the production fetch handler still performs its
        // own native Cache Storage match and returns that exact Response.
        await serviceWorker.evaluate(()=>{
            const original=caches.match.bind(caches);globalThis.__pwaOriginalMatch=original;globalThis.__pwaWorkerCacheHits=[];
            caches.match=async(...args)=>{
                const response=await original(...args);
                try{
                    const request=args[0],url=new URL(typeof request==='string'?request:request.url,self.location.href);
                    const script=url.pathname.split('/').at(-1),version=url.searchParams.get('v');
                    if(response&&['recovery-worker.js','file-hash-worker.js'].includes(script)&&globalThis.__pwaWorkerCacheHits.length<20)
                        globalThis.__pwaWorkerCacheHits.push({script,version:/^[a-f0-9]{16}$/.test(version||'')?version:null,status:response.status});
                }catch{}
                return response;
            };
        });
        const session=await context.newCDPSession(page);
        await session.send('Network.clearBrowserCache');await session.send('Network.setCacheDisabled',{cacheDisabled:true});
        report.httpCacheCleared=true;
        report.phase='offline-reload';await context.setOffline(true);await page.reload({waitUntil:'load'});
        await page.waitForFunction(()=>!navigator.onLine&&!!navigator.serviceWorker.controller&&!!window.ZeydropFileHash&&!!window.ZeydropRecovery,
            null,{timeout:30000});
        report.offlineDocument=await page.evaluate(()=>({offline:navigator.onLine===false,controlled:!!navigator.serviceWorker.controller,
            hashWorkerStillLazy:window.ZeydropFileHash._worker===null,recoverySupported:window.ZeydropRecovery.supported,peerCount:zeydrop.peers.peers.size}));
        assert.equal(report.offlineDocument.offline,true);assert.equal(report.offlineDocument.controlled,true);
        assert.equal(report.offlineDocument.hashWorkerStillLazy,true);assert.equal(report.offlineDocument.recoverySupported,true);
        assert.equal(report.offlineDocument.peerCount,0);
        report.checks.push('after clearing the HTTP cache, the full application shell reloads offline under its real service worker');

        report.phase='offline-workers';
        report.hash=await page.evaluate(async()=>{
            const hasher=window.ZeydropFileHash,original=hasher._factory;let mainFactoryCalls=0;
            hasher._factory=()=>{mainFactoryCalls++;throw Error('Offline native Worker test must not use main fallback');};
            try{return{...await hasher.hash(new File(['abc'],'synthetic-offline.bin')),mainFactoryCalls};}
            finally{hasher._factory=original;}
        });
        assert.equal(report.hash.backend,'worker');assert.equal(report.hash.bytes,3);assert.equal(report.hash.mainFactoryCalls,0);
        assert.equal(report.hash.sha256,crypto.createHash('sha256').update('abc').digest('hex'));
        report.recovery=await page.evaluate(async()=>({available:await window.ZeydropRecovery.available(),
            records:(await window.ZeydropRecovery.list()).length,nativeWorker:window.ZeydropRecovery.worker instanceof Worker}));
        assert.equal(report.recovery.available,true);assert.equal(report.recovery.records,0);assert.equal(report.recovery.nativeWorker,true);
        report.cacheHits=await serviceWorker.evaluate(()=>globalThis.__pwaWorkerCacheHits||[]);
        for(const script of ['file-hash-worker.js','recovery-worker.js']){
            assert.ok(report.cacheHits.some(hit=>hit.script===script&&hit.version===report.cache.revision&&hit.status===200),
                'offline worker must actually match its exact revision in native Cache Storage: '+script);
            assert.ok(report.offlineWorkers.some(worker=>worker.script===script&&worker.version===report.cache.revision),
                'the offline document must create a real dedicated worker: '+script);
        }
        report.checks.push('a first hash Worker in the offline document matches cached built code and hashes abc against independent Node SHA-256');
        report.checks.push('the offline document creates its recovery Worker from the exact cached revision and probes/lists native OPFS without user files');
        report.recoveryLifecycle='the UI also probes recovery online during setup; the offline navigation creates a new document and a new offline recovery Worker';
        report.phase='offline-final-check';await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);
        report.passed=true;report.phase='complete';
    }catch(error){
        report.failure=errorType(error);const line=String(error?.stack||'').match(/pwa-workers-browser\.cjs:(\d+):(\d+)/);
        if(line)report.failureLine={line:Number(line[1]),column:Number(line[2])};throw error;
    }finally{
        try{
            if(page)await page.evaluate(async()=>{
                window.ZeydropFileHash?.cancelAll();window.ZeydropRecovery?.worker?.terminate();
                for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister();
                for(const name of await caches.keys())if(name.startsWith('zeydrop-shell-'))await caches.delete(name);
            }).catch(()=>{});
            if(serviceWorker)await serviceWorker.evaluate(()=>{if(globalThis.__pwaOriginalMatch)caches.match=globalThis.__pwaOriginalMatch;}).catch(()=>{});
            await fs.mkdir('test-results',{recursive:true});
            await fs.writeFile('test-results/pwa-workers-chromium.json',JSON.stringify(report,null,2)+'\n');
        }finally{await Promise.allSettled([context?.close(),browser?.close(),server?.close()]);}
    }
    console.log('PWA worker browser evidence:',JSON.stringify(report));
}
main().catch(error=>{console.error('PWA worker browser test failed:',errorType(error));process.exitCode=1;});
