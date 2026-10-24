'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function manager() {
    let now = 1000;
    const target = Object.assign(new EventTarget(), { RTCPeerConnection: function(){}, crypto: {subtle:{}} });
    const context = { window: target, CustomEvent, TextEncoder, TransferPeer: class {}, Date: class extends Date { static now(){return now;} } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/network.js','utf8') + `\nRTCPeer = class { constructor(server,id){this.id=id;this.messages=[];} onServerMessage(message){this.messages.push(message);} close(){} }; this.Manager=PeersManager; this.fire=(type,detail)=>Events.fire(type,detail);`,context);
    return { manager:new context.Manager({}), fire:context.fire, tick:ms=>now+=ms };
}
test('ICE/SDP arriving before discovery waits for the authorized peer and preserves order', () => {
    const {manager:m,fire} = manager();
    fire('signal',{sender:'peer-a',ice:{candidate:'candidate:early'}});
    fire('signal',{sender:'peer-a',sdp:{type:'offer',sdp:'v=0'}});
    assert.equal(m.peers.size,0,'signaling alone must not create a peer');
    fire('peer-joined',{id:'peer-a'});
    assert.equal(m.peers.get('peer-a').messages.length,2);
    assert.ok(m.peers.get('peer-a').messages[0].ice);
    assert.equal(m.peers.get('peer-a').messages[1].sdp.type,'offer');
    assert.equal(m._earlySignals.length,0); assert.equal(m._earlySignalBytes,0);
});
test('early signals have a bounded lifetime and budget and clear when a room is left', () => {
    const {manager:m,fire,tick} = manager();
    for(let i=0;i<100;i++) fire('signal',{sender:'peer-a',ice:{candidate:'candidate:'+i+'x'.repeat(8000)}});
    assert.ok(m._earlySignals.length<=64); assert.ok(m._earlySignalBytes<=256*1024);
    tick(10001); fire('peers',[{id:'peer-a'}]); assert.equal(m.peers.get('peer-a').messages.length,0);
    fire('signal',{sender:'peer-b',sdp:{type:'offer',sdp:'v=0'}});
    fire('peers',[]); assert.equal(m._earlySignals.length,0); assert.equal(m._earlySignalBytes,0);
});
