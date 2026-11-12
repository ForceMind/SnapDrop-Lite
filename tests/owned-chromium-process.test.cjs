'use strict';
// Signal ownership regression uses only newly spawned, harmless Node children.
// It does not launch/claim Chromium, actual browser crashes or storage proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { OwnedChromiumProcess } = require('./owned-chromium-process.cjs');
const supported = process.platform === 'linux';
async function fixture() {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-owned-signal-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + profile],
        { detached: true, stdio: 'ignore', env: process.env });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const owned = new OwnedChromiumProcess({}, profile, {}); owned.child = child; owned.exit = exited;
    owned.identity = await owned._verifyOwned();
    return { profile, child, owned, exited, async cleanup() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited; await owned._waitNoLiveGroup(); await fs.rm(profile, { recursive: true, force: true });
    } };
}

test('owned process signal guard rejects parent, init and absent handles before invoking any signal', { skip: !supported }, async () => {
    const owned = new OwnedChromiumProcess({}, '/unused-test-profile', {}), original = process.kill;
    let signals = 0;
    process.kill = () => { signals++; throw Error('a rejected target must never reach signal delivery'); };
    try {
        for (const pid of [undefined, 0, 1, process.pid]) {
            owned.child = { pid, exitCode: null, signalCode: null };
            await assert.rejects(owned._killOwnedFamily(), { code: 'invalid-owned-pid' });
        }
        assert.equal(signals, 0);
    } finally { process.kill = original; }
});

test('a real test-owned child with mismatched profile or stale OS identity is never signaled', { skip: !supported }, async () => {
    const h = await fixture(), original = process.kill; let signals = 0;
    process.kill = () => { signals++; throw Error('identity mismatch must not reach signal delivery'); };
    try {
        h.owned.profile = path.join(h.profile, 'other');
        await assert.rejects(h.owned._killOwnedFamily(), { code: 'owned-process-identity-mismatch' });
        h.owned.profile = h.profile;
        h.owned.identity = { ...h.owned.identity, start: h.owned.identity.start + '1' };
        await assert.rejects(h.owned._killOwnedFamily(), { code: 'owned-process-identity-mismatch' });
        assert.equal(signals, 0); assert.equal(h.child.exitCode, null); assert.equal(h.child.signalCode, null);
    } finally { process.kill = original; await h.cleanup(); }
});

test('verified isolated group signal kills only the newly created harmless child and observes its actual SIGKILL exit', { skip: !supported }, async () => {
    const h = await fixture();
    try {
        const outcome = await h.owned._killOwnedFamily();
        assert.equal(outcome.exit.code, null); assert.equal(outcome.exit.signal, 'SIGKILL');
        assert.equal(outcome.family.liveMembers, 0); assert.ok(outcome.observedMembersBeforeKill >= 1);
        assert.equal(process.kill(process.pid, 0), true, 'the parent test process is alive in its separate group');
    } finally { await h.cleanup(); }
});
