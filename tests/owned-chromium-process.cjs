'use strict';
// Test-only native process ownership. Never discovers or kills browsers by name.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function failure(code) { const error = Error(code); error.name = 'BrowserProcessError'; error.code = code; return error; }
async function processStat(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('invalid-process-observation');
    try {
        const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const result = { pid, state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
        if (!/^[A-Za-z]$/.test(result.state || '') || !/^\d+$/.test(result.start || '')
            || ![result.ppid, result.group, result.session].every(Number.isSafeInteger)) throw failure('invalid-process-stat');
        return result;
    } catch (error) { if (['ENOENT','ESRCH'].includes(error.code)) return null; throw error; }
}
async function processInfo(pid, includeCommand = true) {
    const stat = await processStat(pid); if (!stat) return null;
    try {
        const status = await fs.readFile('/proc/' + pid + '/status', 'utf8');
        const uid = /^Uid:\s+(\d+)/m.exec(status);
        if (!uid) throw failure('invalid-process-owner');
        const command = includeCommand ? await fs.readFile('/proc/' + pid + '/cmdline', 'utf8') : '';
        const after = await processStat(pid);
        if (!after || after.start !== stat.start) return null; // observed process vanished, never adopt a reused PID
        return { ...after, uid: Number(uid[1]), args: command.split('\0').filter(Boolean) };
    } catch (error) { if (['ENOENT','ESRCH'].includes(error.code)) return null; throw error; }
}
async function groupMembers(group) {
    const names = (await fs.readdir('/proc')).filter(value => /^\d+$/.test(value));
    const members = [];
    // Only stat fields of unrelated processes are inspected, one at a time.
    // Unexpected observation failures cannot silently become "zero live".
    for (const name of names) {
        const stat = await processStat(Number(name));
        if (!stat || stat.group !== group) continue;
        const owned = await processInfo(stat.pid, false);
        if (owned && owned.group === group) members.push(owned);
    }
    return members;
}
async function within(promise, timeout, code) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), timeout); })]); }
    finally { clearTimeout(timer); }
}
class OwnedChromiumProcess {
    static async launch(chromium, profile, options = {}) {
        if (process.platform !== 'linux' || typeof process.getuid !== 'function') throw failure('linux-process-proof-required');
        const owned = new OwnedChromiumProcess(chromium, profile, options);
        try { await owned._launch(); return owned; }
        catch (error) {
            try { await owned.close(); }
            catch { const cleanup = failure('owned-browser-cleanup-failed'); cleanup.retainTestProfile = true; throw cleanup; }
            throw error;
        }
    }
    constructor(chromium, profile, options) {
        this.chromium = chromium; this.profile = path.resolve(profile); this.options = options;
        this.child = null; this.browser = null; this.identity = null; this.exit = null;
        this.stderr = ''; this.spawnError = null; this.didCrash = false;
    }
    async _launch() {
        const info = await fs.lstat(this.profile);
        if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(this.profile) !== this.profile) throw failure('invalid-test-profile');
        // Remove only this test's stale endpoint file. Chromium must resolve its
        // actual crashed-profile SingletonLock; never delete that lock manually.
        await fs.rm(path.join(this.profile, 'DevToolsActivePort'), { force: true });
        const executable = this.options.executablePath || this.chromium.executablePath();
        const args = ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
            '--disable-breakpad', '--disable-crash-reporter', '--disable-component-update', '--disable-default-apps',
            '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
            '--password-store=basic', '--use-mock-keychain', '--hide-crash-restore-bubble',
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + this.profile, 'about:blank'];
        // A fresh POSIX session/group contains only this child browser family.
        // Inherited proxy/CA settings remain intact; no user profile is touched.
        const child = this.child = spawn(executable, args, { env: process.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        child.on('error', error => { this.spawnError = error; });
        child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-8192); });
        this.exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
        // Bind the original OS process identity before waiting for CDP startup.
        // This provenance is retained even if the browser exits unexpectedly.
        await within(new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }), 5000, 'browser-spawn-timeout');
        this.identity = await processInfo(child.pid); await this._verifyOwned();
        const deadline = Date.now() + 20000;
        let endpoint;
        while (Date.now() < deadline) {
            if (this.spawnError || child.exitCode !== null || child.signalCode !== null) {
                if (/Operation not permitted|\bEPERM\b/.test(this.stderr)) throw failure('runtime-operation-denied');
                throw failure(this.spawnError?.code === 'ENOENT' ? 'browser-executable-unavailable' : 'browser-startup-failed');
            }
            let lines;
            try { lines = (await fs.readFile(path.join(this.profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (lines && /^\d{1,5}$/.test(lines[0]) && Number(lines[0]) > 0 && Number(lines[0]) <= 65535
                && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(lines[1])) {
                endpoint = 'ws://127.0.0.1:' + lines[0] + lines[1]; this.endpointToken = lines[1]; break;
            }
            await delay(50);
        }
        if (!endpoint) throw failure('browser-endpoint-timeout');
        await this._verifyOwned();
        // Public protocol API; the endpoint capability is never printed/saved.
        this.browser = await this.chromium.connectOverCDP(endpoint, { timeout: 15000 });
        await this._verifyOwned();
        const cdp = await this.browser.newBrowserCDPSession();
        try {
            const native = await cdp.send('SystemInfo.getProcessInfo');
            assert.ok(native.processInfo.some(info => info.type === 'browser' && info.id === child.pid),
                'the exact CDP capability must identify the spawned owned process');
        } finally { await cdp.detach(); }
        this.context = this.browser.contexts()[0]; assert.ok(this.context, 'persistent default context must exist');
    }
    async _verifyOwned() {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null || !Number.isSafeInteger(child.pid) || child.pid <= 1 || child.pid === process.pid) throw failure('invalid-owned-pid');
        const value = await processInfo(child.pid), self = await processInfo(process.pid);
        if (!value || value.ppid !== process.pid || value.uid !== process.getuid() || value.group !== child.pid
            || value.session !== child.pid || self.group === child.pid || !/^\d+$/.test(value.start || '')
            || (this.identity && value.start !== this.identity.start)
            || value.args.filter(arg => arg.startsWith('--user-data-dir=')).length !== 1
            || !value.args.includes('--user-data-dir=' + this.profile)) throw failure('owned-process-identity-mismatch');
        return value;
    }
    async _waitNoLiveGroup() {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const members = await groupMembers(this.child.pid);
            const live = members.filter(value => !['Z','X','x'].includes(value.state));
            if (!live.length) return { liveMembers: 0, zombieMembers: members.length };
            await delay(50);
        }
        throw failure('owned-browser-family-still-live');
    }
    async _killOwnedFamily() {
        await this._verifyOwned();
        const members = await groupMembers(this.child.pid);
        if (!members.length || members.some(value => value.session !== this.child.pid || value.uid !== process.getuid()))
            throw failure('owned-process-group-mismatch');
        this.identity ||= await processInfo(this.child.pid);
        // The negative target is ONLY the verified fresh browser's PGID. It
        // cannot equal our group or a name-selected/system browser process.
        await this._verifyOwned(); // Repeat after the process-group scan, immediately before the signal.
        process.kill(-this.child.pid, 'SIGKILL');
        const exit = await within(this.exit, 10000, 'owned-browser-exit-timeout');
        const family = await this._waitNoLiveGroup();
        return { exit, family, observedMembersBeforeKill: members.length };
    }
    async crash() {
        assert.ok(this.browser?.isConnected(), 'crash must target a connected owned browser');
        const cdp = await this.browser.newBrowserCDPSession();
        let coreCount = 0;
        try {
            const native = await cdp.send('SystemInfo.getProcessInfo');
            assert.ok(native.processInfo.some(info => info.type === 'browser' && info.id === this.child.pid));
            assert.ok(native.processInfo.some(info => info.type === 'renderer'), 'a real receiver renderer must exist');
            for (const info of native.processInfo) {
                const actual = await processInfo(info.id, false);
                if (!actual || ['Z','X','x'].includes(actual.state)) continue;
                if (actual.group !== this.child.pid || actual.session !== this.child.pid || actual.uid !== process.getuid())
                    throw failure('observed-browser-core-outside-owned-group');
                coreCount++;
            }
        } finally { await cdp.detach(); }
        const disconnected = new Promise(resolve => this.browser.once('disconnected', resolve));
        const outcome = await this._killOwnedFamily();
        await within(disconnected, 10000, 'owned-browser-disconnect-timeout');
        assert.equal(outcome.exit.code, null); assert.equal(outcome.exit.signal, 'SIGKILL');
        this.didCrash = true;
        return { driver: 'SIGKILL verified test-owned Chromium process group', positiveMainPidVerified: true,
            parentUidGroupSessionProfileAndStartVerified: true, ownedProcessHandle: true,
            coreProcessesObserved: coreCount, coreGroupMembershipVerified: true,
            observedMembersBeforeKill: outcome.observedMembersBeforeKill, observedMainExitCode: outcome.exit.code,
            observedMainExitSignal: outcome.exit.signal, browserDisconnected: !this.browser.isConnected(),
            oldLiveMembers: outcome.family.liveMembers, oldZombieMembers: outcome.family.zombieMembers,
            gracefulCloseBeforeSignal: false, scope: 'verified owned Chromium group and observed core processes; not OS shutdown or power loss' };
    }
    async close() {
        if (!this.child?.pid) return;
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
            if (!this.didCrash) await this._waitNoLiveGroup();
            return;
        }
        // Final cleanup only. Never called before the crash proof.
        if (this.browser?.isConnected()) {
            try { const cdp = await this.browser.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch {}
            try { await within(this.exit, 5000, 'graceful-test-cleanup-timeout'); await this._waitNoLiveGroup(); return; } catch {}
        }
        await this._killOwnedFamily();
    }
}
module.exports = { OwnedChromiumProcess };
