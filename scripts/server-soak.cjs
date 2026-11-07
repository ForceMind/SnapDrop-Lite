'use strict';
// Isolated wall-clock signaling soak. No configurable remote endpoint, file
// payload, clock injection, manual sweep or production service is involved.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseArgs } = require('node:util');
const { WebSocket } = require('../server/node_modules/ws');
const { ZeydropServer, RESUME_TTL } = require('../server');
const ORIGIN = 'http://localhost:8080';
const PREFIX = 'v=0\r\ns=zeydrop-soak-control\r\na=x-sequence:';
const LIMITS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, Infinity];
function fail(code) { const error = Error(code); error.code = code; return error; }
function normalizeSoakOptions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['connections', 'durationSeconds'].includes(key))) throw fail('invalid-options');
    const result = { durationSeconds: input.durationSeconds ?? 3600, connections: input.connections ?? 64 };
    if (!Number.isInteger(result.durationSeconds) || result.durationSeconds < 1 || result.durationSeconds > 3600) throw fail('invalid-duration');
    if (!Number.isInteger(result.connections) || result.connections < 2 || result.connections > 1000 || result.connections % 2) throw fail('invalid-connections');
    return result;
}
function histogram() {
    const counts = LIMITS.map(() => 0); let count = 0, total = 0, max = 0;
    return {
        add(value) { if (!Number.isFinite(value) || value < 0) throw fail('invalid-latency'); count++; total += value; max = Math.max(max, value); counts[LIMITS.findIndex(limit => value <= limit)]++; },
        summary() {
            const percentile = fraction => { let sum = 0; for (let i = 0; i < counts.length; i++) { sum += counts[i]; if (sum >= Math.ceil(count * fraction)) return Number.isFinite(LIMITS[i]) ? LIMITS[i] : null; } return null; };
            return { count, meanMs: count ? Math.round(total / count * 1000) / 1000 : null, maxMs: count ? Math.round(max * 1000) / 1000 : null,
                p50UpperBoundMs: count ? percentile(0.5) : null, p95UpperBoundMs: count ? percentile(0.95) : null };
        }
    };
}
async function workerMain(hardDeadlineMs) {
    if (!Number.isInteger(hardDeadlineMs) || hardDeadlineMs < 1000 || hardDeadlineMs > 3810000) throw fail('invalid-worker-deadline');
    const server = new ZeydropServer({ port: 0, host: '127.0.0.1', origins: ORIGIN });
    let maxWindowMessages = 0, maxWindowBytes = 0, budgetExceeded = false;
    const message = server.message;
    server.message = function(peer, raw) {
        const result = message.call(this, peer, raw);
        maxWindowMessages = Math.max(maxWindowMessages, peer.count); maxWindowBytes = Math.max(maxWindowBytes, peer.bytes);
        if (peer.count > 240 || peer.bytes > 512 * 1024) budgetExceeded = true;
        return result;
    };
    const stop = () => server.close().finally(() => process.exit(1));
    const deadline = setTimeout(stop, hardDeadlineMs);
    process.once('disconnect', stop);
    await new Promise((resolve, reject) => { server._wss.once('listening', resolve); server._wss.once('error', reject); });
    process.on('message', async request => {
        if (!Number.isInteger(request?.id)) return;
        if (request.command === 'close') {
            clearTimeout(deadline); process.removeListener('disconnect', stop);
            await server.close(); process.send({ reply: request.id, value: true }, () => process.disconnect()); return;
        }
        if (request.command !== 'sample') return;
        const memory = process.memoryUsage(), cpu = process.cpuUsage();
        process.send({ reply: request.id, value: {
            connections: server.connections.size, sessions: server.sessions.size, rooms: server.rooms.size, webSocketClients: server._wss.clients.size,
            rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
            processPeakRssBytes: process.resourceUsage().maxRSS * 1024, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system,
            elapsedMs: Math.round(performance.now()), maxSocketBufferedBytesAtSample: Math.max(0, ...[...server.connections.values()].map(peer => peer.socket.bufferedAmount)),
            maxObservedWindowMessages: maxWindowMessages, maxObservedWindowBytes: maxWindowBytes, budgetExceeded
        } });
    });
    process.send({ type: 'ready', port: server._wss.address().port, node: process.version, platform: process.platform, arch: process.arch });
}
async function scenario(input, shortProbe, onProgress, lateControlFailure = false) {
    const config = normalizeSoakOptions(input);
    if (shortProbe && config.durationSeconds > 10) throw fail('invalid-short-duration');
    const started = performance.now(), hardDeadlineMs = config.durationSeconds * 1000 + RESUME_TTL + 90000;
    const controller = new AbortController(), clients = new Set(), pendingRpc = new Map(), pendingSignals = new Map();
    const latencies = histogram(), helloLatencies = histogram();
    let child, readyInfo, nextRpc = 1, nextSequence = 1, heartbeatResponses = 0, sentSignals = 0, receivedSignals = 0, resumed = 0, reconnectCycles = 0, timedOut = false, previousSample;
    const report = { schema: 1, status: 'running', phase: 'startup', startedAtUTC: new Date().toISOString(),
        scope: 'isolated loopback signaling, synthetic SDP and real wall-clock heartbeat/resume; no ICE, DataChannel, file, WAN or production capacity claim',
        config, timing: { realClock: true, clockAdvanced: false, manualSweep: false, resumeGraceMs: RESUME_TTL, automaticSweepIntervalMs: 5000,
            hardDeadlineMs, signalIntervalMs: shortProbe ? 1000 : 15000, reconnectIntervalMs: shortProbe ? 3000 : 60000, sampleIntervalMs: shortProbe ? 1000 : 60000 },
        runtime: { separateServerProcess: true, serverV8OldSpaceLimitMiB: 96, osMemoryLimitApplied: false },
        counters: {}, samples: [], cleanup: { verified: false, mode: shortProbe ? 'skipped-short-regression' : 'real-wall-clock-grace-and-automatic-sweep' } };
    const delay = ms => new Promise((resolve, reject) => {
        if (controller.signal.aborted) return reject(fail('hard-deadline-exceeded'));
        const abort = () => { clearTimeout(timer); reject(fail('hard-deadline-exceeded')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
        controller.signal.addEventListener('abort', abort, { once: true });
    });
    const cutoff = setTimeout(() => { timedOut = true; controller.abort(); child?.kill('SIGKILL'); }, hardDeadlineMs);
    const emit = async () => {
        report.wallTimeMs = Math.round(performance.now() - started);
        report.counters = { signalMessagesSent: sentSignals, signalMessagesReceived: receivedSignals, heartbeatResponses, resumedConnections: resumed, reconnectCycles,
            signalRelayLatency: latencies.summary(), connectHelloLatency: helloLatencies.summary() };
        if (onProgress) await onProgress(report);
    };
    const rpc = command => new Promise((resolve, reject) => {
        if (!child?.connected) return reject(fail('worker-disconnected'));
        const id = nextRpc++, timer = setTimeout(() => { pendingRpc.delete(id); reject(fail('worker-timeout')); }, 5000);
        pendingRpc.set(id, { resolve, reject, timer }); child.send({ id, command });
    });
    const until = async (predicate, code, timeout = 5000) => {
        const limit = performance.now() + timeout;
        while (performance.now() < limit) { if (await predicate()) return; await delay(20); }
        throw fail(code);
    };
    const assertCounts = snapshot => {
        if (snapshot.connections !== config.connections || snapshot.sessions !== config.connections || snapshot.rooms !== config.connections / 2
            || snapshot.webSocketClients !== config.connections || snapshot.budgetExceeded) throw fail('resource-or-budget-mismatch');
    };
    const sample = async phase => {
        const value = await rpc('sample'), elapsed = previousSample ? value.elapsedMs - previousSample.elapsedMs : null;
        const cpuUserMicros = previousSample ? value.cpuUserMicros - previousSample.cpuUserMicros : null;
        const cpuSystemMicros = previousSample ? value.cpuSystemMicros - previousSample.cpuSystemMicros : null;
        if (report.samples.length >= 70) throw fail('sample-limit-exceeded');
        report.samples.push({ phase, atMs: Math.round(performance.now() - started), server: value,
            serverCpuSincePreviousSample: { elapsedMs: elapsed, userMicros: cpuUserMicros, systemMicros: cpuSystemMicros,
                percentOfOneCore: elapsed > 0 ? Math.round((cpuUserMicros + cpuSystemMicros) / (elapsed * 1000) * 10000) / 100 : null },
            counters: { signalMessagesSent: sentSignals, signalMessagesReceived: receivedSignals, heartbeatResponses, resumedConnections: resumed },
            signalRelayLatency: latencies.summary() });
        previousSample = value; report.phase = phase; await emit(); return value;
    };
    async function connect(resumeFrom) {
        const start = performance.now(), messages = [], waiters = [];
        const ws = new WebSocket('ws://127.0.0.1:' + readyInfo.port + '/server/webrtc', { origin: ORIGIN, handshakeTimeout: 5000, maxPayload: 64 * 1024 });
        const client = { ws, id: null, token: null, closed: false, failure: null }; clients.add(client);
        client.send = value => { if (ws.readyState !== 1) throw fail('client-not-open'); ws.send(JSON.stringify(value)); };
        ws.on('message', bytes => {
            let value; try { value = JSON.parse(bytes.toString()); } catch { client.failure = 'invalid-server-control'; return; }
            if (value.type === 'ping') { if (ws.readyState === 1) { client.send({ type: 'pong' }); heartbeatResponses++; } return; }
            if (value.type === 'signal') {
                const text = value.sdp?.sdp;
                if (typeof text !== 'string' || !text.startsWith(PREFIX)) { client.failure = 'unexpected-signal'; return; }
                const id = Number(text.slice(PREFIX.length).trim()), expected = pendingSignals.get(id);
                if (!expected || expected.recipient !== client.id || expected.sender !== value.sender) { client.failure = 'unexpected-signal'; return; }
                pendingSignals.delete(id); latencies.add(performance.now() - expected.sent); receivedSignals++; return;
            }
            if (value.type === 'room-error') { client.failure = 'room-control-rejected'; return; }
            const waiter = waiters.find(item => item.predicate(value));
            if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value); }
            else { messages.push(value); if (messages.length > 16) messages.shift(); }
        });
        ws.on('close', () => { client.closed = true; for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(fail('client-closed')); } });
        ws.on('error', () => {});
        client.wait = predicate => new Promise((resolve, reject) => {
            const index = messages.findIndex(predicate); if (index >= 0) return resolve(messages.splice(index, 1)[0]);
            if (client.closed) return reject(fail('client-closed'));
            const waiter = { predicate, resolve, reject, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(fail('client-response-timeout')); }, 5000) }; waiters.push(waiter);
        });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(fail('client-connect-failed'))); });
        const hello = client.wait(value => value.type === 'hello'); client.send({ type: 'hello', ...(resumeFrom ? { resumeToken: resumeFrom.token } : {}) });
        const value = await hello; client.id = value.peerId; client.token = value.resumeToken;
        if (resumeFrom && (client.id !== resumeFrom.id || client.token !== resumeFrom.token)) throw fail('resume-identity-changed');
        if (resumeFrom) {
            await client.wait(value => value.type === 'room-joined' && value.roomId === resumeFrom.room && value.paired === true);
            client.room = resumeFrom.room;
        }
        helloLatencies.add(performance.now() - start); return client;
    }
    async function closeClient(client) {
        if (client.ws.readyState < 2) client.ws.close(1000, 'soak-cycle');
        await until(() => client.closed, 'client-close-timeout'); clients.delete(client);
    }
    async function pair(first, second) {
        const roomId = randomBytes(16).toString('hex');
        const joined = first.wait(value => value.type === 'room-joined' && value.roomId === roomId);
        first.send({ type: 'create-room', roomId }); await joined;
        const paired = second.wait(value => value.type === 'room-joined' && value.roomId === roomId && value.paired);
        const locked = first.wait(value => value.type === 'room-joined' && value.roomId === roomId && value.paired);
        second.send({ type: 'join-room', roomId }); await Promise.all([paired, locked]); first.room = roomId; second.room = roomId;
    }
    try {
        report.source = { algorithm: 'sha256', server: createHash('sha256').update(await fs.readFile(path.join(__dirname, '../server/index.js'))).digest('hex'),
            tool: createHash('sha256').update(await fs.readFile(__filename)).digest('hex') };
        child = fork(__filename, ['--server-worker', String(hardDeadlineMs)], { execArgv: ['--max-old-space-size=96'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        readyInfo = await new Promise((resolve, reject) => {
            const startup = setTimeout(() => reject(fail('worker-start-timeout')), 10000);
            child.once('error', () => { clearTimeout(startup); reject(fail('worker-start-failed')); });
            child.on('exit', () => { clearTimeout(startup); for (const item of pendingRpc.values()) { clearTimeout(item.timer); item.reject(fail('worker-exited')); } pendingRpc.clear(); if (!readyInfo) reject(fail('worker-start-failed')); });
            child.on('message', value => {
                if (value?.type === 'ready') { clearTimeout(startup); resolve(value); return; }
                const item = pendingRpc.get(value?.reply); if (!item) return;
                clearTimeout(item.timer); pendingRpc.delete(value.reply); item.resolve(value.value);
            });
        });
        Object.assign(report.runtime, { serverNode: readyInfo.node, platform: readyInfo.platform, arch: readyInfo.arch });
        await sample('baseline');
        const cohort = await Promise.all(Array.from({ length: config.connections }, () => connect()));
        await Promise.all(Array.from({ length: cohort.length / 2 }, (_, index) => pair(cohort[index * 2], cohort[index * 2 + 1])));
        assertCounts(await sample('active'));
        const activeStarted = performance.now(), activeEnd = activeStarted + config.durationSeconds * 1000;
        report.activeStartedAtUTC = new Date().toISOString();
        let nextSignal = activeStarted, nextReconnect = activeStarted + report.timing.reconnectIntervalMs, nextSample = activeStarted + report.timing.sampleIntervalMs, resumeCursor = 0;
        while (performance.now() < activeEnd) {
            const now = performance.now();
            if (cohort.some(client => client.closed || client.failure)) throw fail('unexpected-client-state');
            if (now >= nextReconnect) {
                const count = Math.max(1, Math.ceil(cohort.length / 8)), indices = Array.from({ length: count }, (_, offset) => (resumeCursor + offset) % cohort.length);
                const old = indices.map(index => cohort[index]); await Promise.all(old.map(closeClient));
                await until(async () => (await rpc('sample')).connections === config.connections - count, 'detach-before-resume-timeout');
                const replacements = await Promise.all(old.map(client => connect(client)));
                for (let index = 0; index < indices.length; index++) cohort[indices[index]] = replacements[index];
                resumed += count; reconnectCycles++; resumeCursor = (resumeCursor + count) % cohort.length;
                assertCounts(await rpc('sample')); nextReconnect += report.timing.reconnectIntervalMs;
            }
            if (now >= nextSignal) {
                for (let index = 0; index < cohort.length; index++) {
                    const sequence = nextSequence++, sender = cohort[index], recipient = cohort[index ^ 1];
                    pendingSignals.set(sequence, { sent: performance.now(), sender: sender.id, recipient: recipient.id });
                    sender.send({ type: 'signal', to: recipient.id, sdp: { type: 'offer', sdp: PREFIX + sequence + '\r\n' } }); sentSignals++;
                }
                await until(() => pendingSignals.size === 0, 'signal-relay-timeout'); nextSignal += report.timing.signalIntervalMs;
            }
            if (now >= nextSample) { assertCounts(await sample('active')); nextSample += report.timing.sampleIntervalMs; }
            await delay(Math.min(nextSignal, nextReconnect, nextSample, activeEnd) - performance.now());
        }
        report.activeElapsedMs = Math.round(performance.now() - activeStarted);
        if (shortProbe && lateControlFailure) {
            // Test-only fault after the loop's last state check. The production
            // service returns a real room-error without changing room/session
            // state or the already-completed synthetic signal counts.
            cohort[0].send({ type: 'join-room', roomId: 'invalid-short-probe-room' });
            await until(() => cohort[0].failure === 'room-control-rejected', 'short-fault-not-observed');
            report.testProbe = { lateControlFailureInjected: true, controlFailureHandled: true, phase: 'after-active-loop' };
        }
        assertCounts(await sample('active-complete'));
        if (cohort.some(client => client.closed || client.failure)) throw fail('unexpected-client-state');
        if (sentSignals !== receivedSignals) throw fail('signal-count-mismatch');
        await Promise.all(cohort.map(closeClient));
        await until(async () => (await rpc('sample')).connections === 0, 'connection-cleanup-timeout');
        const afterClose = await sample('after-close');
        if (afterClose.sessions !== config.connections || afterClose.rooms !== config.connections / 2) throw fail('premature-retention-loss');
        report.cleanup.afterClose = { connections: afterClose.connections, sessions: afterClose.sessions, rooms: afterClose.rooms, webSocketClients: afterClose.webSocketClients };
        if (!shortProbe) {
            const cleanupStarted = performance.now(); report.phase = 'waiting-real-resume-grace'; await emit();
            await delay(60000);
            const duringGrace = await sample('waiting-real-resume-grace');
            if (duringGrace.connections || duringGrace.webSocketClients || duringGrace.sessions !== config.connections || duringGrace.rooms !== config.connections / 2)
                throw fail('real-grace-retention-mismatch');
            await delay(Math.max(0, RESUME_TTL - (performance.now() - cleanupStarted)));
            await until(async () => { const state = await rpc('sample'); return !state.connections && !state.sessions && !state.rooms && !state.webSocketClients; }, 'real-retention-cleanup-timeout', 15000);
            const afterGrace = await sample('real-grace-complete');
            report.cleanup.waitedMs = Math.round(performance.now() - cleanupStarted);
            report.cleanup.afterGrace = { connections: afterGrace.connections, sessions: afterGrace.sessions, rooms: afterGrace.rooms, webSocketClients: afterGrace.webSocketClients };
            report.cleanup.verified = true;
        }
        if (cohort.some(client => client.failure)) throw fail('unexpected-client-state');
        report.status = shortProbe ? 'short-profile-passed' : 'passed'; report.phase = 'complete';
    } catch (error) {
        report.status = 'failed'; report.failure = { code: typeof error?.code === 'string' && /^[a-z]+(?:-[a-z]+)+$/.test(error.code) ? error.code : 'soak-failed' };
    } finally {
        for (const client of clients) client.ws.terminate();
        try { if (child?.connected) await rpc('close'); } catch {}
        clearTimeout(cutoff);
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => { const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); }; const timer = setTimeout(done, 1000); child.once('exit', done); });
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        if (timedOut) { report.status = 'failed'; report.failure = { code: 'hard-deadline-exceeded' }; }
        await emit();
    }
    return report;
}
const runServerSoak = (input, onProgress) => scenario(input, false, onProgress);
const runShortSoakProbe = (input = { connections: 4, durationSeconds: 6 }, internal = {}) => {
    if (!internal || typeof internal !== 'object' || Array.isArray(internal)
        || Object.keys(internal).some(key => key !== 'lateControlFailure')
        || (internal.lateControlFailure !== undefined && typeof internal.lateControlFailure !== 'boolean')) throw fail('invalid-short-options');
    return scenario(input, true, undefined, internal.lateControlFailure === true);
};
async function main() {
    const { values } = parseArgs({ options: { connections: { type: 'string' }, 'duration-seconds': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) { process.stdout.write('Usage: node scripts/server-soak.cjs [--duration-seconds 1_TO_3600] [--connections EVEN_2_TO_1000] [--out REPORT_PATH]\nStarts only a new loopback service; no remote endpoint or file transfer. Default 3600 seconds plus real 120-second session grace and automatic sweep. Maximum hard deadline: duration + 210 seconds.\n'); return; }
    const config = normalizeSoakOptions({ durationSeconds: values['duration-seconds'] === undefined ? undefined : Number(values['duration-seconds']), connections: values.connections === undefined ? undefined : Number(values.connections) });
    const report = await runServerSoak(config, async value => {
        if (values.out) {
            const destination = path.resolve(values.out), temporary = destination + '.tmp-' + process.pid;
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, destination);
        }
        process.stderr.write(JSON.stringify({ schema: 1, status: value.status, phase: value.phase, wallTimeMs: value.wallTimeMs, samples: value.samples.length,
            signalMessagesReceived: value.counters.signalMessagesReceived, resumedConnections: value.counters.resumedConnections }) + '\n');
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (report.status !== 'passed') process.exitCode = 1;
}
module.exports = { normalizeSoakOptions, runServerSoak, runShortSoakProbe };
if (require.main === module) {
    if (process.argv[2] === '--server-worker' && typeof process.send === 'function') workerMain(Number(process.argv[3])).catch(() => process.exit(1));
    else main().catch(() => { process.stderr.write(JSON.stringify({ schema: 1, status: 'failed', code: 'soak-failed' }) + '\n'); process.exitCode = 1; });
}
