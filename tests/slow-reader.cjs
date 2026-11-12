'use strict';
// Actual loopback WebSockets and production signaling authorization. This tool
// never accepts a host, forwards files, changes global kernel settings or mocks
// bufferedAmount. Optional Python changes only the two test sockets' buffers.
const fs = require('node:fs/promises'), path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseArgs } = require('node:util');
const { WebSocket } = require('../server/node_modules/ws');
const { ZeydropServer, RESUME_TTL } = require('../server');
const ORIGIN = 'http://localhost:8080', THRESHOLD = 128 * 1024;
const DEADLINE_MS = 45000, SIGNALS = 8, SOCKET_BUFFER_BYTES = 4096;
const SDP = 'v=0\r\ns=synthetic-slow-reader\r\na=x-pad:' + 'a'.repeat(59000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(Error(code), { code });
const PYTHON_BUFFER = `import json,socket,sys
s=socket.socket(fileno=3)
option=socket.SO_RCVBUF if sys.argv[1]=='receive' else socket.SO_SNDBUF
requested=${SOCKET_BUFFER_BYTES}
s.setsockopt(socket.SOL_SOCKET,option,requested)
print(json.dumps({'requestedBytes':requested,'effectiveBytes':s.getsockopt(socket.SOL_SOCKET,option)}))
s.detach()
`;
function normalizeSlowReaderOptions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'permanent'].includes(key))) throw fail('invalid-options');
    const mode = input.mode ?? 'auto';
    if (!['auto', 'node-pause', 'constrained'].includes(mode)) throw fail('invalid-mode');
    const permanent = input.permanent === undefined ? false : input.permanent;
    if (typeof permanent !== 'boolean') throw fail('invalid-permanent');
    return { mode, permanent };
}
async function readSlowReaderSource() {
    // Fixed local inputs pin the measured source bytes. These digests are not
    // an independent attestation of trusted modules or an immutable filesystem.
    const [server, tool] = await Promise.all([fs.readFile(path.join(__dirname, '../server/index.js')), fs.readFile(__filename)]);
    return { serverSha256: createHash('sha256').update(server).digest('hex'), toolSha256: createHash('sha256').update(tool).digest('hex') };
}
function socketBuffer(fd, direction) {
    if (!Number.isInteger(fd) || fd < 0 || !['receive', 'send'].includes(direction)) return Promise.reject(fail('socket-buffer-unavailable'));
    return new Promise((resolve, reject) => {
        let text = '', settled = false;
        const child = spawn('python3', ['-c', PYTHON_BUFFER, direction], { stdio: ['ignore', 'pipe', 'ignore', fd] });
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(result); };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('socket-buffer-timeout')); }, 2500);
        child.stdout.on('data', bytes => { text += bytes.toString(); if (text.length > 512) { child.kill('SIGKILL'); finish(fail('socket-buffer-invalid-result')); } });
        child.on('error', () => finish(fail('socket-buffer-unavailable')));
        child.on('close', code => {
            if (code !== 0) return finish(fail('socket-buffer-unavailable'));
            try {
                const result = JSON.parse(text);
                if (result.requestedBytes !== SOCKET_BUFFER_BYTES || !Number.isSafeInteger(result.effectiveBytes) || result.effectiveBytes < SOCKET_BUFFER_BYTES || result.effectiveBytes > 1024 * 1024) throw Error();
                finish(null, { requestedBytes: result.requestedBytes, effectiveBytes: result.effectiveBytes });
            } catch { finish(fail('socket-buffer-invalid-result')); }
        });
    });
}
async function serverWorker() {
    let offset = 0, observed = null;
    const server = new ZeydropServer({ port: 0, host: '127.0.0.1', origins: ORIGIN, now: () => Date.now() + offset });
    const watchdog = setTimeout(() => { server.close().finally(() => process.exit(1)); }, DEADLINE_MS);
    const originalSend = server.send;
    // Passive observations around the real method. Never assign bufferedAmount,
    // change a readyState or substitute a send/close policy.
    server.send = function(peer, message) {
        const tracked = observed && peer === observed.peer;
        const before = tracked ? peer.socket.bufferedAmount : 0, state = tracked ? peer.socket.readyState : null;
        if (tracked) {
            if (message.type === 'signal') observed.signalAttempts++;
            observed.maxBufferedBytesObserved = Math.max(observed.maxBufferedBytesObserved, before);
        }
        originalSend.call(this, peer, message);
        if (tracked) {
            observed.maxBufferedBytesObserved = Math.max(observed.maxBufferedBytesObserved, peer.socket.bufferedAmount);
            if (before > THRESHOLD && state === WebSocket.OPEN && peer.socket.readyState === WebSocket.CLOSING) {
                observed.closeInitiatedAboveThreshold = true; observed.bufferedBytesAtClose = before;
                observed.closeStartedAt = performance.now();
            }
        }
    };
    const sample = () => {
        const memory = process.memoryUsage(), cpu = process.cpuUsage();
        return { connections: server.connections.size, sessions: server.sessions.size, rooms: server.rooms.size, webSocketClients: server._wss.clients.size,
            rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
            cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system,
            slow: observed ? { signalAttempts: observed.signalAttempts, maxBufferedBytesObserved: observed.maxBufferedBytesObserved,
                closeInitiatedAboveThreshold: observed.closeInitiatedAboveThreshold, bufferedBytesAtClose: observed.bufferedBytesAtClose,
                readyState: observed.peer.socket.readyState,
                realCloseElapsedMs: observed.closeStartedAt === null ? null : Math.round(((observed.closedAt ?? performance.now()) - observed.closeStartedAt) * 1000) / 1000,
                realClosedAfterMs: observed.closedAt === null || observed.closeStartedAt === null ? null : Math.round((observed.closedAt - observed.closeStartedAt) * 1000) / 1000 } : null };
    };
    await new Promise((resolve, reject) => { server._wss.once('listening', resolve); server._wss.once('error', reject); });
    process.on('message', async message => {
        if (!Number.isInteger(message?.id)) return;
        try {
            let result;
            if (message.command === 'observe') {
                const peer = [...server.connections.values()].find(item => item.id === message.peerId);
                if (!peer) throw fail('receiver-not-found');
                const observation = observed = { peer, signalAttempts: 0, maxBufferedBytesObserved: 0, closeInitiatedAboveThreshold: false,
                    bufferedBytesAtClose: null, closeStartedAt: null, closedAt: null };
                peer.socket.once('close', () => { observation.closedAt = performance.now(); });
            } else if (message.command === 'constrain') {
                if (!observed) throw fail('receiver-not-found');
                result = await socketBuffer(observed.peer.socket._socket?._handle?.fd, 'send');
            } else if (message.command === 'expire-retention') {
                offset += RESUME_TTL + 1; server.sweep();
            } else if (message.command === 'close') {
                clearTimeout(watchdog); await server.close();
                process.send({ reply: message.id, result: true }, () => process.disconnect()); return;
            } else if (message.command !== 'sample') throw fail('invalid-worker-command');
            process.send({ reply: message.id, result: result || sample() });
        } catch (error) {
            process.send({ reply: message.id, error: ['receiver-not-found', 'socket-buffer-unavailable', 'socket-buffer-timeout', 'socket-buffer-invalid-result'].includes(error.code) ? error.code : 'worker-command-failed' });
        }
    });
    process.send({ type: 'ready', port: server._wss.address().port, node: process.version, platform: process.platform });
}
async function runSlowReader(input = {}) {
    const config = normalizeSlowReaderOptions(input), started = performance.now(), clients = new Set(), pending = new Map();
    const source = await readSlowReaderSource();
    const worker = fork(__filename, ['--server-worker'], { execArgv: ['--max-old-space-size=96'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let nextId = 0, info, timeout = false;
    const report = { schema: 1, status: 'failed', scope: 'isolated loopback signaling only; no ICE, P2P, files, WAN or production-default throughput claim',
        startedAtUTC: new Date().toISOString(), config, source, bounds: { maximumSimultaneousClients: 4, maximumTrials: (config.mode === 'auto' ? 2 : 1) + Number(config.permanent),
            maximumSignalsPerSender: SIGNALS, maximumInputBytesPerConnection: 512 * 1024, maximumInputMessagesPerConnection: 240,
            wallDeadlineMs: DEADLINE_MS, globalKernelSettingsChanged: false }, trials: [] };
    const cutoff = setTimeout(() => { timeout = true; worker.kill('SIGKILL'); for (const client of clients) client.ws.terminate(); }, DEADLINE_MS);
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fail('worker-start-timeout')), 4000);
        worker.on('error', () => { clearTimeout(timer); reject(fail('worker-start-failed')); });
        worker.on('exit', () => {
            clearTimeout(timer);
            for (const job of pending.values()) { clearTimeout(job.timer); job.reject(fail('worker-exited')); } pending.clear();
            if (!info) reject(fail('worker-start-failed'));
        });
        worker.on('message', message => {
            if (message?.type === 'ready') { clearTimeout(timer); info = message; resolve(message); return; }
            const job = pending.get(message?.reply); if (!job) return; pending.delete(message.reply); clearTimeout(job.timer);
            if (message.error) job.reject(fail(message.error)); else job.resolve(message.result);
        });
    });
    const rpc = (command, data = {}) => new Promise((resolve, reject) => {
        if (!worker.connected) return reject(fail('worker-disconnected'));
        const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(fail('worker-timeout')); }, 4500);
        pending.set(id, { resolve, reject, timer }); worker.send({ id, command, ...data });
    });
    const until = async (predicate, code, milliseconds = 3000, intervalMs = 10) => {
        const deadline = Math.min(performance.now() + milliseconds, started + DEADLINE_MS - 1000);
        while (performance.now() < deadline) { if (await predicate()) return; await pause(intervalMs); } throw fail(code);
    };
    async function connect() {
        const ws = new WebSocket('ws://127.0.0.1:' + info.port + '/server/webrtc', { origin: ORIGIN, handshakeTimeout: 3000 });
        const messages = [], waiters = [], client = { ws, inputBytes: 0, inputMessages: 0, closeCode: null, closeReasonExpected: false, id: null };
        clients.add(client);
        const send = message => {
            const raw = JSON.stringify(message), bytes = Buffer.byteLength(raw);
            if (bytes > 64 * 1024 || client.inputBytes + bytes > 512 * 1024 || client.inputMessages + 1 > 240) throw fail('sender-budget-exceeded');
            if (ws.readyState !== WebSocket.OPEN) throw fail('client-not-open');
            client.inputBytes += bytes; client.inputMessages++; ws.send(raw);
        };
        client.send = send;
        ws.on('message', raw => {
            let message; try { message = JSON.parse(raw.toString()); } catch { return; }
            if (message.type === 'ping') { if (ws.readyState === WebSocket.OPEN) send({ type: 'pong' }); return; }
            const index = waiters.findIndex(item => item.predicate(message));
            if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
            else { messages.push(message); if (messages.length > 16) messages.shift(); }
        });
        ws.on('close', (code, reason) => {
            client.closeCode = code; client.closeReasonExpected = reason.toString() === 'Slow signaling client';
            for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(fail('client-closed')); }
        });
        ws.on('error', () => {});
        client.wait = predicate => new Promise((resolve, reject) => {
            const index = messages.findIndex(predicate); if (index >= 0) return resolve(messages.splice(index, 1)[0]);
            if (client.closeCode !== null) return reject(fail('client-closed'));
            const waiter = { predicate, resolve, reject, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(fail('client-response-timeout')); }, 3000) };
            waiters.push(waiter);
        });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(fail('client-connect-failed'))); });
        const hello = client.wait(message => message.type === 'hello'); send({ type: 'hello' }); client.id = (await hello).peerId; return client;
    }
    async function pair(a, b) {
        const roomId = randomBytes(16).toString('hex');
        const created = a.wait(message => message.type === 'room-joined' && message.roomId === roomId);
        a.send({ type: 'create-room', roomId }); await created;
        const joined = b.wait(message => message.type === 'room-joined' && message.roomId === roomId && message.paired);
        const locked = a.wait(message => message.type === 'room-joined' && message.roomId === roomId && message.paired);
        b.send({ type: 'join-room', roomId }); await Promise.all([joined, locked]);
    }
    async function exchange(a, b, ordinal) {
        const sdp = 'v=0\r\ns=synthetic-control\r\na=x-probe:' + ordinal + '\r\n';
        for (const [from, to] of [[a, b], [b, a]]) {
            const received = to.wait(message => message.type === 'signal' && message.sender === from.id && message.sdp?.sdp === sdp);
            from.send({ type: 'signal', to: to.id, sdp: { type: 'offer', sdp } }); await received;
        }
    }
    async function closeAll() {
        for (const client of clients) { client.ws.resume(); if (client.ws.readyState === WebSocket.OPEN) client.ws.close(1000, 'fixture-complete'); }
        try { await until(() => [...clients].every(client => client.closeCode !== null), 'client-cleanup-timeout', 1500); }
        finally { for (const client of clients) if (client.ws.readyState !== WebSocket.CLOSED) client.ws.terminate(); }
        await until(async () => (await rpc('sample')).connections === 0, 'connection-cleanup-timeout'); clients.clear();
        const sample = await rpc('expire-retention');
        if (sample.connections || sample.sessions || sample.rooms || sample.webSocketClients) throw fail('resource-cleanup-failed');
        return sample;
    }
    try {
        const runtime = await ready;
        report.runtime = { serverNode: runtime.node, platform: runtime.platform, separateServerProcess: true, serverHeapLimitMiB: 96, osMemoryLimitApplied: false };
        const trials = (config.mode === 'auto' ? ['node-pause', 'constrained'] : [config.mode]).map(mode => ({ mode, permanent: false }));
        if (config.permanent) trials.push({ mode: 'constrained', permanent: true });
        let regularPassed = false;
        for (const { mode, permanent } of trials) {
            if (!permanent && config.mode === 'auto' && regularPassed) continue;
            const trial = { mode: permanent ? 'permanent-constrained' : mode, permanent, status: 'failed', defaultSocketBuffers: mode === 'node-pause', receiverPaused: false,
                productionSendPolicyUnmodified: true, bufferedAmountSynthetic: false, thresholdBytes: THRESHOLD, resources: { before: await rpc('sample') } };
            report.trials.push(trial);
            const [sender, receiver, normalA, normalB] = await Promise.all([connect(), connect(), connect(), connect()]);
            await Promise.all([pair(sender, receiver), pair(normalA, normalB)]);
            await rpc('observe', { peerId: receiver.id });
            if (mode === 'constrained') {
                trial.socketBuffers = { clientReceive: await socketBuffer(receiver.ws._socket?._handle?.fd, 'receive'), serverSend: await rpc('constrain') };
            }
            receiver.ws.pause(); trial.receiverPaused = true;
            const bytesBefore = sender.inputBytes, messagesBefore = sender.inputMessages;
            for (let index = 0; index < SIGNALS; index++) sender.send({ type: 'signal', to: receiver.id, sdp: { type: 'offer', sdp: SDP } });
            trial.largeSignalMessagesSent = sender.inputMessages - messagesBefore; trial.largeSignalInputBytes = sender.inputBytes - bytesBefore;
            trial.totalSenderInputBytes = sender.inputBytes; trial.totalSenderInputMessages = sender.inputMessages;
            await until(async () => (await rpc('sample')).slow.signalAttempts === SIGNALS, 'signal-processing-timeout');
            // Independently authorized room must remain usable while the reader
            // is paused, even when the slow-room close frame is still queued.
            await exchange(normalA, normalB, 1); trial.normalPairWhilePaused = true;
            trial.resources.afterLoad = await rpc('sample');
            trial.observation = trial.resources.afterLoad.slow;
            trial.senderStayedOpen = sender.ws.readyState === WebSocket.OPEN && sender.closeCode === null;
            if (!trial.senderStayedOpen) throw fail('sender-closed-unexpectedly');
            if (permanent) {
                if (!trial.observation.closeInitiatedAboveThreshold || trial.observation.readyState !== WebSocket.CLOSING
                    || trial.resources.afterLoad.connections !== 4 || trial.resources.afterLoad.webSocketClients !== 4) throw fail('slow-permanent-close-not-started');
                trial.receiverResumedForCloseObservation = false;
                const waitStarted = performance.now(); let afterTimeout, nextProbe = waitStarted + 10000, healthyProbes = 0, samples = 0;
                await until(async () => {
                    const current = await rpc('sample'); samples++;
                    if (!receiver.ws.isPaused) throw fail('slow-permanent-reader-resumed');
                    if (current.slow.readyState === WebSocket.CLOSED && current.connections === 3 && current.webSocketClients === 3) {
                        afterTimeout = current; return true;
                    }
                    if (current.slow.readyState !== WebSocket.CLOSING || current.connections !== 4 || current.webSocketClients !== 4) throw fail('slow-permanent-resource-state');
                    if (performance.now() >= nextProbe) {
                        await exchange(normalA, normalB, ++healthyProbes + 1); nextProbe += 10000;
                    }
                    return false;
                }, 'slow-permanent-timeout', 35000, 100);
                const elapsed = afterTimeout.slow.realClosedAfterMs;
                if (!Number.isFinite(elapsed) || elapsed < 29000 || elapsed > 35000) throw fail('slow-permanent-timeout-range');
                trial.permanentClose = { realParentWaitMs: Math.round(performance.now() - waitStarted), realServerClosedAfterMs: elapsed,
                    serverStateBefore: trial.observation.readyState, serverStateAfter: afterTimeout.slow.readyState,
                    connectionsBefore: trial.resources.afterLoad.connections, connectionsAfter: afterTimeout.connections,
                    webSocketClientsBefore: trial.resources.afterLoad.webSocketClients, webSocketClientsAfter: afterTimeout.webSocketClients,
                    receiverResumedBeforeCleanup: false, closeCodeNotAsserted: true, retentionClockAdvancesDuringWait: 0,
                    sampleIntervalMs: 100, samples, healthyExchangesDuringWait: healthyProbes };
                trial.resources.afterPermanentTimeout = afterTimeout;
                await exchange(normalA, normalB, 100); trial.normalPairAfterTermination = true;
                trial.status = 'passed';
            } else {
                // Read the queued close frame only in this separate case. The
                // permanent trial above never resumes before final cleanup and
                // makes no claim about an unread frame's close code.
                receiver.ws.resume(); trial.receiverResumedForCloseObservation = true;
                if (trial.observation.closeInitiatedAboveThreshold) {
                    await until(() => receiver.closeCode !== null, 'slow-close-timeout');
                    trial.closeCode = receiver.closeCode; trial.closeReasonExpected = receiver.closeReasonExpected;
                    if (trial.closeCode !== 1008 || !trial.closeReasonExpected || trial.observation.bufferedBytesAtClose <= THRESHOLD) throw fail('slow-close-not-confirmed');
                    trial.status = 'passed'; regularPassed = true;
                } else {
                    if (trial.observation.readyState !== WebSocket.OPEN) throw fail('slow-unexpected-close');
                    trial.closeCode = receiver.closeCode; trial.status = 'threshold-not-reached';
                }
                await exchange(normalA, normalB, 2); trial.normalPairAfterResume = true;
            }
            trial.totalSenderInputBytes = sender.inputBytes; trial.totalSenderInputMessages = sender.inputMessages;
            trial.resources.afterCleanup = await closeAll();
            trial.cleanup = permanent
                ? 'slow transport reclaimed by production close timeout before reading resumes; all counts zero after final healthy-client close and explicit session-retention clock advance, not a real two-minute wait or GC/RSS reclamation claim'
                : 'transport counts zero after resume and controlled close; session retention clock advanced explicitly, not a real two-minute wait, permanent-nonreader timeout or GC/RSS reclamation claim';
        }
        const permanentPassed = !config.permanent || report.trials.some(trial => trial.permanent && trial.status === 'passed');
        report.status = regularPassed && permanentPassed ? 'passed' : 'inconclusive';
    } catch (error) {
        report.status = error.code?.startsWith('socket-buffer-') ? 'unsupported' : 'failed';
        const allowed = /^(worker-|socket-buffer-|receiver-|sender-|client-|signal-|connection-|resource-|slow-)/;
        report.failure = allowed.test(error.code || '') ? error.code : 'fixture-failed';
    } finally {
        for (const client of clients) { client.ws.resume(); client.ws.terminate(); }
        try { if (worker.connected) await rpc('close'); } catch {}
        if (worker.exitCode === null && worker.signalCode === null) {
            await new Promise(resolve => { const finish = () => { clearTimeout(timer); worker.off('exit', finish); resolve(); }; const timer = setTimeout(finish, 500); worker.once('exit', finish); });
            if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
        }
        clearTimeout(cutoff); if (timeout) { report.status = 'failed'; report.failure = 'hard-deadline-exceeded'; }
        report.wallTimeMs = Math.round(performance.now() - started);
    }
    return report;
}
async function main() {
    const { values } = parseArgs({ options: { mode: { type: 'string' }, permanent: { type: 'boolean', default: false }, out: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) { process.stdout.write('Usage: node tests/slow-reader.cjs [--mode auto|node-pause|constrained] [--permanent] [--out REPORT_PATH]\nFixed local-only, 45-second signaling fixture. Optional Python changes only test socket buffers. --permanent adds a fresh approximately 30-second production close-timeout case.\n'); return; }
    const report = await runSlowReader({ mode: values.mode, permanent: values.permanent });
    const text = JSON.stringify(report, null, 2) + '\n';
    if (values.out) { await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true }); await fs.writeFile(values.out, text); }
    process.stdout.write(text); if (report.status !== 'passed') process.exitCode = report.status === 'inconclusive' || report.status === 'unsupported' ? 2 : 1;
}
module.exports = { runSlowReader, normalizeSlowReaderOptions, readSlowReaderSource };
if (require.main === module) {
    if (process.argv[2] === '--server-worker' && typeof process.send === 'function') serverWorker().catch(() => { process.exitCode = 1; });
    else main().catch(error => { const code = /^invalid-/.test(error.code || '') ? error.code : 'fixture-cli-failed'; process.stdout.write(JSON.stringify({ schema: 1, status: 'failed', failure: code }) + '\n'); process.exitCode = 1; });
}
