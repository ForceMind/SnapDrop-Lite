'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../scripts/field-verify.cjs');
const secret = 'SECRET_PATH_NEVER_EXPORT';
const diag = () => ({
    schema: 1, product: 'Zeydrop', revision: '0123456789abcdef', version: '0.3.0-dev.1',
    roomId: secret, token: secret,
    events: [{ kind:'connection', peer:1, state:'connected', ready:true,
        identityConfirmed:true, path:{direct:true,status:'selected',protocol:'udp',
            localType:'host',remoteType:'srflx',family:'IPv4',rttMs:19,ip:'192.168.1.33'} }]
});
async function setup(t) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(),'zeydrop-field-e2e-'));
    t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
    const names = ['sender.json','receiver.json','original-'+secret+'.bin','received-'+secret+'.bin'];
    const files = names.map(name => path.join(dir,name));
    await Promise.all([
        fsp.writeFile(files[0],JSON.stringify(diag())),
        fsp.writeFile(files[1],JSON.stringify(diag())),
        fsp.writeFile(files[2],Buffer.alloc(8193,23)),
        fsp.writeFile(files[3],Buffer.alloc(8193,23))
    ]);
    return {dir,files,run:(opts=[])=>spawnSync(process.execPath,[cli,
        '--sender-diag',files[0],'--receiver-diag',files[1],
        '--scenario','broadband-cellular',...opts],{encoding:'utf8'})};
}
test('real CLI verifies paired local files and exports only privacy-safe summary',async t=>{
    const h=await setup(t), result=h.run(['--sender-file',h.files[2],'--receiver-file',h.files[3]]);
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.verdict,'evidence-consistent');
    assert.equal(report.fileCheck.sha256Equal,true);
    assert.equal(report.fileCheck.senderBytes,8193);
    assert.equal(report.selectedNonRelayOnBoth,true);
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stdout.includes(h.dir));
    assert.ok(!result.stdout.includes('192.168'));
    assert.ok(!result.stdout.includes('roomId'));
    const out=path.join(h.dir,'safe-report.json');
    const saved=h.run(['--sender-file',h.files[2],'--receiver-file',h.files[3],'--out',out]);
    assert.equal(saved.status,0,saved.stderr);
    assert.equal(saved.stdout,'');
    assert.equal(JSON.parse(await fsp.readFile(out,'utf8')).verdict,'evidence-consistent');
    if(process.platform!=='win32') assert.equal((await fsp.stat(out)).mode & 0o777,0o600);
    const noOverwrite=h.run(['--sender-file',h.files[2],'--receiver-file',h.files[3],'--out',out]);
    assert.equal(noOverwrite.status,1,'existing evidence cannot be silently overwritten');
});
test('real CLI distinguishes integrity mismatch, incomplete evidence and obsolete route',async t=>{
    const h=await setup(t);
    await fsp.writeFile(h.files[3],Buffer.alloc(8193,24));
    const mismatch=h.run(['--sender-file',h.files[2],'--receiver-file',h.files[3]]);
    assert.equal(mismatch.status,2,mismatch.stderr);
    assert.equal(JSON.parse(mismatch.stdout).verdict,'integrity-mismatch');
    assert.ok(!mismatch.stdout.includes(secret));
    const noFiles=h.run();
    assert.equal(noFiles.status,2);
    assert.equal(JSON.parse(noFiles.stdout).verdict,'direct-route-diagnostic-only');
    const disconnected=diag();
    disconnected.events.push({kind:'connection',peer:1,state:'failed',ready:false,
        identityConfirmed:false,path:{direct:false,status:'unknown'}});
    await fsp.writeFile(h.files[1],JSON.stringify(disconnected));
    const stale=h.run(['--sender-file',h.files[2],'--receiver-file',h.files[3]]);
    assert.equal(stale.status,2);
    assert.equal(JSON.parse(stale.stdout).verdict,'integrity-mismatch');
    assert.equal(JSON.parse(stale.stdout).selectedNonRelayOnBoth,false);
});
