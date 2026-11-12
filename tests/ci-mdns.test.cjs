'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { checkMdns } = require('../scripts/check-ci-mdns.cjs');
function fixture(overrides = {}) {
    const commands = [], kills = [];
    let publisher;
    const options = {
        interfaces: () => ({ SECRET_INTERFACE: [{ internal: false, family: 'IPv4', address: '192.0.2.44' }] }),
        wait: async () => {},
        run: async (command, args, opts) => { commands.push({ command, args, opts }); return true; },
        publish: (command, args, opts) => {
            commands.push({ command, args, opts }); publisher = new EventEmitter();
            publisher.kill = signal => { kills.push(signal); publisher.emit('close', 0); return true; };
            queueMicrotask(() => publisher.emit('spawn')); return publisher;
        }, ...overrides
    };
    return { options, commands, kills, publisher: () => publisher };
}
test('CI mDNS preflight validates existing services, resolves a synthetic name and cleans its publisher without exposing network data', async () => {
    const f = fixture(); const report = await checkMdns(f.options);
    assert.equal(report.passed, true); assert.equal(report.publisherStopped, true);
    const publisher=f.commands.find(call=>call.command==='avahi-publish-address');
    assert.equal(publisher.args[2], '192.0.2.44'); assert.match(publisher.args[1], /^zeydrop-ci-[a-f0-9-]+\.local$/);
    const lookup=f.commands.find(call=>call.command==='getent'); assert.equal(lookup.args[1], publisher.args[1]);
    assert.equal(lookup.opts.timeoutMs, 1000); assert.equal(publisher.opts.stdio, 'ignore');
    assert.equal(lookup.opts.expectedAddress,'192.0.2.44','lookup must match the advertised address in memory');
    assert.deepEqual(f.kills, ['SIGTERM']);
    const json=JSON.stringify(report); assert.ok(!json.includes('192.0.2.44')); assert.ok(!json.includes(publisher.args[1])); assert.ok(!json.includes('SECRET'));
    assert.ok(!f.commands.some(call=>call.command==='apt-get'||call.args.includes('start')||call.args.includes('restart')));
});
test('missing CI mDNS services never start a publisher', async () => {
    const f=fixture({run:async()=>false}); const report=await checkMdns(f.options);
    assert.equal(report.passed,false);assert.equal(report.dbusActive,false);assert.equal(report.publisherStopped,true);assert.equal(f.publisher(),undefined);
});
test('failed CI resolver lookup has a bounded retry budget and always terminates the publisher', async () => {
    let lookups=0;
    const f=fixture({run:async(command)=>command==='getent' ? (++lookups && false) : true});
    const report=await checkMdns(f.options);assert.equal(report.passed,false);assert.equal(report.lookupSucceeded,false);
    assert.equal(lookups,8);assert.equal(report.publisherStopped,true);assert.deepEqual(f.kills,['SIGTERM']);
});
test('aborted CI mDNS probe still terminates the synthetic publisher', async () => {
    const controller=new AbortController();
    const f=fixture({signal:controller.signal,run:async(command)=>{if(command==='getent')controller.abort();return command!=='getent';}});
    const report=await checkMdns(f.options);assert.equal(report.aborted,true);assert.equal(report.passed,false);
    assert.equal(report.publisherStopped,true);assert.deepEqual(f.kills,['SIGTERM']);
});
