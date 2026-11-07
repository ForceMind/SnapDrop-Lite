'use strict';
// Bounded loopback health probe: authenticated protocol hello, no invitation,
// file metadata, file data, or returned credentials are printed or persisted.
const path = require('node:path');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const { parseArgs } = require('node:util');
async function probeSignaling({ url = 'ws://127.0.0.1:3001/server/webrtc', origin, serverRoot = path.resolve(__dirname, '../server'), timeoutMs = 10000, attemptTimeoutMs = 1000, retryDelayMs = 100 } = {}) {
    const target = new URL(url), source = new URL(origin);
    if (target.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/server/webrtc' || target.search || target.hash || target.username || target.password) throw Error('Health probe requires loopback signaling URL');
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) throw Error('Health probe requires an exact Origin');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Invalid health probe deadline');
    const { WebSocket } = createRequire(path.join(serverRoot, 'package.json'))('ws');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const remaining = Math.min(attemptTimeoutMs, deadline - Date.now());
        const success = await new Promise(resolve => {
            const socket = new WebSocket(target, { origin, handshakeTimeout: remaining }); let settled = false;
            const done = result => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); resolve(result); };
            const timer = setTimeout(() => done(false), remaining);
            socket.on('error', () => done(false)); socket.on('close', () => done(false));
            socket.on('open', () => socket.send(JSON.stringify({ type: 'hello' })));
            socket.on('message', data => {
                let message; try { message = JSON.parse(data.toString()); } catch { return done(false); }
                if (message.type === 'hello') done(typeof message.peerId === 'string' && /^[a-f0-9-]{36}$/.test(message.peerId) && typeof message.resumeToken === 'string' && /^[a-f0-9]{64}$/.test(message.resumeToken));
            });
        });
        if (success) return true;
        const delay = Math.min(retryDelayMs, deadline - Date.now());
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw Error('Authorized signaling hello did not become ready before deadline');
}
async function main() {
    const { values } = parseArgs({ options: { url: { type:'string' }, origin: { type:'string' }, env: { type:'string' }, 'server-root': { type:'string' }, timeout: { type:'string' } } });
    let origin = values.origin, url = values.url;
    if (values.env) {
        const variables = Object.fromEntries((await fs.readFile(values.env,'utf8')).split(/\r?\n/).filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1).trim()];}));
        origin ||= variables.ALLOWED_ORIGINS?.split(',')[0].trim();
        const port = Number(variables.PORT || 3001);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || (variables.WS_HOST && variables.WS_HOST !== '127.0.0.1')) throw Error('Health probe requires loopback service configuration');
        url ||= 'ws://127.0.0.1:' + port + '/server/webrtc';
    }
    await probeSignaling({ url, origin, serverRoot: values['server-root'], timeoutMs: values.timeout ? Number(values.timeout) : 10000 });
    console.log('PASS local authorized signaling hello');
}
module.exports = { probeSignaling };
if (require.main === module) main().catch(error=>{ console.error(error.message);process.exitCode=1; });
