'use strict';
// Bounded, isolated loopback signaling benchmark. It never connects to a
// supplied host, sends file data, or exports identifiers/tokens/SDP/addresses.
const path=require('node:path'),fs=require('node:fs/promises');
const {fork}=require('node:child_process');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {randomBytes}=require('node:crypto');
const {parseArgs}=require('node:util');
const {WebSocket}=require('../server/node_modules/ws');
const {ZeydropServer,RESUME_TTL}=require('../server');
const ORIGIN='http://localhost:8080';
const SDP_PREFIX='v=0\r\ns=zeydrop-signaling-load\r\na=x-load-seq:';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fail(code){const error=Error(code);error.code=code;return error;}
function options(input={}){
    const result={connections:input.connections??32,signalsPerPeer:input.signalsPerPeer??10,durationMs:input.durationMs??1000,cycles:input.cycles??1,bounds:input.bounds??true};
    if(!Number.isInteger(result.connections)||result.connections<2||result.connections>1000||result.connections%2)throw fail('invalid-connections');
    if(!Number.isInteger(result.signalsPerPeer)||result.signalsPerPeer<1||result.signalsPerPeer>100)throw fail('invalid-signal-count');
    if(!Number.isInteger(result.durationMs)||result.durationMs<0||result.durationMs>10000)throw fail('invalid-duration');
    if(!Number.isInteger(result.cycles)||result.cycles<1||result.cycles>3)throw fail('invalid-cycles');
    if(typeof result.bounds!=='boolean')throw fail('invalid-bounds-option');
    return result;
}
function stats(values){
    if(!values.length)return {samples:0,p50:null,p95:null,max:null};
    const ordered=values.slice().sort((a,b)=>a-b),round=n=>Math.round(n*1000)/1000;
    return {samples:ordered.length,p50:round(ordered[Math.floor((ordered.length-1)*.5)]),p95:round(ordered[Math.floor((ordered.length-1)*.95)]),max:round(ordered.at(-1))};
}
async function workerMain(){
    let offset=0;const loop=monitorEventLoopDelay({resolution:10});loop.enable();
    const server=new ZeydropServer({port:0,host:'127.0.0.1',origins:ORIGIN,now:()=>Date.now()+offset});
    const expiry=setTimeout(()=>{server.close().finally(()=>process.exit(1));},45000);
    const sample=()=>{
        const memory=process.memoryUsage(),cpu=process.cpuUsage(),hasDelaySamples=Number.isFinite(loop.mean);
        const safeDelay=value=>Number.isFinite(value)?Math.round(value/1e3)/1e3:null;
        return {connections:server.connections.size,sessions:server.sessions.size,rooms:server.rooms.size,
            webSocketClients:server._wss.clients.size,rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,externalBytes:memory.external,
            processPeakRssBytes:process.resourceUsage().maxRSS*1024,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,elapsedMs:Math.round(performance.now()*1000)/1000,
            maxSocketBufferedBytesAtSample:Math.max(0,...[...server.connections.values()].map(peer=>peer.socket.bufferedAmount)),
            eventLoopDelayMs:{mean:hasDelaySamples?safeDelay(loop.mean):null,p99:hasDelaySamples?safeDelay(loop.percentile(99)):null,max:hasDelaySamples?safeDelay(loop.max):null}};
    };
    await new Promise((resolve,reject)=>{server._wss.once('listening',resolve);server._wss.once('error',reject);});
    process.on('message',async message=>{
        if(!Number.isInteger(message?.id))return;
        try{
            if(message.command==='begin')loop.reset();
            if(message.command==='expire-retention'){offset+=RESUME_TTL+1;server.sweep();}
            if(message.command==='close'){
                clearTimeout(expiry);loop.disable();await server.close();
                process.send({reply:message.id,value:true},()=>process.disconnect());return;
            }
            process.send({reply:message.id,value:sample()});
        }catch{process.send({reply:message.id,error:'worker-command-failed'});}
    });
    process.send({type:'ready',port:server._wss.address().port,node:process.version,platform:process.platform,arch:process.arch});
}
async function runServerLoad(input={}){
    const config=options(input),started=performance.now(),startedAt=new Date().toISOString();
    const child=fork(__filename,['--server-worker'],{execArgv:['--max-old-space-size=96'],stdio:['ignore','ignore','ignore','ipc']});
    const pendingRpc=new Map(),clients=new Set();let nextRpc=1,readyInfo,runDeadline=performance.now()+40000;
    let timedOut=false,report;
    const cutoff=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},45000);
    const ready=new Promise((resolve,reject)=>{
        const startup=setTimeout(()=>reject(fail('worker-start-timeout')),5000);
        child.on('error',()=>{clearTimeout(startup);reject(fail('worker-start-failed'));});
        child.on('exit',()=>{clearTimeout(startup);for(const operation of pendingRpc.values()){clearTimeout(operation.timer);operation.reject(fail('worker-exited'));}pendingRpc.clear();if(!readyInfo)reject(fail('worker-start-failed'));});
        child.on('message',message=>{
            if(message?.type==='ready'){clearTimeout(startup);readyInfo=message;resolve(message);return;}
            const operation=pendingRpc.get(message?.reply);if(!operation)return;
            clearTimeout(operation.timer);pendingRpc.delete(message.reply);
            message.error?operation.reject(fail('worker-command-failed')):operation.resolve(message.value);
        });
    });
    const rpc=command=>new Promise((resolve,reject)=>{
        if(!child.connected)return reject(fail('worker-disconnected'));
        const id=nextRpc++,timer=setTimeout(()=>{pendingRpc.delete(id);reject(fail('worker-timeout'));},5000);
        pendingRpc.set(id,{resolve,reject,timer});child.send({id,command});
    });
    const until=async(predicate,code)=>{const deadline=Math.min(performance.now()+5000,runDeadline);while(performance.now()<deadline){if(await predicate())return;await pause(5);}throw fail(code);};
    async function connect(){
        const start=performance.now(),messages=[],waiters=[];
        const ws=new WebSocket('ws://127.0.0.1:'+readyInfo.port+'/server/webrtc',{origin:ORIGIN,handshakeTimeout:4000});
        const client={ws,messages,closed:false,closeCode:null,id:null,onSignal:null,latency:null};clients.add(client);
        ws.on('message',bytes=>{
            let message;try{message=JSON.parse(bytes.toString());}catch{return;}
            if(message.type==='ping'){if(ws.readyState===1)ws.send(JSON.stringify({type:'pong'}));return;}
            if(message.type==='signal'){client.onSignal?.(message);return;}
            const waiter=waiters.find(item=>item.predicate(message));
            if(waiter){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(message);}
            else{messages.push(message);if(messages.length>16)messages.shift();}
        });
        ws.on('close',code=>{client.closed=true;client.closeCode=code;for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(fail('client-closed'));}});
        ws.on('error',()=>{});
        client.wait=(predicate)=>new Promise((resolve,reject)=>{
            const index=messages.findIndex(predicate);if(index>=0)return resolve(messages.splice(index,1)[0]);
            if(client.closed)return reject(fail('client-closed'));
            const waiter={predicate,resolve,reject,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(fail('client-response-timeout'));},4000)};waiters.push(waiter);
        });
        client.send=message=>{if(ws.readyState!==1)throw fail('client-not-open');ws.send(JSON.stringify(message));};
        await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(fail('client-connect-failed')));});
        const hello=client.wait(message=>message.type==='hello');client.send({type:'hello'});
        client.id=(await hello).peerId;client.latency=performance.now()-start;return client;
    }
    async function pair(a,b){
        const roomId=randomBytes(16).toString('hex');
        const first=a.wait(message=>message.type==='room-joined'&&message.roomId===roomId);
        a.send({type:'create-room',roomId});await first;
        const second=b.wait(message=>message.type==='room-joined'&&message.roomId===roomId&&message.paired);
        const locked=a.wait(message=>message.type==='room-joined'&&message.roomId===roomId&&message.paired);
        b.send({type:'join-room',roomId});await Promise.all([second,locked]);
    }
    async function closeAll(){
        for(const client of clients)if(client.ws.readyState<2)client.ws.close(1000,'load-complete');
        const deadline=performance.now()+1000;
        while([...clients].some(client=>!client.closed)&&performance.now()<deadline)await pause(5);
        for(const client of clients)if(!client.closed)client.ws.terminate();
        await until(async()=> (await rpc('sample')).connections===0,'connection-cleanup-timeout');clients.clear();
    }
    async function closedCode(client){await until(()=>client.closed,'bound-close-timeout');return client.closeCode;}
    try{
        const info=await ready;
        report={schema:1,status:'passed',scope:'isolated loopback signaling; synthetic SDP only; no ICE, DataChannel, file or WAN throughput claim',startedAtUTC:startedAt,
            runtime:{serverNode:info.node,platform:info.platform,arch:info.arch,serverHeapLimitMiB:96,osMemoryLimitApplied:false,separateServerProcess:true},config,cycles:[],bounds:null};
        for(let cycle=0;cycle<config.cycles;cycle++){
            const baseline=await rpc('begin');
            const cohort=await Promise.all(Array.from({length:config.connections},()=>connect()));
            const afterConnect=await rpc('sample');
            await Promise.all(Array.from({length:cohort.length/2},(_,index)=>pair(cohort[index*2],cohort[index*2+1])));
            const afterPair=await rpc('sample');
            if(afterPair.connections!==config.connections||afterPair.sessions!==config.connections||afterPair.rooms!==config.connections/2)throw fail('unexpected-resource-count');
            const pending=new Map(),latencies=[];let sequence=0,received=0;
            for(const client of cohort)client.onSignal=message=>{
                const value=message.sdp?.sdp;
                if(typeof value!=='string'||!value.startsWith(SDP_PREFIX))return;
                const id=Number(value.slice(SDP_PREFIX.length).trim()),sent=pending.get(id);
                if(sent===undefined)return;
                pending.delete(id);latencies.push(performance.now()-sent);received++;
            };
            const signalStart=performance.now();
            for(let round=0;round<config.signalsPerPeer;round++){
                for(let index=0;index<cohort.length;index++){
                    const id=sequence++;pending.set(id,performance.now());
                    cohort[index].send({type:'signal',to:cohort[index^1].id,sdp:{type:'offer',sdp:SDP_PREFIX+id+'\r\n'}});
                }
                const target=signalStart+(round+1)*config.durationMs/config.signalsPerPeer;
                if(target>performance.now())await pause(target-performance.now());
            }
            await until(()=>pending.size===0,'signal-relay-timeout');
            const signalElapsed=performance.now()-signalStart,afterSignals=await rpc('sample');
            if(received!==config.connections*config.signalsPerPeer)throw fail('signal-count-mismatch');
            await closeAll();const afterClose=await rpc('sample'),afterExpiry=await rpc('expire-retention');
            if(afterExpiry.connections||afterExpiry.sessions||afterExpiry.rooms)throw fail('retention-cleanup-failed');
            const elapsed=afterSignals.elapsedMs-baseline.elapsedMs,cpuMicros=(afterSignals.cpuUserMicros-baseline.cpuUserMicros)+(afterSignals.cpuSystemMicros-baseline.cpuSystemMicros);
            report.cycles.push({ordinal:cycle+1,connectHelloLatencyMs:stats(cohort.map(client=>client.latency)),signalRelayLatencyMs:stats(latencies),
                signalMessagesSent:sequence,signalMessagesReceived:received,signalWindowMs:Math.round(signalElapsed),relayedMessagesPerSecond:Math.round(received*1000/Math.max(signalElapsed,1)),
                serverCpu:{userMicros:afterSignals.cpuUserMicros-baseline.cpuUserMicros,systemMicros:afterSignals.cpuSystemMicros-baseline.cpuSystemMicros,percentOfOneCore:Math.round(cpuMicros/(elapsed*1000)*10000)/100},
                snapshots:{baseline,afterConnect,afterPair,afterSignals,afterClose,afterExpiry},cleanup:'connections closed; two-minute session grace advanced with an injected clock, not real waiting'});
        }
        if(config.bounds){
            const checks={};
            let client=await connect();client.ws.send(Buffer.from('synthetic-control-fixture'));checks.binaryFrameCloseCode=await closedCode(client);
            client=await connect();client.ws.send('x'.repeat(64*1024+1));checks.oversizedFrameCloseCode=await closedCode(client);
            client=await connect();for(let index=0;index<241;index++)if(client.ws.readyState===1)client.send({type:'pong'});checks.messageRateCloseCode=await closedCode(client);
            const sender=await connect(),receiver=await connect();await pair(sender,receiver);
            const padding='v=0\r\ns=synthetic-signaling-bound\r\na=x-pad:'+ 'a'.repeat(59000);
            for(let index=0;index<9;index++)if(sender.ws.readyState===1)sender.send({type:'signal',to:receiver.id,sdp:{type:'offer',sdp:padding}});
            checks.minuteByteBudgetCloseCode=await closedCode(sender);
            if(checks.binaryFrameCloseCode!==1008||checks.oversizedFrameCloseCode!==1009||checks.messageRateCloseCode!==1008||checks.minuteByteBudgetCloseCode!==1008)throw fail('signaling-bound-check-failed');
            await closeAll();checks.afterExpiry=await rpc('expire-retention');
            if(checks.afterExpiry.connections||checks.afterExpiry.sessions||checks.afterExpiry.rooms)throw fail('bound-resource-cleanup-failed');
            checks.slowReaderBackpressure='not-isolated-by-this-tool';report.bounds=checks;
        }
        report.wallTimeMs=Math.round(performance.now()-started);return report;
    }finally{
        for(const client of clients)client.ws.terminate();
        try{if(child.connected)await rpc('close');}catch{}
        clearTimeout(cutoff);
        if(child.exitCode===null&&child.signalCode===null){
            await new Promise(resolve=>{
                const done=()=>{clearTimeout(timer);child.off('exit',done);resolve();};
                const timer=setTimeout(done,500);child.once('exit',done);
            });
            if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
        }
        if(report)report.wallTimeMs=Math.round(performance.now()-started);
        if(timedOut)throw fail('hard-deadline-exceeded');
    }
}
async function main(){
    const {values}=parseArgs({options:{connections:{type:'string'},signals:{type:'string'},'duration-ms':{type:'string'},cycles:{type:'string'},'skip-bound-probes':{type:'boolean'},out:{type:'string'},help:{type:'boolean'}}});
    if(values.help){process.stdout.write('Usage: node scripts/server-load.cjs [--connections EVEN_2_TO_1000] [--signals 1_TO_100] [--duration-ms 0_TO_10000] [--cycles 1_TO_3] [--skip-bound-probes] [--out REPORT_PATH]\nStarts a separate bounded local server; no remote endpoint or file transfer is supported.\n');return;}
    const report=await runServerLoad({connections:values.connections===undefined?undefined:Number(values.connections),signalsPerPeer:values.signals===undefined?undefined:Number(values.signals),durationMs:values['duration-ms']===undefined?undefined:Number(values['duration-ms']),cycles:values.cycles===undefined?undefined:Number(values.cycles),bounds:!values['skip-bound-probes']});
    const text=JSON.stringify(report,null,2)+'\n';if(values.out){await fs.mkdir(path.dirname(path.resolve(values.out)),{recursive:true});await fs.writeFile(values.out,text);}
    process.stdout.write(text);
}
module.exports={runServerLoad,normalizeLoadOptions:options};
if(require.main===module){
    if(process.argv[2]==='--server-worker'&&typeof process.send==='function')workerMain().catch(()=>{if(process.connected)process.send({type:'failure',code:'worker-start-failed'});process.exitCode=1;});
    else main().catch(error=>{const code=typeof error.code==='string'&&/^(invalid-|worker-|client-|signal-|connection-|retention-|bound-|signaling-|unexpected-|hard-)/.test(error.code)?error.code:'load-failed';process.stderr.write(JSON.stringify({schema:1,status:'failed',code})+'\n');process.exitCode=1;});
}
