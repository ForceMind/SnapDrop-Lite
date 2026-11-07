'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {runServerLoad,normalizeLoadOptions}=require('../scripts/server-load.cjs');
function privateKeys(value){
    if(!value||typeof value!=='object')return [];
    return Object.entries(value).flatMap(([key,item])=>[...(/^(peerId|roomId|resumeToken|url|hostname|address|ip|sdp|candidate|filename|fileName|outputPath)$/i.test(key)?[key]:[]),...privateKeys(item)]);
}
test('load options are finite and cannot select a remote server',()=>{
    assert.deepEqual(normalizeLoadOptions(),{connections:32,signalsPerPeer:10,durationMs:1000,cycles:1,bounds:true});
    for(const options of [{connections:3},{connections:1002},{signalsPerPeer:101},{durationMs:10001},{cycles:4},{bounds:'yes'}])assert.throws(()=>normalizeLoadOptions(options),/invalid-/);
    const result=spawnSync(process.execPath,['scripts/server-load.cjs','--url','ws://do-not-connect.example'],{encoding:'utf8'});
    assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stderr),{schema:1,status:'failed',code:'load-failed'});assert.ok(!result.stderr.includes('do-not-connect'));
});
test('real isolated load counts every allowed signal, cleans retained resources and checks protocol bounds',async()=>{
    const report=await runServerLoad({connections:6,signalsPerPeer:3,durationMs:30,cycles:2});
    assert.equal(report.status,'passed');assert.equal(report.cycles.length,2);assert.equal(report.runtime.separateServerProcess,true);
    for(const cycle of report.cycles){
        assert.equal(cycle.signalMessagesSent,18);assert.equal(cycle.signalMessagesReceived,18);assert.equal(cycle.signalRelayLatencyMs.samples,18);
        assert.equal(cycle.snapshots.afterPair.connections,6);assert.equal(cycle.snapshots.afterPair.rooms,3);
        assert.equal(cycle.snapshots.afterClose.connections,0);assert.equal(cycle.snapshots.afterClose.sessions,6);
        for(const name of ['connections','sessions','rooms','webSocketClients'])assert.equal(cycle.snapshots.afterExpiry[name],0);
        assert.ok(cycle.snapshots.afterSignals.rssBytes>0);assert.ok(cycle.serverCpu.userMicros>=0);assert.ok(cycle.serverCpu.systemMicros>=0);
    }
    assert.equal(report.bounds.binaryFrameCloseCode,1008);assert.equal(report.bounds.oversizedFrameCloseCode,1009);
    assert.equal(report.bounds.messageRateCloseCode,1008);assert.equal(report.bounds.minuteByteBudgetCloseCode,1008);
    assert.deepEqual(privateKeys(report),[]);assert.ok(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(JSON.stringify(report)));
});
test('CLI writes the same privacy-safe JSON it prints and supports bounded profiles',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zeydrop-load-cli-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const output=path.join(dir,'private-local-output.json');
    const result=spawnSync(process.execPath,['scripts/server-load.cjs','--connections','4','--signals','2','--duration-ms','20','--cycles','1','--skip-bound-probes','--out',output],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
    assert.deepEqual(report,JSON.parse(await fs.readFile(output,'utf8')));assert.equal(report.bounds,null);
    assert.ok(!result.stdout.includes(output));assert.deepEqual(privateKeys(report),[]);
    const help=spawnSync(process.execPath,['scripts/server-load.cjs','--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/no remote endpoint/);
});
