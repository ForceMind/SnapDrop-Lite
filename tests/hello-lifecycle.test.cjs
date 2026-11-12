'use strict';
// Deterministic control loss/dequeue races over actual network+transfer source.
// These are protocol fixtures, not browser/NAT reachability evidence.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync('client/scripts/transfer.js','utf8') + '\n' + fs.readFileSync('client/scripts/network.js','utf8') + '\nthis.RTC = RTCPeer;';
function harness() {
    const timers = new Map(), frames = [], allSent = []; let next = 0;
    const schedule = (fn, ms) => { const id = ++next; timers.set(id,{fn,ms}); return id; };
    class Connection {
        constructor() { this.signalingState = 'stable'; this.iceConnectionState = 'connected'; this.connectionState = 'connected'; }
        close() { this.connectionState = this.iceConnectionState = 'closed'; }
    }
    const window = Object.assign(new EventTarget(), { RTCPeerConnection: Connection, crypto: webcrypto,
        ZEYDROP_CONFIG: { enableStun: false }, ZeydropHash: {} });
    const context = vm.createContext({ window, crypto: webcrypto, RTCPeerConnection: Connection,
        TextEncoder, Uint8Array, CustomEvent, performance,
        setTimeout: schedule, clearTimeout: id => timers.delete(id), setInterval: schedule, clearInterval: id => timers.delete(id) });
    vm.runInContext(source, context);
    const create = label => {
        const peer = new context.RTC({ _peerId: 'a', send() { assert.fail('hello must never use WSS signaling'); } }, 'z');
        peer._samplePath = async () => {}; peer._securityCode = async () => {};
        peer.restores = 0; peer.restoreTransfers = () => { peer.restores++; };
        const channel = { label:'zeydrop-v2', readyState:'connecting', bufferedAmount:0,
            send(data) { const frame = { from: label, data, message: JSON.parse(data) }; frames.push(frame); allSent.push(frame); },
            close() { this.readyState='closed'; } };
        peer._bindChannel(channel); return { peer, channel, label };
    };
    const a = create('a'), b = create('b');
    const open = endpoint => { endpoint.channel.readyState='open'; endpoint.channel.onopen(); };
    const deliver = async (endpoint, message) => { endpoint.channel.onmessage({data:JSON.stringify(message)}); await endpoint.peer._messageChain; };
    const pump = async () => {
        let count = 0;
        while (frames.length) {
            assert.ok(++count < 100, 'hello/ACK exchange must terminate without an echo loop');
            const frame=frames.shift(), endpoint=frame.from==='a'?b:a;
            if (endpoint.channel.readyState==='open') { endpoint.channel.onmessage({data:frame.data}); await endpoint.peer._messageChain; }
        }
    };
    const retry = endpoint => {
        const id=endpoint.peer._helloHandshake?.timer, timer=timers.get(id);
        assert.ok(timer,'bounded hello retry is pending'); timers.delete(id); timer.fn();
    };
    return {a,b,frames,allSent,timers,open,deliver,pump,retry};
}
test('a lost initial hello is retransmitted even when its sender already received the other endpoint hello', async () => {
    const h=harness();h.open(h.a);h.open(h.b);
    assert.equal(h.frames.shift().from,'a'); // Reproduce the one-way initial control-frame loss.
    await h.pump();
    assert.equal(h.a.peer._remoteHello,true);assert.equal(h.b.peer._remoteHello,false);
    h.a.peer._path={direct:true,status:'selected'};h.a.peer._code='ABCD ABCD ABCD';
    h.a.peer.verify();assert.equal(h.a.peer._verified,false);assert.equal(h.a.peer._canSend(),false);
    assert.equal(h.a.peer._protocolReady(),false,'one-way hello cannot authorize an early offer to an unready peer');
    // Replacing a DataChannel under the same DTLS identity can leave an old
    // verification flag. No user payload may precede the new wire handshake.
    h.a.peer._verified=true;
    h.a.peer.sendText('protocol-readiness-fixture');
    assert.equal(h.allSent.some(frame=>frame.message.type==='text'),false);
    h.a.peer._verified=false;
    h.retry(h.a);await h.pump();
    for(const endpoint of [h.a,h.b]) {
        assert.equal(endpoint.peer._remoteHello,true);assert.equal(endpoint.peer._helloHandshake.acknowledged,true);
        assert.equal(endpoint.peer._helloHandshake.timer,null);assert.equal(endpoint.peer.restores,1);
        assert.equal(endpoint.peer._verified,false);assert.equal(endpoint.peer._protocolReady(),true);
    }
    h.a.peer.verify();assert.equal(h.a.peer._verified,true);assert.equal(h.a.peer._canSend(),true);
});
test('an early matching ACK only acknowledges its nonce and cannot substitute for remote hello or authorization', async () => {
    const h=harness();h.open(h.a);const nonce=h.a.peer._helloHandshake.nonce;
    await h.deliver(h.a,{type:'hello-ack',version:2,nonce:webcrypto.randomUUID()});
    assert.equal(h.a.peer._helloHandshake.acknowledged,false);
    await h.deliver(h.a,{type:'hello-ack',version:2,nonce});
    assert.equal(h.a.peer._helloHandshake.acknowledged,true);assert.equal(h.a.peer._remoteHello,false);
    assert.equal(h.a.peer._verified,false);assert.equal(h.a.peer._path.direct,false);assert.equal(h.a.peer.restores,0);
    assert.ok(h.a.peer._helloHandshake.timer);assert.equal(h.frames.filter(f=>f.message.type==='hello-ack').length,0);
});
test('an epoch-obsolete hello queued behind async work is not acknowledged; a current retry is processed', async () => {
    const h=harness();h.open(h.a);h.frames.length=0;
    let release;h.a.peer._messageChain=new Promise(resolve=>{release=resolve;});
    const hello={type:'hello',version:2,nonce:webcrypto.randomUUID()};
    h.a.channel.onmessage({data:JSON.stringify(hello)});h.a.peer._pathEpoch++;
    release();await h.a.peer._messageChain;
    assert.equal(h.a.peer._remoteHello,false);assert.equal(h.frames.length,0,'receipt before dequeue cannot earn an ACK');
    await h.deliver(h.a,hello);
    assert.equal(h.a.peer._remoteHello,true);assert.equal(h.frames.length,1);assert.equal(h.frames[0].message.type,'hello-ack');
});
test('already-open channel binding starts hello once and ignores obsolete callbacks and nonce ACKs after replacement', async () => {
    const h=harness();h.a.channel.readyState='open';h.a.peer._bindChannel(h.a.channel);
    const first=h.a.peer._helloHandshake, oldTimer=h.timers.get(first.timer).fn, oldMessage=h.a.channel.onmessage;
    assert.equal(h.allSent.filter(f=>f.from==='a'&&f.message.type==='hello').length,1);
    h.a.channel.onopen();assert.equal(h.allSent.filter(f=>f.from==='a'&&f.message.type==='hello').length,1);
    const replacement={readyState:'open',bufferedAmount:0,send(data){h.allSent.push({from:'replacement',message:JSON.parse(data)});},close(){this.readyState='closed';}};
    h.a.peer._bindChannel(replacement);const current=h.a.peer._helloHandshake;
    assert.notEqual(current.nonce,first.nonce);assert.equal(h.timers.has(first.timer),false);
    const count=h.allSent.length;oldTimer();oldMessage({data:JSON.stringify({type:'hello',version:2,nonce:webcrypto.randomUUID()})});
    assert.equal(h.allSent.length,count);assert.equal(h.a.peer._remoteHello,false);
    replacement.onmessage({data:JSON.stringify({type:'hello-ack',version:2,nonce:first.nonce})});await h.a.peer._messageChain;
    assert.equal(current.acknowledged,false);
});
test('legacy v2 hello remains compatible after a bounded ten requests without ACK', async () => {
    const h=harness();h.open(h.a);await h.deliver(h.a,{type:'hello',version:2});
    for(let i=0;i<10;i++)h.retry(h.a);
    assert.equal(h.a.peer._remoteHello,true);assert.equal(h.a.peer._state,'connecting');assert.equal(h.a.peer._closed,false);
    assert.equal(h.a.peer._helloHandshake.timer,null);assert.equal(h.allSent.filter(f=>f.message.type==='hello').length,10);
    assert.equal(h.allSent.filter(f=>f.message.type==='hello-ack').length,0);assert.equal(h.a.peer.restores,1);
});
test('missing peer hello fails with a protocol diagnosis after bounded retries even on a previously selected route', () => {
    const h=harness();h.open(h.a);h.a.peer._path={direct:true,status:'selected'};
    for(let i=0;i<10;i++)h.retry(h.a);
    assert.equal(h.allSent.filter(f=>f.message.type==='hello').length,10);
    assert.equal(h.a.peer._state,'failed');assert.match(h.a.peer._reason,/文件协议握手未完成/);
    assert.equal(h.a.peer._path.direct,false);assert.equal(h.a.peer._verified,false);assert.equal(h.a.peer._helloHandshake,null);
});
test('duplicate hello gets bounded ACKs without repeated restoration or ACK echo', async () => {
    const h=harness();h.open(h.a);const hello={type:'hello',version:2,nonce:webcrypto.randomUUID()};
    for(let i=0;i<25;i++)await h.deliver(h.a,hello);
    assert.equal(h.a.peer.restores,1);assert.equal(h.allSent.filter(f=>f.message.type==='hello-ack').length,10);
    const count=h.allSent.length;await h.deliver(h.a,{type:'hello-ack',version:2,nonce:h.a.peer._helloHandshake.nonce});
    assert.equal(h.allSent.length,count);assert.equal(h.a.peer._helloHandshake.timer,null);
});
test('ACK-capable peers cannot stay half-ready forever after exhausting the bounded handshake', async () => {
    const h=harness();h.open(h.a);await h.deliver(h.a,{type:'hello',version:2,nonce:webcrypto.randomUUID()});
    assert.equal(h.a.peer._remoteHello,true);assert.equal(h.a.peer._protocolReady(),false);
    for(let i=0;i<10;i++)h.retry(h.a);
    assert.equal(h.a.peer._state,'failed');assert.match(h.a.peer._reason,/文件协议握手未完成/);
    assert.equal(h.a.peer._verified,false);
});
test('disconnect, terminal failure and close cancel hello timers and stale callbacks cannot send', () => {
    for(const action of ['disconnect','fail','close']) {
        const h=harness();h.open(h.a);const state=h.a.peer._helloHandshake,timer=h.timers.get(state.timer).fn;
        if(action==='disconnect')h.a.peer._revokePath('disconnected',null,true);
        else if(action==='fail')h.a.peer._fail('explicit failure');else h.a.peer.close();
        assert.equal(h.a.peer._helloHandshake,null);const count=h.allSent.length;timer();assert.equal(h.allSent.length,count);
    }
});
test('an invalid-version hello ACK is rejected before it can mark capability or identity', async () => {
    const h=harness();h.open(h.a);
    await h.deliver(h.a,{type:'hello-ack',version:999,nonce:h.a.peer._helloHandshake.nonce});
    assert.equal(h.a.peer._closed,true);assert.equal(h.a.peer._remoteHello,false);assert.equal(h.a.peer._verified,false);
});
