'use strict';
// A remote peer chooses incoming IDs. It must not alias the local outgoing
// transfer and make cancel lose ownership of an accepted receive writer.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
test('cross-direction ID collision cannot leave an accepted receive writer un-aborted',async()=>{
    const{sha256}=await import('@noble/hashes/sha2.js');let opened=0,aborted=0;
    const context=vm.createContext({
        crypto:crypto.webcrypto,performance,TextEncoder,Uint8Array,Blob,File,
        setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
        Events:{fire(){}},window:{ZeydropHash:sha256,showSaveFilePicker:async()=>({createWritable:async()=>{opened++;return{
            async write(){},async close(){},async abort(){aborted++;}
        };}})}
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.Peer=TransferPeer;',context);
    const peer=new context.Peer({},'verified-counterparty');peer._verified=true;peer._path={direct:true};peer._remoteHello=true;
    peer._isConnected=()=>true;peer._send=()=>{};
    peer.sendFiles([new File(['outgoing bytes'],'outgoing.bin')]);const id=peer._outgoing.meta.id;
    let rejected=false;
    try{await peer._onMessage(JSON.stringify({type:'offer',id,name:'incoming.bin',size:1,mime:'application/octet-stream'}));}catch{rejected=true;}
    if(rejected||!peer._incoming){assert.equal(opened,0);peer.abortAll('fixture cleanup');return;}
    await peer.acceptIncoming(id);assert.equal(opened,1);
    peer.cancel(id);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(peer._outgoing,null);assert.equal(peer._incoming,null);
    assert.equal(aborted,1,'cancel must not lose the receiver sink when outgoing IDs collide');
});

test('a colliding remote offer cannot leak the shared 64 MiB fallback reservation',async()=>{
    const{sha256}=await import('@noble/hashes/sha2.js');
    const context=vm.createContext({
        crypto:crypto.webcrypto,performance,TextEncoder,Uint8Array,Blob,File,
        setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
        Events:{fire(){}},window:{ZeydropHash:sha256,ZEYDROP_CONFIG:{memoryLimit:64*1024*1024}}
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.Peer=TransferPeer;',context);
    const peer=new context.Peer({},'verified-counterparty');peer._verified=true;peer._path={direct:true};peer._remoteHello=true;
    peer._isConnected=()=>true;peer._send=()=>{};
    peer.sendFiles([new File(['outgoing'],'outgoing.bin')]);const outgoing=peer._outgoing,id=outgoing.meta.id;
    await peer._onMessage(JSON.stringify({type:'offer',id,name:'collision.bin',size:64*1024*1024,mime:'application/octet-stream'}));
    if(peer._incoming){await peer.acceptIncoming(id);peer.cancel(id);}else{assert.equal(peer._outgoing,outgoing);peer.cancel(id);}
    const next=crypto.randomUUID();
    await peer._onMessage(JSON.stringify({type:'offer',id:next,name:'legitimate.bin',size:64*1024*1024,mime:'application/octet-stream'}));
    await peer.acceptIncoming(next);
    try{assert.ok(peer._incoming?.sink,'the legitimate file must still have the entire 64 MiB budget available');}
    finally{peer.abortAll('fixture cleanup');}
});

test('different transfer IDs still allow simultaneous bidirectional files with complete content equality',async()=>{
    const{sha256}=await import('@noble/hashes/sha2.js');const received=[];
    const context=vm.createContext({
        crypto:crypto.webcrypto,performance,TextEncoder,Uint8Array,Blob,File,
        setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
        Events:{fire(type,value){if(type==='file-received')received.push(value);}},window:{ZeydropHash:sha256,ZEYDROP_CONFIG:{}}
    });
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.Peer=TransferPeer;',context);
    const a=new context.Peer({},'b'),b=new context.Peer({},'a');
    for(const peer of[a,b]){peer._verified=true;peer._path={direct:true};peer._remoteHello=true;peer._isConnected=()=>true;peer._waitForDrain=async()=>{};peer.close=()=>{};}
    a._send=data=>queueMicrotask(()=>b._receive(data));b._send=data=>queueMicrotask(()=>a._receive(data));
    const until=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('bidirectional fixture timed out');};
    const contents={'from-a.bin':Buffer.from('来自 A 的完整数据'.repeat(300)),'from-b.bin':Buffer.from('来自 B 的完整数据'.repeat(500))};
    try{
        a.sendFiles([new File([contents['from-a.bin']],'from-a.bin')]);b.sendFiles([new File([contents['from-b.bin']],'from-b.bin')]);
        assert.notEqual(a._outgoing.meta.id,b._outgoing.meta.id);
        await until(()=>a._incoming&&b._incoming);
        await Promise.all([a.acceptIncoming(a._incoming.meta.id),b.acceptIncoming(b._incoming.meta.id)]);
        await until(()=>received.length===2);await until(()=>!a._outgoing&&!b._outgoing);
        for(const item of received){assert.deepEqual(Buffer.from(await item.blob.arrayBuffer()),contents[item.name]);item.release();}
    }finally{a.abortAll('fixture cleanup');b.abortAll('fixture cleanup');}
});
