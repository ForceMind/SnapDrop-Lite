'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
    let now=1000;const added=[],sent=[];
    class FakeRTC { constructor(){this.localDescription={sdp:'v=0\r\na=ice-ufrag:local-new\r\n'};} close(){} }
    const c=vm.createContext({window:{RTCPeerConnection:FakeRTC,crypto:{subtle:{}},ZEYDROP_CONFIG:{enableStun:false},addEventListener(){},removeEventListener(){},dispatchEvent(){}},RTCPeerConnection:FakeRTC,TransferPeer:class{constructor(server,id){this._server=server;this._peerId=id;}},CustomEvent,TextEncoder,Date:class extends Date{static now(){return now;}},setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,setInterval,clearInterval});
    vm.runInContext(fs.readFileSync('client/scripts/network.js','utf8')+'\nthis.RTC=RTCPeer;',c);
    const p=new c.RTC({_peerId:'a',send:msg=>sent.push(msg)},'z');
    Object.assign(p._conn,{remoteDescription:{sdp:'v=0\r\na=ice-ufrag:old\r\n'},addIceCandidate:async ice=>added.push(ice)});
    p._securityCode=async()=>{};p._samplePath=async()=>{};
    return {p,added,sent,tick:ms=>now+=ms,cleanup:()=>clearTimeout(p._deadline)};
}
test('new-generation ICE waits for its SDP; obsolete generation never enters the current agent',async()=>{
    const h=fixture();try{
        const future={candidate:'candidate:new',usernameFragment:'new'};
        await h.p._acceptRemoteIce(future);assert.equal(h.added.length,0);
        h.p._conn.remoteDescription={sdp:'v=0\r\na=ice-ufrag:new\r\n'};
        await h.p._flushRemoteIce();assert.equal(h.added[0],future);
        await h.p._acceptRemoteIce({candidate:'candidate:old',usernameFragment:'old'});
        await h.p._acceptRemoteIce({candidate:'',usernameFragment:'old'});
        assert.equal(h.added.length,1);h.tick(10001);await h.p._flushRemoteIce();assert.equal(h.p._pendingIce.length,0);
    }finally{h.cleanup();}
});
test('ICE generation queue stays bounded and preserves matching end-of-candidates',async()=>{
    const h=fixture();try{
        for(let i=0;i<100;i++)await h.p._acceptRemoteIce({candidate:'candidate:pending',usernameFragment:'future'});
        assert.equal(h.p._pendingIce.length,64);
        const end={candidate:'',usernameFragment:'old',sdpMid:'0',sdpMLineIndex:0};
        await h.p._acceptRemoteIce(end);assert.equal(h.added[0],end);
    }finally{h.cleanup();}
});
test('browser end markers are forwarded as-is; null and old-generation callbacks are ignored',()=>{
    const h=fixture();try{
        h.p._conn.onicecandidate({candidate:null});
        h.p._conn.onicecandidate({candidate:{candidate:'',usernameFragment:'local-old',toJSON:()=>({candidate:'',usernameFragment:'local-old'})}});
        assert.equal(h.sent.length,0);
        const json={candidate:'',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'local-new'};
        h.p._conn.onicecandidate({candidate:{...json,toJSON:()=>json}});
        assert.equal(h.sent.length,1);assert.equal(h.sent[0].ice,json);
    }finally{h.cleanup();}
});
