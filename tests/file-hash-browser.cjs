'use strict';
// Real native Workers and built assets. All inputs are synthetic and stay in
// this browser; localhost timings do not establish mobile or WAN performance.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright');
const { startDev } = require('../scripts/dev.cjs');
const errorType = error => ['AssertionError','TimeoutError','TypeError','RangeError','SecurityError','NotAllowedError',
    'QuotaExceededError','AbortError','HashWorkerError','HashReadError','HashProtocolError','HashTimeoutError'].includes(error?.name) ? error.name : 'Error';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const repeatedDigest = (size,value) => {
    const hash=crypto.createHash('sha256'),chunk=Buffer.alloc(256*1024,value);
    for(let offset=0;offset<size;offset+=chunk.length)hash.update(chunk.subarray(0,Math.min(chunk.length,size-offset)));
    return hash.digest('hex');
};
async function main() {
    const name=process.env.BROWSER_TYPE||'chromium',engine={chromium,firefox,webkit}[name];
    if(!engine)throw TypeError('Unknown browser engine');
    const report={schema:1,engine:name,scope:'built native hash Worker, bounded main fallback and synthetic file benchmark; not mobile hardware or WAN evidence',
        checks:[],errors:[],phase:'startup',passed:false};
    let server,browser,context,page;
    try {
        await fs.mkdir('test-results',{recursive:true});
        server=await startDev(0);
        browser=await engine.launch({headless:true,...(name==='chromium'&&process.env.CHROMIUM_PATH
            ?{executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}:{} )});
        report.browserVersion=browser.version();
        context=await browser.newContext({serviceWorkers:'block'});page=await context.newPage();
        page.on('pageerror',error=>{if(report.errors.length<20)report.errors.push({type:errorType(error),phase:report.phase});});
        report.network={httpRequests:0,uploadAttempts:0,externalAttempts:0,signalingMessages:0,signalingBytes:0,fileDataObserved:false};
        const expectedVectors=[Buffer.alloc(0),Buffer.from('abc'),Buffer.alloc(256*1024+113,0x5a)];
        const expectedHashes=expectedVectors.map(digest),sentinel='ZEYDROP_HASH_FILENAME_SENTINEL.bin';
        const message=server.signaling.message.bind(server.signaling);
        server.signaling.message=(peer,raw)=>{
            report.network.signalingMessages++;report.network.signalingBytes+=Buffer.byteLength(raw);
            if(raw.includes(sentinel)||expectedHashes.some(hash=>raw.includes(hash)))report.network.fileDataObserved=true;
            return message(peer,raw);
        };
        await context.route('**/*',route=>{
            const request=route.request(),url=new URL(request.url());report.network.httpRequests++;
            if(url.origin!==server.origin){report.network.externalAttempts++;return route.abort();}
            if(!['GET','HEAD'].includes(request.method())||request.postDataBuffer()){
                report.network.uploadAttempts++;return route.abort();
            }
            return route.continue();
        });
        await page.route('**/config.js?*',route=>route.fulfill({contentType:'text/javascript',
            body:'window.ZEYDROP_CONFIG={enableStun:false,memoryLimit:67108864};'}));
        let workerCount=0;page.on('worker',()=>workerCount++);
        await page.goto(server.origin);
        await page.waitForFunction(()=>!!window.ZeydropFileHash&&!!window.ZeydropHash);
        report.capabilities=await page.evaluate(()=>({worker:typeof Worker==='function',blob:typeof Blob==='function',
            file:typeof File==='function',opfs:typeof navigator.storage?.getDirectory==='function',
            chunkBytes:ZeydropFileHasher.CHUNK_BYTES,
            versionQueryMatches:new URL(window.ZeydropFileHash._url).search===new URL(document.querySelector('script[src*="file-hash.js"]').src).search}));
        assert.equal(report.capabilities.worker,true);assert.equal(report.capabilities.versionQueryMatches,true);
        assert.equal(report.capabilities.chunkBytes,256*1024);

        report.phase='native-worker-vectors';
        report.vectors=await page.evaluate(async sentinel=>{
            const hasher=window.ZeydropFileHash,original=hasher._factory,results=[];let factoryCalls=0;
            hasher._factory=()=>{factoryCalls++;throw Error('main factory must not run');};
            try {
                const vectors=[new File([],sentinel),new File(['abc'],sentinel),new File([new Uint8Array(256*1024+113).fill(0x5a)],sentinel)];
                for(const blob of vectors){
                    const progress=[];
                    const value=await hasher.hash(blob,{onProgress:item=>progress.push(item)});
                    results.push({...value,firstProgress:progress[0]?.bytes,lastProgress:progress.at(-1)?.bytes,
                        validProgress:progress.every(item=>item.total===blob.size&&item.bytes>=0&&item.bytes<=blob.size)});
                }
                return{results,factoryCalls};
            } finally {hasher._factory=original;}
        },sentinel);
        assert.equal(report.vectors.factoryCalls,0);
        for(let index=0;index<expectedVectors.length;index++){
            const result=report.vectors.results[index];
            assert.equal(result.backend,'worker');assert.equal(result.sha256,expectedHashes[index]);assert.equal(result.bytes,expectedVectors[index].length);
            assert.equal(result.firstProgress,0);assert.equal(result.lastProgress,result.bytes);assert.equal(result.validProgress,true);
        }
        assert.ok(workerCount>=1,'hash must create an actual native Worker');
        report.checks.push('built native Worker hashes 0 B, abc and 256 KiB+113 B against independent Node SHA-256 without calling main factory');

        report.phase='cancel-and-recover';
        report.cancellation=await page.evaluate(async()=>{
            const hasher=window.ZeydropFileHash,controller=new AbortController();let progressed=false,errorName;
            const pending=hasher.hash(new Blob([new Uint8Array(8*1024*1024).fill(0x3c)]),{signal:controller.signal});
            const oldWorker=hasher._worker;
            // Observe a real Worker read, independently of the bridge's UI
            // throttling: fast hosts may finish 8 MiB before the next 100 ms UI update.
            const abortOnRead=event=>{const item=event.data;if(item.type==='progress'&&item.bytes>0&&item.bytes<item.total){progressed=true;controller.abort();}};
            oldWorker.addEventListener('message',abortOnRead);
            try{await pending;}catch(error){errorName=error.name;}
            finally{oldWorker.removeEventListener('message',abortOnRead);}
            const result=await hasher.hash(new File(['abc'],'synthetic.bin'));
            return{progressed,errorName,newWorker:hasher._worker!==oldWorker,...result};
        });
        assert.equal(report.cancellation.progressed,true);assert.equal(report.cancellation.errorName,'AbortError');
        assert.equal(report.cancellation.newWorker,true);assert.equal(report.cancellation.backend,'worker');
        assert.equal(report.cancellation.sha256,expectedHashes[1]);
        report.checks.push('abort after real Worker read progress terminates that task; the next task succeeds with a new native Worker');

        report.phase='forced-no-worker';
        report.fallback=await page.evaluate(async()=>{
            const hasher=new ZeydropFileHasher({Worker:undefined}),read=hasher._read.bind(hasher);let largestRead=0,reads=0;
            hasher._read=(blob,start,end)=>{largestRead=Math.max(largestRead,end-start);reads++;return read(blob,start,end);};
            try{return{...await hasher.hash(new Blob([new Uint8Array(256*1024+113).fill(0x5a)])),largestRead,reads};}
            finally{hasher.cancelAll();}
        });
        assert.equal(report.fallback.backend,'main');assert.equal(report.fallback.sha256,expectedHashes[2]);
        assert.equal(report.fallback.largestRead,256*1024);assert.equal(report.fallback.reads,2);
        report.checks.push('forcing Worker absence uses the explicit main backend with native reads bounded to 256 KiB');

        report.phase='worker-crash-no-fallback';
        await page.route('**/file-hash-worker.js?synthetic-crash=1',route=>route.fulfill({contentType:'text/javascript',
            body:'self.onmessage=()=>{throw new Error("SyntheticHashWorkerFailure");};'}));
        report.crash=await page.evaluate(async()=>{
            let factoryCalls=0;
            const hasher=new ZeydropFileHasher({workerUrl:new URL('/scripts/file-hash-worker.js?synthetic-crash=1',location.origin).href,
                hashFactory:()=>{factoryCalls++;throw Error('must not fallback');}});
            try{await hasher.hash(new Blob(['abc']));return{resolved:true,factoryCalls};}
            catch(error){return{resolved:false,errorName:error.name,factoryCalls,workerReleased:hasher._worker===null};}
            finally{hasher.cancelAll();}
        });
        assert.equal(report.crash.resolved,false);assert.equal(report.crash.errorName,'HashWorkerError');
        assert.equal(report.crash.factoryCalls,0);assert.equal(report.crash.workerReleased,true);
        report.checks.push('a native Worker runtime exception rejects with HashWorkerError and never rehashes through the main factory');

        report.phase='benchmark-file-setup';
        report.benchmark=await page.evaluate(async()=>{
            const intendedBytes=100*1024*1024,fallbackBytes=8*1024*1024,chunk=new Uint8Array(256*1024).fill(0x6b);
            const state={intendedBytes,bytes:fallbackBytes,kind:'bounded-blob',opfsApi:typeof navigator.storage?.getDirectory==='function',
                createWritableApi:false,fallbackReason:'opfs-api-unavailable'};
            let directory,writer;
            try{
                if(!state.opfsApi)return state;
                directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('zeydrop-hash-benchmark-v1',{create:true});
                const handle=await directory.getFileHandle('synthetic.bin',{create:true});
                state.createWritableApi=typeof handle.createWritable==='function';
                if(!state.createWritableApi){state.fallbackReason='writable-api-unavailable';return state;}
                writer=await handle.createWritable();
                for(let offset=0;offset<intendedBytes;offset+=chunk.length)await writer.write(chunk);
                await writer.close();writer=null;
                const file=await handle.getFile();if(file.size!==intendedBytes)throw Error('size mismatch');
                window.__hashBenchmark={blob:file,directory};
                return{...state,bytes:file.size,kind:'opfs-file',fallbackReason:null};
            }catch(error){
                state.fallbackReason=['SecurityError','NotAllowedError','QuotaExceededError','NotSupportedError','InvalidStateError'].includes(error?.name)?error.name:'opfs-operation-failed';
                return state;
            }finally{
                if(writer)try{await writer.abort();}catch{}
                if(!window.__hashBenchmark){
                    if(directory)try{await directory.removeEntry('synthetic.bin');}catch{}
                    window.__hashBenchmark={blob:new Blob(Array.from({length:fallbackBytes/chunk.length},()=>chunk))};
                }
            }
        });
        assert.ok(['opfs-file','bounded-blob'].includes(report.benchmark.kind));
        assert.equal(report.benchmark.bytes,report.benchmark.kind==='opfs-file'?100*1024*1024:8*1024*1024);
        report.phase='benchmark-worker-and-main';
        report.benchmark.runs=await page.evaluate(async()=>{
            const blob=window.__hashBenchmark.blob,runs=[];
            for(const backend of ['worker','main']){
                const hasher=backend==='worker'?window.ZeydropFileHash:new ZeydropFileHasher({Worker:undefined});
                const gaps=[];let ticks=0,last=performance.now(),maxGap=0;
                const timer=setInterval(()=>{const now=performance.now(),gap=now-last;last=now;ticks++;maxGap=Math.max(maxGap,gap);
                    if(gaps.length<4096)gaps.push(gap);},16);
                const started=performance.now();
                try{
                    const result=await hasher.hash(blob),wallMs=performance.now()-started;
                    const sorted=[...gaps].sort((a,b)=>a-b),rounded=value=>Math.round(value*1000)/1000;
                    runs.push({...result,wallMs:rounded(wallMs),intervalTargetMs:16,ticks,
                        maxIntervalMs:ticks?rounded(maxGap):null,p95IntervalMs:sorted.length?rounded(sorted[Math.ceil(sorted.length*0.95)-1]):null,
                        intervalSamples:sorted.length,intervalSampleCap:4096});
                }finally{clearInterval(timer);if(backend==='main')hasher.cancelAll();}
            }
            return runs;
        });
        const expectedBenchmark=repeatedDigest(report.benchmark.bytes,0x6b);
        assert.equal(report.benchmark.runs.length,2);
        for(const [index,backend] of ['worker','main'].entries()){
            const run=report.benchmark.runs[index];assert.equal(run.backend,backend);
            assert.equal(run.bytes,report.benchmark.bytes);assert.equal(run.sha256,expectedBenchmark);
            assert.ok(Number.isFinite(run.wallMs)&&run.wallMs>=0);
        }
        report.benchmark.interpretation='16 ms interval and wall-time observations only; no speed/responsiveness winner assertion, CPU/RSS claim, or mobile hardware evidence';
        report.checks.push('worker and main benchmark outputs both match independent Node SHA-256; reported source capability and actual byte count are explicit');
        report.phase='cleanup-and-network-check';
        await page.evaluate(async()=>{
            const state=window.__hashBenchmark;delete window.__hashBenchmark;window.ZeydropFileHash.cancelAll();
            if(state?.directory)await state.directory.removeEntry('synthetic.bin');
        });
        await page.waitForTimeout(100); // Let a late worker error reach the strict final assertion.
        assert.equal(report.network.uploadAttempts,0);assert.equal(report.network.externalAttempts,0);
        assert.equal(report.network.fileDataObserved,false);assert.deepEqual(report.errors,[]);
        report.nativeWorkersCreated=workerCount;report.phase='complete';report.passed=true;
    }catch(error){
        report.failure=errorType(error);
        const line=String(error?.stack||'').match(/file-hash-browser\.cjs:(\d+):(\d+)/);
        if(line)report.failureLine={line:Number(line[1]),column:Number(line[2])};
        throw error;
    }finally{
        try{
            await fs.mkdir('test-results',{recursive:true});
            await fs.writeFile('test-results/file-hash-'+name+'.json',JSON.stringify(report,null,2)+'\n');
        }finally{
            if(page)await page.evaluate(()=>window.ZeydropFileHash?.cancelAll()).catch(()=>{});
            await Promise.allSettled([context?.close(),browser?.close(),server?.close()]);
        }
    }
    console.log('File-hash browser evidence:',JSON.stringify(report));
}
main().catch(error=>{console.error('File-hash browser test failed:',errorType(error));process.exitCode=1;});
