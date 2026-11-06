'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { probeSignaling } = require('../scripts/check-signaling.cjs');
const { ZeydropServer } = require('../server');
test('deployment readiness requires an actual authorized signaling hello with a bounded deadline', async t => {
    const origin='https://test.example';const server=new ZeydropServer({port:0,origins:origin});
    t.after(()=>server.close());await new Promise(resolve=>server._wss.once('listening',resolve));
    const url='ws://127.0.0.1:'+server._wss.address().port+'/server/webrtc';
    assert.equal(await probeSignaling({url,origin,timeoutMs:1000}),true);
    const started=Date.now();
    await assert.rejects(probeSignaling({url,origin:'https://wrong.example',timeoutMs:150,attemptTimeoutMs:100,retryDelayMs:20}),/did not become ready/);
    assert.ok(Date.now()-started<2000);
    await assert.rejects(probeSignaling({url:'ws://example.com/server/webrtc',origin}),/loopback/);
});
async function fixture(t, fail='') {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'zeydrop-rollback-test-'));
    t.after(()=>fs.rm(temp,{recursive:true,force:true}));
    const root=path.join(temp,'installation'),bin=path.join(temp,'bin');await fs.mkdir(bin,{recursive:true});
    const current=path.join(root,'releases','1111111111111111'),previous=path.join(root,'releases','2222222222222222');
    for(const dir of [current,previous]){await fs.mkdir(path.join(dir,'dist'),{recursive:true});await fs.mkdir(path.join(dir,'server'));await fs.writeFile(path.join(dir,'dist/build.json'),'{}');await fs.writeFile(path.join(dir,'server/index.js'),'// fixture');}
    await fs.symlink(current,path.join(root,'current'));await fs.writeFile(path.join(root,'previous'),previous+'\n');
    const script=await fs.readFile('scripts/rollback.sh','utf8');
    const guard="[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }";
    assert.ok(script.includes(guard));
    // Only filesystem destinations and the root guard are adapted in this test
    // copy. Every state transition/restart/trap is the production shell logic.
    const isolated=script.replace(guard,'# Non-root isolated test copy').replaceAll('/opt/zeydrop',root).replaceAll('/etc/zeydrop/signaling.env',path.join(root,'signaling.env'));
    await fs.writeFile(path.join(temp,'rollback.sh'),isolated);
    const commands=`const fs=require('node:fs');const target=fs.readlinkSync(process.env.TEST_ROOT+'/current');fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool:require('node:path').basename(process.argv[1]),args:process.argv.slice(2),target})+'\\n');const tool=require('node:path').basename(process.argv[1]);if(tool==='nginx'&&process.env.TEST_FAIL==='nginx')process.exit(1);if(tool==='systemctl'&&process.argv[2]==='restart'&&target.endsWith('2222222222222222')&&process.env.TEST_FAIL==='restart')process.exit(1);`;
    for(const name of ['systemctl','nginx'])await fs.writeFile(path.join(bin,name),'#!/usr/bin/env node\n'+commands,{mode:0o755});
    await fs.writeFile(path.join(temp,'check-signaling.cjs'),`const fs=require('node:fs');const target=fs.readlinkSync(process.env.TEST_ROOT+'/current');fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool:'hello',target})+'\\n');if(target.endsWith('2222222222222222')&&process.env.TEST_FAIL==='health')process.exit(1);`);
    const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,TEST_ROOT:root,TEST_LOG:path.join(temp,'log'),TEST_FAIL:fail};
    return {root,current,previous,run:()=>spawnSync('bash',[path.join(temp,'rollback.sh')],{env,encoding:'utf8'}),log:async()=> (await fs.readFile(env.TEST_LOG,'utf8')).trim().split('\n').map(line=>JSON.parse(line))};
}
test('successful isolated rollback changes the previous marker only after readiness', async t => {
    const f=await fixture(t);const result=f.run();assert.equal(result.status,0,result.stderr);
    assert.equal(await fs.readlink(path.join(f.root,'current')),f.previous);assert.equal((await fs.readFile(path.join(f.root,'previous'),'utf8')).trim(),f.current);
    const log=await f.log();assert.ok(log.some(item=>item.tool==='hello'&&item.target===f.previous));
});
for(const failure of ['restart','health'])test('failed isolated '+failure+' restores original release and preserves reverse-rollback marker',async t=>{
    const f=await fixture(t,failure);const result=f.run();assert.equal(result.status,1,result.stderr);
    assert.equal(await fs.readlink(path.join(f.root,'current')),f.current);assert.equal((await fs.readFile(path.join(f.root,'previous'),'utf8')).trim(),f.previous);
    const log=await f.log();assert.ok(log.some(item=>item.tool==='systemctl'&&item.args[0]==='restart'&&item.target===f.current));
    assert.ok(log.some(item=>item.tool==='hello'&&item.target===f.current));
});
test('invalid Nginx configuration leaves both rollback pointers unchanged',async t=>{
    const f=await fixture(t,'nginx');assert.equal(f.run().status,1);
    assert.equal(await fs.readlink(path.join(f.root,'current')),f.current);assert.equal((await fs.readFile(path.join(f.root,'previous'),'utf8')).trim(),f.previous);
    assert.ok((await f.log()).every(item=>item.tool!=='systemctl'));
});

test('isolated rollback cannot overlap another deployment lock',async t=>{
    const f=await fixture(t);
    const locker=spawn('flock',['-x','-F',path.join(f.root,'.deploy.lock'),process.execPath,'-e','process.stdout.write("locked");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});
    t.after(async()=>{if(locker.exitCode===null){locker.kill();await new Promise(resolve=>locker.once('exit',resolve));}});
    await new Promise((resolve,reject)=>{locker.stdout.once('data',resolve);locker.once('error',reject);});
    const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/Another deployment or rollback/);
    assert.equal(await fs.readlink(path.join(f.root,'current')),f.current);
    assert.equal((await fs.readFile(path.join(f.root,'previous'),'utf8')).trim(),f.previous);
});
