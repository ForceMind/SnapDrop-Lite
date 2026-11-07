'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { normalizeSoakOptions, runShortSoakProbe } = require('../scripts/server-soak.cjs');

function privateKeys(value) {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, item]) => [
        ...(/^(peerId|roomId|resumeToken|url|hostname|address|ip|sdp|candidate|filename|fileName|outputPath)$/i.test(key) ? [key] : []),
        ...privateKeys(item)
    ]);
}

test('soak options are finite, connection-bounded and cannot select a remote endpoint', () => {
    assert.deepEqual(normalizeSoakOptions(), { durationSeconds: 3600, connections: 64 });
    assert.deepEqual(normalizeSoakOptions({ durationSeconds: 1, connections: 2 }), { durationSeconds: 1, connections: 2 });
    assert.deepEqual(normalizeSoakOptions({ durationSeconds: 3600, connections: 1000 }), { durationSeconds: 3600, connections: 1000 });
    for (const input of [
        { durationSeconds: 0 }, { durationSeconds: 3601 }, { durationSeconds: 1.5 }, { durationSeconds: '1' },
        { durationSeconds: NaN }, { durationSeconds: Infinity }, { connections: 1 }, { connections: 3 },
        { connections: 1002 }, { connections: '64' }, { connections: Infinity },
        { url: 'ws://do-not-connect.example' }, { out: 'private-output.json' }, { graceMs: 0 }
    ]) assert.throws(() => normalizeSoakOptions(input));
});

test('soak CLI has bounded help and rejects remote arguments without echoing them', () => {
    const help = spawnSync(process.execPath, ['scripts/server-soak.cjs', '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /duration-seconds/);
    assert.match(help.stdout, /3600/);
    const result = spawnSync(process.execPath, ['scripts/server-soak.cjs', '--url', 'ws://do-not-connect.example'], {
        encoding: 'utf8', timeout: 5000
    });
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.status, 'failed');
    assert.ok(!result.stdout.includes('do-not-connect'));
    assert.ok(!result.stderr.includes('do-not-connect'));
    assert.deepEqual(privateKeys(failure), []);
    const internalFault = spawnSync(process.execPath, ['scripts/server-soak.cjs', '--late-control-failure'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(internalFault.status, 1, 'a short-regression fault cannot be enabled through the public CLI');
    assert.equal(JSON.parse(internalFault.stderr).status, 'failed');
});

test('short soak uses real isolated sockets, heartbeat and identity resume without claiming grace cleanup', { timeout: 20000 }, async () => {
    const report = await runShortSoakProbe();
    assert.equal(report.status, 'short-profile-passed', JSON.stringify(report.failure));
    assert.equal(report.phase, 'complete');
    assert.deepEqual(report.config, { durationSeconds: 6, connections: 4 });
    assert.equal(report.runtime.separateServerProcess, true);
    assert.equal(report.runtime.serverV8OldSpaceLimitMiB, 96);
    assert.equal(report.runtime.osMemoryLimitApplied, false);
    assert.equal(report.timing.realClock, true);
    assert.equal(report.timing.clockAdvanced, false);
    assert.equal(report.timing.manualSweep, false);
    assert.equal(report.timing.resumeGraceMs, 120000);
    assert.equal(report.timing.automaticSweepIntervalMs, 5000);
    assert.ok(report.timing.hardDeadlineMs > report.config.durationSeconds * 1000 + report.timing.resumeGraceMs);
    assert.ok(report.activeElapsedMs >= 6000);

    assert.ok(report.counters.signalMessagesSent >= 8);
    assert.equal(report.counters.signalMessagesReceived, report.counters.signalMessagesSent);
    assert.equal(report.counters.signalRelayLatency.count, report.counters.signalMessagesReceived);
    assert.ok(report.counters.heartbeatResponses >= 4, 'six seconds must cross a real five-second heartbeat sweep');
    assert.ok(report.counters.resumedConnections >= 1, 'a closed transport must resume the same existing server identity');
    assert.ok(report.counters.reconnectCycles >= 1);
    assert.equal(report.counters.connectHelloLatency.count, 4 + report.counters.resumedConnections);

    assert.ok(report.samples.length >= 4 && report.samples.length <= 70);
    for (const sample of report.samples) {
        assert.ok(sample.server.rssBytes > 0);
        assert.ok(sample.server.processPeakRssBytes > 0);
        assert.equal(sample.server.budgetExceeded, false);
        assert.ok(sample.server.maxObservedWindowMessages <= 240);
        assert.ok(sample.server.maxObservedWindowBytes <= 512 * 1024);
        assert.ok(sample.serverCpuSincePreviousSample.percentOfOneCore === null
            || sample.serverCpuSincePreviousSample.percentOfOneCore >= 0);
        if (sample.phase === 'active' || sample.phase === 'active-complete') {
            assert.equal(sample.server.connections, 4);
            assert.equal(sample.server.sessions, 4);
            assert.equal(sample.server.rooms, 2);
            assert.equal(sample.server.webSocketClients, 4);
        }
    }
    assert.deepEqual(report.cleanup.afterClose, { connections: 0, sessions: 4, rooms: 2, webSocketClients: 0 });
    assert.equal(report.cleanup.mode, 'skipped-short-regression');
    assert.equal(report.cleanup.verified, false, 'the short probe cannot claim the real two-minute retention check');
    assert.equal(report.cleanup.afterGrace, undefined);
    assert.deepEqual(privateKeys(report), []);
    assert.ok(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(JSON.stringify(report)));
    assert.ok(!JSON.stringify(report).includes('resumeToken'));
    assert.ok(!JSON.stringify(report).includes('ws://'));
});

test('a real control failure after the final activity-loop check cannot pass a short probe', { timeout: 10000 }, async () => {
    const report = await runShortSoakProbe({ connections: 2, durationSeconds: 1 }, { lateControlFailure: true });
    assert.deepEqual(report.testProbe, { lateControlFailureInjected: true, controlFailureHandled: true, phase: 'after-active-loop' });
    assert.equal(report.counters.signalMessagesSent, report.counters.signalMessagesReceived,
        'late control failure must be detected even when every expected signal was delivered');
    const active = report.samples.find(sample => sample.phase === 'active-complete');
    assert.equal(active.server.connections, 2); assert.equal(active.server.sessions, 2); assert.equal(active.server.rooms, 1);
    assert.equal(active.server.budgetExceeded, false);
    assert.equal(report.status, 'failed', 'resource counts and expected signal totals cannot override a handled late error');
    assert.equal(report.failure.code, 'unexpected-client-state');
    assert.equal(report.cleanup.verified, false);
    assert.deepEqual(privateKeys(report), []);
    assert.ok(!JSON.stringify(report).includes('invalid-short-probe-room'));
});
