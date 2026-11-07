'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {WebSocket}=require('../server/node_modules/ws');
const {ZeydropServer}=require('../server');
const origin='http://localhost:8080';
async function setup(t){
    const server=new ZeydropServer({port:0,origins:origin});
    await new Promise(resolve=>server._wss.once('listening',resolve));
    t.after(()=>server.close());
    const transport=()=>new Promise((resolve,reject)=>{
        const ws=new WebSocket('ws://127.0.0.1:'+server._wss.address().port+'/server/webrtc',{origin});
        ws.once('open',()=>resolve(ws));ws.on('error',reject);
    });
    return {server,transport};
}
function fillDetached(server,size){
    // Reachable precondition: sessions retained after their sockets close.
    // Populate it directly to avoid opening 1000 sockets in every unit run.
    while(server.sessions.size<size){const token=randomBytes(32).toString('hex');server.sessions.set(token,{id:randomUUID(),token,room:null,peer:null,detached:Date.now(),name:'fixture'});}
}
function hello(ws,resumeToken){
    return new Promise((resolve,reject)=>{
        const finish=value=>{clearTimeout(timer);ws.off('message',message);ws.off('close',closed);resolve(value);};
        const message=data=>{const value=JSON.parse(data.toString());if(value.type==='hello')finish({kind:'hello',value});};
        const closed=code=>finish({kind:'closed',code});
        const timer=setTimeout(()=>{ws.off('message',message);ws.off('close',closed);reject(Error('bounded hello timeout'));},1500);
        ws.on('message',message);ws.once('close',closed);ws.send(JSON.stringify({type:'hello',...(resumeToken?{resumeToken}:{})}));
    });
}
async function disconnected(server,ws){
    const close=new Promise(resolve=>ws.once('close',resolve));ws.close();await close;
    const deadline=Date.now()+1500;while(server.connections.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(server.connections.size,0);
}
test('concurrent already-upgraded hello messages cannot exceed the session cap',async t=>{
    const {server,transport}=await setup(t);fillDetached(server,999);
    const sockets=await Promise.all([transport(),transport()]);
    const results=await Promise.all(sockets.map(ws=>hello(ws)));
    assert.equal(server.sessions.size,1000);
    assert.equal(results.filter(value=>value.kind==='hello').length,1);
    assert.equal(results.filter(value=>value.kind==='closed'&&value.code===1008).length,1);
});
test('a full session table allows an existing identity to resume but refuses fresh allocation',async t=>{
    const {server,transport}=await setup(t);const first=await transport();const identity=(await hello(first)).value;
    await disconnected(server,first);fillDetached(server,1000);
    const resumed=await transport(),result=await hello(resumed,identity.resumeToken);
    assert.equal(result.kind,'hello');assert.equal(result.value.peerId,identity.peerId);assert.equal(server.sessions.size,1000);
    const fresh=await transport();assert.deepEqual(await hello(fresh),{kind:'closed',code:1008});assert.equal(server.sessions.size,1000);
});
test('session-resume admission preserves the separate bound on unauthenticated transports',async t=>{
    const {server,transport}=await setup(t);fillDetached(server,1000);
    for(let i=0;i<1000;i++)server.connections.set('fixture-'+i,{socket:{terminate(){}},session:null,connected:Date.now(),lastBeat:Date.now()});
    try{await assert.rejects(transport(),/401/);assert.equal(server.connections.size,1000);}
    finally{server.connections.clear();}
});
