'use strict';
// Page-memory resume tests: never claim device/NAT availability from these fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto, randomBytes, createHash } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rig({ corruptPrefix = false } = {}) {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const events = [], diskHash = createHash('sha256');
    const wire = { open: true, threshold: 5 * 16384, delivered: 0, transmitted: 0, resumed: 0, corruptPrefix };
    let finished = 0, aborted = 0, prefixAltered = false;
    const context = {
        crypto: webcrypto, performance, TextEncoder, Blob, File, Uint8Array, setTimeout, clearTimeout,
        window: {
            ZeydropHash: sha256, ZEYDROP_CONFIG: {},
            showSaveFilePicker: async () => ({
                createWritable: async () => ({
                    write: async bytes => {
                        diskHash.update(new Uint8Array(bytes)); wire.delivered += bytes.byteLength;
                        if (wire.delivered >= wire.threshold && !wire.resumed) {
                            wire.open = false;
                            await delay(8); // Disconnect while a native sink.write is unresolved.
                        }
                    },
                    close: async () => { finished++; },
                    abort: async () => { aborted++; }
                })
            })
        },
        Events: { fire: (type, detail) => events.push({ type, detail }) }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.T = TransferPeer;', context);
    function peer(id) {
        const p = new context.T({}, id);
        p._verified = true; p._remoteHello = true; p._path = { direct: true };
        p._isConnected = () => true; p._connectionEvent = () => {};
        p._waitForDrain = async () => {}; p.close = () => {};
        return p;
    }
    let a = peer('receiver'), b = peer('sender');
    function attach(sender, receiver) {
        sender._send = data => {
            if (!wire.open) return;
            if (typeof data !== 'string') wire.transmitted += data.byteLength;
            queueMicrotask(() => { if (wire.open) receiver._receive(data); });
        };
        receiver._send = data => {
            if (!wire.open) return;
            if (typeof data === 'string' && corruptPrefix && !prefixAltered) {
                const msg = JSON.parse(data);
                if (msg.type === 'resume-at') {
                    msg.sha256 = '0'.repeat(64); data = JSON.stringify(msg); prefixAltered = true;
                }
            }
            queueMicrotask(() => { if (wire.open) sender._receive(data); });
        };
    }
    attach(a, b);
    const until = async fn => {
        for (let i = 0; i < 5000; i++) { if (fn()) return; await delay(2); }
        throw Error('resume test timed out: ' + JSON.stringify(events.slice(-4)));
    };
    const content = randomBytes(2 * 1024 * 1024 + 37);
    a.sendFiles([new File([content], 'checkpoint.bin', { type: 'application/octet-stream' })]);
    await until(() => !!b._incoming);
    const id = b._incoming.meta.id;
    await b.acceptIncoming(id);
    await until(() => !wire.open);
    assert.ok(wire.delivered > 0 && wire.delivered < content.length);
    assert.ok(a.suspendTransfers('simulated drop')); assert.ok(b.suspendTransfers('simulated drop'));
    await b._held.ready;
    const prefix = b._held.incoming.offset;
    assert.ok(prefix >= wire.threshold && prefix < content.length);
    const holdA = a.takeHeldTransfers(), holdB = b.takeHeldTransfers();
    // Replacement peer objects simulate a new RTCDataChannel/WS-authorized peer.
    const replacementA = peer('receiver'), replacementB = peer('sender');
    replacementA._verified = replacementB._verified = false;
    attach(replacementA, replacementB);
    assert.equal(replacementA.adoptHeldTransfers(holdA), true);
    assert.equal(replacementB.adoptHeldTransfers(holdB), true);
    // Receiver confirms the same new security code first; sender follows later.
    wire.resumed = 1; wire.open = true;
    replacementB._verified = true; replacementB.restoreTransfers();
    replacementA._verified = true; replacementA.restoreTransfers();
    return {
        a: replacementA, b: replacementB, events, wire, prefix, id, content, until,
        finished: () => finished, aborted: () => aborted, diskHash
    };
}

test('interrupted 2 MiB file resumes from independently hashed on-disk prefix, not byte zero', async () => {
    const h = await rig();
    await h.until(() => h.events.some(e => e.type === 'file-received'));
    await h.until(() => !h.a._outgoing);
    assert.equal(h.finished(), 1); assert.equal(h.aborted(), 0);
    const expected = createHash('sha256').update(h.content).digest('hex');
    assert.equal(h.events.find(e => e.type === 'file-received').detail.sha256, expected);
    assert.equal(h.diskHash.digest('hex'), expected);
    assert.equal(h.wire.delivered, h.content.length);
    assert.ok(h.prefix > 0);
    assert.ok(h.wire.transmitted < h.content.length + 262144, 'only a bounded in-flight window was retransmitted');
});

test('mismatched checkpoint SHA aborts the sink and never reports file completion', async () => {
    const h = await rig({ corruptPrefix: true });
    await h.until(() => h.aborted() > 0);
    assert.equal(h.finished(), 0);
    assert.ok(!h.events.some(e => e.type === 'file-received'));
    assert.equal(h.a._outgoing, null);
    assert.ok(h.events.some(e => e.type === 'transfer-state' && e.detail.phase === 'cancelled'));
});

test('a forged resume offer cannot create a receiver file or bypass user consent', async () => {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const sent = [];
    const context = { window: { ZeydropHash: sha256 }, Events: { fire() {} }, setTimeout, clearTimeout, TextEncoder, performance };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.T = TransferPeer;', context);
    const b = new context.T({}, 'sender');
    b._remoteHello = true; b._verified = true; b._path = { direct: true };
    b._send = data => sent.push(JSON.parse(data)); b._isConnected = () => true;
    const id = 'a'.repeat(32);
    await b._onMessage(JSON.stringify({ type:'resume-offer', id, name:'anything', size:1, mime:'application/octet-stream' }));
    assert.equal(b._incoming, null);
    assert.deepEqual(sent.map(msg => msg.type), ['reject']);
    await assert.rejects(b._onMessage(JSON.stringify({ type:'resume-confirm', id, offset:0, sha256:'0'.repeat(64) })), /前缀/);
});
