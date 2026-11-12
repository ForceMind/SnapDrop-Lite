'use strict';
// Actual filesystem fixtures around the shipped verifier. VM injection only
// coordinates native read boundaries; no synthetic hash answers are supplied.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawnSync, execFileSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../scripts/field-verify.cjs');
const source = fs.readFileSync(cli, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(t, bytes = Buffer.alloc(8193, 0x41)) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zeydrop-field-races-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const a = path.join(dir, 'original.bin'), b = path.join(dir, 'download.bin');
    await Promise.all([fsp.writeFile(a, bytes), fsp.writeFile(b, bytes)]);
    return { dir, a, b, bytes };
}
function load({ beforeRead = async () => {}, afterRead = async () => {}, afterClose = async () => {}, readResult } = {}) {
    const opened = [], requests = [], seen = new Map();
    const boundary = async (file, kind) => {
        const count = (seen.get(file) || 0) + 1; seen.set(file, count);
        await beforeRead(file, { kind, count }); return count;
    };
    const customPromises = { ...fsp,
        async open(file, flags) {
            const handle = await fsp.open(file, flags), record = { file, flags, closed: false, handle };
            opened.push(record);
            return {
                stat: options => handle.stat(options),
                async read(...args) {
                    const count = await boundary(file, 'handle');
                    requests.push({ file, length: args[2], position: args[3] });
                    const result = readResult?.(file, args, count) || await handle.read(...args);
                    await afterRead(file, { count, bytesRead: result.bytesRead }); return result;
                },
                async close() { try { await handle.close(); } finally { record.closed = true; await afterClose(file); } }
            };
        },
        async readFile(file, ...args) { await boundary(file, 'readFile'); return fsp.readFile(file, ...args); }
    };
    const customFs = { ...fs,
        createReadStream(file, options) {
            return (async function* () {
                await boundary(file, 'stream'); let count = 0;
                for await (const chunk of fs.createReadStream(file, options)) {
                    yield chunk; await afterRead(file, { count: ++count, bytesRead: chunk.length });
                }
            })();
        }
    };
    const module = { exports: {} };
    const requireFixture = name => name === 'node:fs' ? customFs : name === 'node:fs/promises' ? customPromises : require(name);
    vm.runInNewContext(source, { require: requireFixture, module, Buffer, process, console }, { filename: cli });
    return { api: module.exports, opened, requests };
}
const changed = error => error?.code === 'fileChanged' && /发生变化/.test(error.message);

test('truncation between stat and actual reading cannot certify stale original byte counts', async t => {
    const h = await setup(t), seen = new Set();
    const reader = load({ beforeRead: async file => {
        if (seen.has(file)) return; seen.add(file); await fsp.writeFile(file, Buffer.from('abc'));
    } });
    await assert.rejects(reader.api.verifyFiles(h.a, h.b), changed);
    assert.equal((await fsp.stat(h.a)).size, 3); assert.equal((await fsp.stat(h.b)).size, 3);
    assert.equal(reader.opened.length, 2); assert.ok(reader.opened.every(item => item.closed));
});

test('same-size mutation during a native read invalidates evidence even if both files receive the same new bytes', async t => {
    const h = await setup(t, Buffer.alloc(2 * 1024 * 1024 + 7, 0x41)), changedFiles = new Set();
    const reader = load({ afterRead: async (file, { count }) => {
        if (count !== 1 || changedFiles.has(file)) return;
        changedFiles.add(file); await fsp.writeFile(file, Buffer.alloc(h.bytes.length, 0x42));
    } });
    await assert.rejects(reader.api.verifyFiles(h.a, h.b), changed);
    assert.equal(changedFiles.size, 2); assert.ok(reader.opened.every(item => item.closed));
});

test('replacing a path after opening cannot redirect an anchored read or become consistent evidence', async t => {
    const h = await setup(t), swapped = new Set();
    const reader = load({ beforeRead: async file => {
        if (swapped.has(file)) return; swapped.add(file);
        await fsp.rename(file, file + '.old'); await fsp.writeFile(file, Buffer.alloc(h.bytes.length, 0x42));
    } });
    await assert.rejects(reader.api.verifyFiles(h.a, h.b), changed);
    assert.equal(swapped.size, 2); assert.ok(reader.opened.every(item => item.closed));
});

if (process.platform !== 'win32') test('stable explicit symlinks work, but retargeting them during reading rejects the evidence', async t => {
    const h = await setup(t), a = path.join(h.dir, 'a-link'), b = path.join(h.dir, 'b-link');
    await fsp.symlink(h.a, a); await fsp.symlink(h.b, b);
    const stable = await load().api.verifyFiles(a, b); assert.equal(stable.equal, true); assert.equal(stable.senderBytes, h.bytes.length);
    const swapped = new Set();
    const reader = load({ beforeRead: async file => {
        if (swapped.has(file)) return; swapped.add(file);
        const target = file + '.new'; await fsp.writeFile(target, Buffer.alloc(h.bytes.length, 0x42));
        await fsp.unlink(file); await fsp.symlink(target, file);
    } });
    await assert.rejects(reader.api.verifyFiles(a, b), changed);
    assert.ok(reader.opened.every(item => item.closed));
});

test('a growing file is bounded to its original size plus an EOF probe and never accepted with an obsolete size', async t => {
    const h = await setup(t), seen = new Set();
    const reader = load({ beforeRead: async file => {
        if (seen.has(file)) return; seen.add(file); await fsp.appendFile(file, Buffer.alloc(2 * 1024 * 1024, 0x43));
    } });
    await assert.rejects(reader.api.verifyFiles(h.a, h.b), changed);
    for (const file of [h.a, h.b]) {
        const requests = reader.requests.filter(item => item.file === file);
        assert.ok(requests.length > 0); assert.ok(requests.every(item => item.length <= 1024 * 1024));
        assert.ok(requests.reduce((sum, item) => sum + item.length, 0) <= h.bytes.length + 1);
    }
    assert.ok(reader.opened.every(item => item.closed));
});

test('short reads and one read error release both descriptors before verification rejects', async t => {
    const h = await setup(t), reader = load({ readResult: (file, args) => file === h.a ? { bytesRead: 0, buffer: args[0] } : null });
    await assert.rejects(reader.api.verifyFiles(h.a, h.b), changed);
    assert.equal(reader.opened.length, 2); assert.ok(reader.opened.every(item => item.closed));
    const entered = gate(), release = gate();
    const failing = load({ beforeRead: async file => {
        if (file === h.a) throw Object.assign(Error('PRIVATE_NATIVE_READ_DETAIL'), { code: 'EIO' });
        entered.resolve(); await release.promise;
    } });
    const task = failing.api.verifyFiles(h.a, h.b); let settled = false;
    const result = task.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
        await entered.promise; await tick(); assert.equal(settled, false, 'the second descriptor must settle and close before rejection');
    } finally { release.resolve(); }
    assert.equal((await result).error.code, 'EIO'); assert.ok(failing.opened.every(item => item.closed));
});

test('unchanged zero-byte files and bounded multi-chunk reads keep exact verified sizes', async t => {
    const h = await setup(t, Buffer.alloc(0)), reader = load();
    let proof = await reader.api.verifyFiles(h.a, h.b);
    assert.equal(proof.equal, true); assert.equal(proof.senderBytes, 0); assert.equal(proof.receiverBytes, 0);
    await fsp.writeFile(h.a, Buffer.alloc(2 * 1024 * 1024 + 117, 7)); await fsp.copyFile(h.a, h.b);
    proof = await reader.api.verifyFiles(h.a, h.b); assert.equal(proof.equal, true); assert.equal(proof.senderBytes, 2 * 1024 * 1024 + 117);
    assert.ok(reader.requests.every(item => item.length <= 1024 * 1024)); assert.ok(reader.opened.every(item => item.closed));
});

test('a file changed after its hash finishes but while its counterpart is still reading cannot become evidence', async t => {
    const h = await setup(t, Buffer.alloc(0)), entered = gate(), release = gate(), closed = gate();
    const reader = load({
        beforeRead: async file => { if (file === h.b) { entered.resolve(); await release.promise; } },
        afterClose: async file => { if (file === h.a) closed.resolve(); }
    });
    const result = reader.api.verifyFiles(h.a, h.b).then(value => ({ value }), error => ({ error }));
    try {
        await Promise.all([entered.promise, closed.promise]);
        assert.equal(reader.opened.find(item => item.file === h.a)?.closed, true);
        await fsp.writeFile(h.a, Buffer.from('changed after hashing'));
    } finally { release.resolve(); }
    assert.ok(changed((await result).error)); assert.ok(reader.opened.every(item => item.closed));
});

if (process.platform === 'linux') test('FIFO inputs fail without waiting for a writer and all opened descriptors close', { timeout: 3000 }, async t => {
    const h = await setup(t), fifo = path.join(h.dir, 'input.fifo'); execFileSync('mkfifo', [fifo]);
    const reader = load(); await assert.rejects(reader.api.verifyFiles(fifo, h.b), /普通文件/);
    assert.equal(reader.opened.length, 2); assert.ok(reader.opened.every(item => item.closed));
    assert.ok(reader.opened.every(item => (item.flags & fs.constants.O_NONBLOCK) === fs.constants.O_NONBLOCK));
});

test('diagnostic growth after stat cannot bypass the 1 MiB read boundary', async t => {
    const h = await setup(t), input = path.join(h.dir, 'diagnostic.json'); await fsp.writeFile(input, '{"schema":1}');
    const seen = new Set(), reader = load({ beforeRead: async file => {
        if (seen.has(file)) return; seen.add(file); await fsp.appendFile(file, Buffer.alloc(2 * 1024 * 1024, 0x20));
    } });
    await assert.rejects(reader.api.readDiagnostic(input), changed);
    assert.ok(reader.requests.reduce((sum, item) => sum + item.length, 0) <= 13);
    assert.ok(reader.opened.every(item => item.closed));
});

const diagnostic = () => ({ schema: 1, product: 'Zeydrop', version: '0.3.0-dev.1', revision: '0123456789abcdef',
    events: [{ kind: 'connection', state: 'connected', ready: true, identityConfirmed: true,
        path: { direct: true, status: 'selected', protocol: 'udp', localType: 'host', remoteType: 'host' } }] });
test('CLI failure output never reveals missing private paths, invalid JSON snippets or an existing report path', async t => {
    const h = await setup(t), a = path.join(h.dir, 'sender.json'), b = path.join(h.dir, 'receiver.json');
    await fsp.writeFile(a, JSON.stringify(diagnostic())); await fsp.copyFile(a, b);
    const execute = extra => spawnSync(process.execPath, [cli, '--sender-diag', a, '--receiver-diag', b, '--scenario', 'same-wifi', ...extra], { encoding: 'utf8' });
    const marker = 'PRIVATE_PATH_SENTINEL';
    const missing = execute(['--sender-file', path.join(h.dir, marker), '--receiver-file', h.b]);
    assert.equal(missing.status, 1); assert.equal(missing.stdout, ''); assert.ok(!missing.stderr.includes(marker)); assert.ok(!missing.stderr.includes(h.dir));
    const snippet = 'PRIVSECRET_BEGIN'; await fsp.writeFile(a, snippet);
    const malformed = execute([]); assert.equal(malformed.status, 1); assert.equal(malformed.stdout, '');
    assert.ok(!malformed.stderr.includes(snippet)); assert.ok(!malformed.stderr.includes(h.dir)); assert.match(malformed.stderr, /诊断.*格式/);
    await fsp.writeFile(a, JSON.stringify(diagnostic())); const output = path.join(h.dir, marker + '.json'); await fsp.writeFile(output, 'KEEP');
    const exists = execute(['--out', output]); assert.equal(exists.status, 1); assert.equal(exists.stdout, '');
    assert.ok(!exists.stderr.includes(marker)); assert.ok(!exists.stderr.includes(h.dir)); assert.match(exists.stderr, /不会覆盖/);
    assert.equal(await fsp.readFile(output, 'utf8'), 'KEEP');
});
