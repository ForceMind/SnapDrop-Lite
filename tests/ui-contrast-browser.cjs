'use strict';
// Actual rendered UI and native recovery storage. Synthetic local metadata;
// no peer, invitation, file body, or user file is needed for this audit.
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const{chromium}=require('playwright'),{startDev}=require('../scripts/dev.cjs');
const errorType=error=>['AssertionError','TimeoutError','TypeError','SecurityError','QuotaExceededError'].includes(error?.name)?error.name:'Error';
function measure(){
    const color=value=>{
        const match=/^rgba?\(([^)]+)\)$/.exec(value);if(!match||match[1].includes('%'))throw Error('Unresolved computed color');
        const values=match[1].trim().split(/[,\s/]+/).map(Number);if(values.length===3)values.push(1);
        if(values.length!==4||values.some(value=>!Number.isFinite(value))||values.slice(0,3).some(value=>value<0||value>255)||values[3]<0||values[3]>1)throw Error('Invalid computed color');
        return values;
    };
    const blend=(front,back)=>front.slice(0,3).map((value,index)=>value*front[3]+back[index]*(1-front[3]));
    const opaque=element=>{
        for(let node=element;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)!==1)throw Error('Unknown ancestor opacity');
        const layers=[];let resolved=false;
        for(let node=element;node;node=node.parentElement){
            const style=getComputedStyle(node);if(style.backgroundImage!=='none')throw Error('Unknown background image or gradient');
            const value=color(style.backgroundColor);layers.push(value);if(value[3]===1){resolved=true;break;}
        }
        if(!resolved)throw Error('No opaque background ancestor');
        let result=layers.pop().slice(0,3);for(const layer of layers.reverse())result=blend(layer,result);return result;
    };
    const luminance=rgb=>rgb.map(value=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
    const ratio=(front,back)=>{const values=[luminance(front),luminance(back)].sort((a,b)=>b-a);return(values[0]+0.05)/(values[1]+0.05);};
    const text=(selector,pseudo)=>{
        const element=document.querySelector(selector);if(!element)throw Error('Contrast target absent');
        const style=getComputedStyle(element,pseudo);if(Number(style.opacity)!==1)throw Error('Unknown text opacity');
        const background=opaque(element),foreground=blend(color(style.color),background);
        return{selector:selector+(pseudo||''),computedForeground:style.color,foreground,background,ratio:ratio(foreground,background),minimum:4.5};
    };
    const button=document.querySelector('#createRoomBtn'),style=getComputedStyle(button),panel=button.closest('.invite-panel');
    if(document.activeElement!==button||!button.matches(':focus-visible')||style.outlineStyle!=='solid'||parseFloat(style.outlineWidth)<1||parseFloat(style.outlineOffset)<0)throw Error('Keyboard focus ring absent');
    const background=opaque(panel),foreground=blend(color(style.outlineColor),background);
    return{text:[text('.recovery-record span'),text('.recovery-record button'),text('#roomStatus'),text('#roomInput','::placeholder')],
        focus:{selector:'#createRoomBtn:focus-visible',computedForeground:style.outlineColor,foreground,background,ratio:ratio(foreground,background),minimum:3,
            outlineWidth:parseFloat(style.outlineWidth),outlineOffset:parseFloat(style.outlineOffset)}};
}
async function main(){
    const report={schema:1,engine:'chromium',scope:'rendered light/dark recovery row, room status, placeholder and keyboard focus; not a complete accessibility audit',
        phase:'startup',errors:[],themes:{},passed:false};let server,browser,context,page;
    try{
        await fs.mkdir('test-results',{recursive:true});server=await startDev(0);browser=await chromium.launch({headless:true});
        report.browserVersion=browser.version();context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:1440,height:1100}});
        page=await context.newPage();page.on('pageerror',error=>{if(report.errors.length<20)report.errors.push({type:errorType(error),phase:report.phase});});
        await page.goto(server.origin);await page.waitForFunction(()=>!!window.ZeydropRecovery);
        report.phase='native-recovery-row';
        assert.equal(await page.evaluate(()=>window.ZeydropRecovery.available()),true);
        await page.evaluate(async()=>{
            const id=crypto.randomUUID();window.__contrastRecoveryId=id;
            const sink=await window.ZeydropRecovery.open({id,name:'界面测试暂存',size:1,mime:'application/octet-stream'});
            await sink.park('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        });
        await page.locator('#localStorageSection').waitFor({state:'visible'});await page.locator('#localStorageManage').click();
        await page.locator('.recovery-record').waitFor({state:'visible'});assert.equal(await page.locator('.recovery-record button').isEnabled(),true);
        for(const theme of ['light','dark']){
            report.phase=theme;await page.emulateMedia({colorScheme:theme});
            await page.locator('#roomInput').focus();await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(()=>document.activeElement?.id),'createRoomBtn');
            report.themes[theme]=await page.evaluate(measure);
            for(const item of [...report.themes[theme].text,report.themes[theme].focus])assert.ok(item.ratio>=item.minimum,theme+' contrast below threshold: '+item.selector);
            await page.locator('#localStorageSection').screenshot({path:'test-results/ui-contrast-'+theme+'.png'});
        }
        report.phase='cleanup';await page.locator('.recovery-record button').click();await page.waitForFunction(()=>document.querySelectorAll('.recovery-record').length===0);
        assert.deepEqual(report.errors,[]);report.passed=true;report.phase='complete';
    }catch(error){
        report.failure=errorType(error);const line=String(error?.stack||'').match(/ui-contrast-browser\.cjs:(\d+):(\d+)/);
        if(line)report.failureLine={line:Number(line[1]),column:Number(line[2])};throw error;
    }finally{
        try{
            if(page)await page.evaluate(async()=>{if(window.__contrastRecoveryId)await window.ZeydropRecovery.erase(window.__contrastRecoveryId).catch(()=>{});}).catch(()=>{});
            await fs.mkdir('test-results',{recursive:true});await fs.writeFile('test-results/ui-contrast-chromium.json',JSON.stringify(report,null,2)+'\n');
        }finally{await Promise.allSettled([context?.close(),browser?.close(),server?.close()]);}
    }
    console.log('UI contrast browser evidence:',JSON.stringify(report));
}
main().catch(error=>{console.error('UI contrast browser test failed:',errorType(error));process.exitCode=1;});
