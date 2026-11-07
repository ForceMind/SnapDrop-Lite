'use strict';
// Ephemeral CI preflight only. This script installs nothing and changes no
// service, resolver, firewall or application setting. Host/IP values exist only
// in process arguments/memory; resolver stdout is bounded and checked only in
// memory. No subprocess output is printed or persisted.
const { spawn } = require('node:child_process');
const { networkInterfaces } = require('node:os');
const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const fs = require('node:fs/promises');

function commandOk(file, args, { timeoutMs = 3000, signal, expectedAddress } = {}) {
    return new Promise(resolve => {
        if (signal?.aborted) return resolve(false);
        let child, settled = false, output = '';
        const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(false); }, timeoutMs);
        try { child = spawn(file, args, { stdio: ['ignore', expectedAddress ? 'pipe' : 'ignore', 'ignore'], signal }); }
        catch { finish(false); return; }
        if (expectedAddress) child.stdout.on('data', data => {
            if (output.length + data.length > 4096) { child.kill('SIGKILL'); finish(false); return; }
            output += data.toString();
        });
        child.once('error', () => finish(false));
        child.once('close', code => finish(code === 0 && (!expectedAddress || output.split(/\s+/).includes(expectedAddress))));
    });
}

async function stopPublisher(publisher, state) {
    if (!publisher) return true;
    if (state.closed) return true;
    return new Promise(resolve => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(termTimer); clearTimeout(killTimer); resolve(state.closed); };
        publisher.once('close', finish);
        const termTimer = setTimeout(() => { publisher.kill('SIGKILL'); }, 1000);
        const killTimer = setTimeout(() => { publisher.unref?.(); finish(); }, 2000);
        try { publisher.kill('SIGTERM'); } catch { finish(); }
    });
}

async function checkMdns(options = {}) {
    const run = options.run || commandOk;
    const publish = options.publish || ((file, args, opts) => spawn(file, args, opts));
    const interfaces = options.interfaces || networkInterfaces;
    const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const signal = options.signal;
    const report = { schema: 1, ciOnly: true, dbusActive: false, avahiActive: false,
        avahiDbusReachable: false, ipv4Available: false, publisherStarted: false,
        lookupSucceeded: false, publisherStopped: true, aborted: false, passed: false };
    let publisher;
    const state = { closed: false };
    try {
        [report.dbusActive, report.avahiActive] = await Promise.all([
            run('systemctl', ['is-active', '--quiet', 'dbus.service'], { signal }),
            run('systemctl', ['is-active', '--quiet', 'avahi-daemon.service'], { signal })
        ]);
        report.avahiDbusReachable = await run('gdbus', ['call', '--system', '--dest', 'org.freedesktop.Avahi',
            '--object-path', '/', '--method', 'org.freedesktop.Avahi.Server.GetVersionString'], { signal });
        const address = Object.values(interfaces()).flat().find(info => info && !info.internal
            && (info.family === 'IPv4' || info.family === 4) && isIP(info.address) === 4)?.address;
        report.ipv4Available = !!address;
        if (!report.dbusActive || !report.avahiActive || !report.avahiDbusReachable || !address || signal?.aborted) return report;
        const hostname = 'zeydrop-ci-' + randomUUID() + '.local';
        publisher = publish('avahi-publish-address', ['--no-reverse', hostname, address], { stdio: 'ignore', signal });
        report.publisherStopped = false;
        const started = await new Promise(resolve => {
            let settled = false;
            const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
            const timer = setTimeout(() => done(false), 1500);
            publisher.once('spawn', () => done(true));
            publisher.once('error', () => done(false));
            publisher.once('close', () => { state.closed = true; done(false); });
        });
        report.publisherStarted = started;
        if (!started) return report;
        for (let attempt = 0; attempt < 8 && !state.closed && !signal?.aborted; attempt++) {
            if (await run('getent', ['ahostsv4', hostname], { timeoutMs: 1000, signal, expectedAddress: address })) {
                report.lookupSucceeded = true; break;
            }
            if (attempt < 7) await wait(250);
        }
        return report;
    } finally {
        report.aborted = signal?.aborted === true;
        report.publisherStopped = await stopPublisher(publisher, state);
        report.passed = report.dbusActive && report.avahiActive && report.avahiDbusReachable
            && report.ipv4Available && report.publisherStarted && report.lookupSucceeded
            && report.publisherStopped && !report.aborted;
    }
}

if (require.main === module) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    checkMdns({ signal: controller.signal }).then(async report => {
        await fs.mkdir('test-results', { recursive: true });
        await fs.writeFile('test-results/ci-mdns-preflight.json', JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
    }).catch(() => { console.log(JSON.stringify({ schema: 1, ciOnly: true, preflightError: true, passed: false })); process.exitCode = 1; })
        .finally(() => { process.off('SIGINT', abort); process.off('SIGTERM', abort); });
}
module.exports = { checkMdns };
