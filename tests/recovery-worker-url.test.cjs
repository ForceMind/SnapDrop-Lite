'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('client/scripts/recovery.js','utf8');
function rig(scriptUrl,{pageUrl='https://zeydrop.example/app/',dom=true}={}){
    const urls=[],document={currentScript:{src:scriptUrl},baseURI:pageUrl};
    class Worker{
        constructor(url){urls.push(url);}
        postMessage(message){this.onmessage({data:{request:message.request,ok:true,value:true}});}
        terminate(){}
    }
    const context={window:{},Worker,navigator:{storage:{getDirectory(){}}}};
    if(dom)Object.assign(context,{document,URL,location:new URL(pageUrl)});
    vm.createContext(context);vm.runInContext(source,context);
    return{store:context.window.ZeydropRecovery,document,urls};
}
test('recovery Worker inherits its loaded script version query and adjacent path base',async()=>{
    for(const [script,expected] of [
        ['https://zeydrop.example/scripts/recovery.js?v=revision-old','https://zeydrop.example/scripts/recovery-worker.js?v=revision-old'],
        ['https://zeydrop.example/releases/r7/scripts/recovery.js?v=abc123&mode=local#ignored','https://zeydrop.example/releases/r7/scripts/recovery-worker.js?v=abc123&mode=local'],
        ['/app/scripts/recovery.js?v=relative','https://zeydrop.example/app/scripts/recovery-worker.js?v=relative'],
        ['https://zeydrop.example/scripts/recovery.js','https://zeydrop.example/scripts/recovery-worker.js']
    ]){
        const h=rig(script);assert.equal(h.urls.length,0,'Worker remains lazy until recovery is requested');
        assert.equal(await h.store.available(),true);assert.equal(h.urls[0],expected);
    }
});
test('a later script/currentScript change cannot replace the recovery shell version',async()=>{
    const h=rig('https://zeydrop.example/scripts/recovery.js?v=loaded-old');
    h.document.currentScript.src='https://zeydrop.example/scripts/unrelated.js?v=server-new';
    h.document.currentScript=null;
    await h.store.available();assert.equal(h.urls[0],'https://zeydrop.example/scripts/recovery-worker.js?v=loaded-old');
});
test('non-DOM fixtures retain the fixed local Worker fallback',async()=>{
    const h=rig(undefined,{dom:false});assert.equal(await h.store.available(),true);
    assert.equal(h.urls[0],'/scripts/recovery-worker.js');
});
test('cross-origin, credentialed, malformed or non-HTTP script URLs cannot redirect the Worker',async()=>{
    for(const script of ['https://unrelated.example/scripts/recovery.js?v=other',
        'https://user:secret@zeydrop.example/scripts/recovery.js?v=other',
        'data:text/javascript,ignored','blob:https://zeydrop.example/worker','http://[invalid','']){
        const h=rig(script);await h.store.available();assert.equal(h.urls[0],'/scripts/recovery-worker.js');
    }
});
test('both local worker artifacts remain explicit public shell inputs',async()=>{
    const{PUBLIC_CLIENT_FILES}=await import('../scripts/public-assets.mjs');
    assert.ok(PUBLIC_CLIENT_FILES.includes('client/scripts/recovery-worker.js'));
    assert.ok(PUBLIC_CLIENT_FILES.includes('client/scripts/file-hash-worker.js'));
});
