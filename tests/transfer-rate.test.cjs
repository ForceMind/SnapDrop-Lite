'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function rig(){
    let now=0;const events=[];
    const c=vm.createContext({window:{},performance:{now:()=>now},Events:{fire:(_,info)=>events.push(info)},setTimeout,clearTimeout});
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js','utf8')+'\nthis.T=TransferPeer;',c);
    const peer=new c.T({},'peer'),state={meta:{id:'rate',name:'fixture',size:10000},acked:0,start:0};
    return {state,events,progress:(time,bytes,phase='sending')=>{now=time;state.acked=bytes;peer._progress(state,phase);return events.at(-1);}};
}
test('pause and prefix rehash time do not dilute resumed file speed or ETA',()=>{
    const h=rig();h.progress(0,0);assert.equal(h.progress(1000,1000).speed,1000);
    h.progress(5000,1000,'paused');h.progress(6000,1000,'resuming');
    assert.equal(h.progress(10000,7000).speed,0,'restored prefix bytes do not count as new throughput');
    const sample=h.progress(11000,7500);assert.equal(sample.speed,500);assert.equal(sample.eta,5);
});
test('recent sustained progress controls throughput rather than lifetime file average',()=>{
    const h=rig();for(let i=0;i<=20;i++)h.progress(i*1000,i<10?i*100:900+(i-9)*500);
    assert.equal(h.events.at(-1).speed,500);assert.ok(h.state.rateSamples.length<=20);
});
test('rate history remains bounded and stopped transfers do not claim active throughput',()=>{
    const h=rig();for(let i=0;i<1000;i++)h.progress(i*200,i);
    assert.ok(h.state.rateSamples.length<=20);assert.equal(h.progress(200000,999,'cancelled').speed,0);assert.equal(h.state.rateSamples.length,0);
});
