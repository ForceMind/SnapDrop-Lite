'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'),fs = require('node:fs/promises'),os = require('node:os'),path = require('node:path');
const { parseArgs,selectedSummary,assessReports,verifyFiles } = require('../scripts/field-verify.cjs');
const revision='0123456789abcdef';
function report(state='connected', opts={}) {
    return {schema:1,product:'Zeydrop',version:'0.3.0-dev.1',revision,
        secret:'SECRET_RESUME_TOKEN',ip:'192.168.0.1',
        events:[{kind:'connection',peer:1,state,ready:true,identityConfirmed:true,peerId:'SECRET_PEER',
            path:{direct:true,status:'selected',protocol:'udp',localType:'host',remoteType:'srflx',
                family:'IPv4',rttMs:23,address:'203.0.113.4'}}],...opts};
}
test('selected non-relay and manual confirmation required on both diagnostic exports',()=>{
    const result=assessReports(report(),report(),'different-broadband');
    assert.equal(result.verdict,'direct-route-diagnostic-only');
    assert.equal(result.selectedNonRelayOnBoth,true);
    assert.equal(result.sameBuild,true);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.ok(!JSON.stringify(result).includes('203.0.113'));
    assert.ok(!JSON.stringify(result).includes('192.168'));
});
test('never use a historical good connection event after a disconnect',()=>{
    const a=report();
    a.events.push({kind:'connection',peer:1,state:'disconnected',ready:false,identityConfirmed:false,path:{direct:false,status:'unknown'}});
    const result=assessReports(a,report(),'broadband-cellular');
    assert.equal(result.selectedNonRelayOnBoth,false);
    assert.equal(result.verdict,'not-confirmed');
});
test('same build mandatory, unknown/relay routes are not evidence',()=>{
    const b=report();b.revision='f'.repeat(16);
    assert.equal(assessReports(report(),b,'same-wifi').sameBuild,false);
    const relay=report();relay.events[0].path.localType='relay';
    assert.equal(assessReports(report(),relay,'strict-nat').verdict,'not-confirmed');
    const nominated=report();nominated.events[0].path.status='unknown';
    assert.equal(selectedSummary(nominated).selectedDirectAtExport,false);
    assert.throws(()=>selectedSummary({schema:1,product:'Zeydrop',revision,version:'0.3',events:new Array(121).fill({})}),/格式/);
});
test('local hash uses streaming bytes, never exports SHA or source paths',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zeydrop-field-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const secret='PRIVATE_TEST_FILENAME_SHOULD_NOT_LEAK';
    const a=path.join(dir,secret+'-a'),b=path.join(dir,secret+'-b');
    const bytes=crypto.randomBytes(2*1024*1024+117);
    await Promise.all([fs.writeFile(a,bytes),fs.writeFile(b,bytes)]);
    const match=await verifyFiles(a,b);
    assert.equal(match.equal,true);assert.equal(match.senderBytes,bytes.length);
    const result=assessReports(report(),report(),'different-carriers',match);
    assert.equal(result.verdict,'evidence-consistent');
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(dir));
    assert.ok(!JSON.stringify(result).includes(crypto.createHash('sha256').update(bytes).digest('hex')));
    await fs.writeFile(b,Buffer.from('wrong'));
    const mismatch=await verifyFiles(a,b);
    assert.equal(mismatch.equal,false);
    assert.equal(assessReports(report(),report(),'different-carriers',mismatch).verdict,'integrity-mismatch');
});
test('CLI requires paired files, accepted scenario, and no duplicate arguments',()=>{
    assert.throws(()=>parseArgs(['--sender-diag','a','--receiver-diag','b','--scenario','evil']),/场景/);
    assert.throws(()=>parseArgs(['--sender-diag','a','--receiver-diag','b','--scenario','same-wifi','--sender-file','x']),/同时指定/);
    assert.throws(()=>parseArgs(['--sender-diag','a','--receiver-diag','b','--scenario','same-wifi','--scenario','same-wifi']),/重复/);
    assert.deepEqual(parseArgs(['--help']),{help:true});
});
