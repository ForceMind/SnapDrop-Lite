'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function diagnostics() {
    const context = vm.createContext({ Date });
    vm.runInContext(fs.readFileSync('client/scripts/diagnostics.js', 'utf8') + '\nthis.Diagnostics = ConnectionDiagnostics;', context);
    return new context.Diagnostics({ version: '0.3.0-dev.1', revision: '1234567890abcdef', now: () => 1792418400000 });
}
test('diagnostic export allowlists state and never exposes tokens, SDP, addresses, codes or file data', () => {
    const d = diagnostics();
    d.recordConnection({ peerId: 'SECRET_PEER', state: 'connected', ready: true, verified: true, code: 'SECRET_CODE', reason: 'SECRET_REASON', sdp: 'SECRET_SDP', roomId: 'SECRET_ROOM', resumeToken: 'SECRET_TOKEN', filename: 'SECRET_FILE', path: {direct:true,status:'selected',protocol:'udp',localType:'host',remoteType:'srflx',family:'IPv4',rtt:2.6,address:'203.0.113.19',ip:'192.168.1.20',usernameFragment:'SECRET_ICE'}, candidates: {host:2,srflx:1,prflx:0} });
    const report = d.snapshot({ secureContext:true,webRTC:true,streamingSave:false,origin:'https://SECRET_ORIGIN/' });
    const text = JSON.stringify(report);
    assert.ok(!/SECRET|203\.0\.113|192\.168\.1/.test(text));
    assert.equal(report.events[0].path.rttMs, 3); assert.equal(report.events[0].peer, 1);
    assert.equal(report.events[0].identityConfirmed, true); assert.equal(report.revision, '1234567890abcdef');
    report.events[0].path.protocol = 'mutated'; assert.equal(d.snapshot().events[0].path.protocol, 'udp');
});
test('diagnostics retain a bounded history and reject arbitrary field values', () => {
    const d = diagnostics();
    for (let i=0;i<500;i++) d.recordConnection({ peerId:'SECRET-'+i, state:'SECRET_STATE', path:{protocol:'SECRET_PROTOCOL',rtt:Infinity,family:'SECRET_ADDRESS'}, candidates:{host:-1,srflx:Infinity,prflx:1.1} });
    d.recordSignal('SECRET_SIGNAL');
    assert.equal(d.events.length, 120); assert.equal(d.peers.size, 30);
    const report = d.snapshot(); assert.ok(!JSON.stringify(report).includes('SECRET'));
    assert.equal(report.events[0].state, 'unknown'); assert.equal(report.events[0].path.rttMs, null);
    assert.equal(report.events[0].candidates.host, 0);
});
