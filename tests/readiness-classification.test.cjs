'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyConnectionTimeout}=require('./webkit-transfer.cjs');
test('browser readiness diagnostics distinguish selected routes, channel, protocol hello and identity without granting a late pass',()=>{
    const ready={appDirect:true,channelState:'open',remoteHello:true,codeAvailable:true};
    assert.equal(classifyConnectionTimeout(null),'connection-snapshot-unavailable');
    assert.equal(classifyConnectionTimeout([ready,{...ready,appDirect:false}]),'selected-route-unavailable');
    assert.equal(classifyConnectionTimeout([ready,{...ready,channelState:'connecting'}]),'channel-not-open');
    // Actual CI50 failure shape: both selected/open/connected, one protocol hello absent.
    assert.equal(classifyConnectionTimeout([{...ready,rtc:'connected',ice:'connected',dtls:'connected'},
        {...ready,rtc:'connected',ice:'connected',dtls:'connected',remoteHello:false}]),'protocol-hello-not-ready');
    assert.equal(classifyConnectionTimeout([ready,{...ready,protocolReady:false}]),'protocol-hello-not-ready');
    assert.equal(classifyConnectionTimeout([ready,{...ready,appDirect:false,helloHandshakeTimedOut:true}]),'protocol-hello-not-ready');
    assert.equal(classifyConnectionTimeout([ready,{...ready,codeAvailable:false}]),'security-code-not-ready');
    assert.equal(classifyConnectionTimeout([ready,ready]),'connection-readiness-timeout');
});
