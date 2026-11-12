'use strict';
// Read-only validation of an existing prepared runtime. It never repairs,
// deletes, changes permissions, imports release code, or contacts a network.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const CHUNK = 256 * 1024, MAX_FILE = 64 * 1024 * 1024;
const MAX_BYTES = 512 * 1024 * 1024, MAX_ENTRIES = 100000;
const MESSAGES = Object.freeze({
    arguments: 'Invalid prepared release validation arguments',
    unsafe: 'Prepared release contains an unsafe path, type, owner or mode',
    mismatch: 'Prepared release does not exactly match the freshly built runtime',
    changed: 'Prepared release validation input changed while being read',
    limit: 'Prepared release validation input exceeds the bounded limits'
});
function failure(code) { const error = Error(MESSAGES[code]); error.code = code; return error; }
const stampKeys = ['dev','ino','mode','uid','gid','size','nlink','mtimeNs','ctimeNs'];
const sameStamp = (a, b) => stampKeys.every(key => a[key] === b[key]);
const sameAncestor = (a, b) => b.isDirectory() && ['dev','ino','mode','uid','gid'].every(key => a[key] === b[key]);
async function checkedDirectory(directory, ancestors) {
    const absolute = path.resolve(directory);
    let current = path.parse(absolute).root;
    for (const name of ['', ...absolute.slice(current.length).split(path.sep).filter(Boolean)]) {
        if (name) current = path.join(current, name);
        const value = await fsp.lstat(current, { bigint: true });
        if (!value.isDirectory() || value.isSymbolicLink()) throw failure('unsafe');
        const old = ancestors.get(current);
        if (old && !sameAncestor(old, value)) throw failure('changed');
        ancestors.set(current, value);
    }
}
async function inventory(root, { destination = false, owner, ancestors, budget }) {
    await checkedDirectory(root, ancestors);
    const result = new Map();
    async function visit(name) {
        if (++budget.entries > MAX_ENTRIES || name.split(path.sep).length > 64) throw failure('limit');
        const filename = path.join(root, name), info = await fsp.lstat(filename, { bigint: true });
        if (!info.isDirectory() && !info.isFile() || info.isSymbolicLink()) throw failure('unsafe');
        if (info.isFile()) {
            if (info.size < 0n || info.size > BigInt(MAX_FILE) || info.nlink !== 1n) throw failure('unsafe');
            budget.bytes += Number(info.size); if (budget.bytes > MAX_BYTES) throw failure('limit');
        }
        if (destination && (info.uid !== BigInt(owner.uid) || info.gid !== BigInt(owner.gid))) throw failure('unsafe');
        result.set(name, { filename, info, kind: info.isDirectory() ? 'directory' : 'file' });
        if (info.isDirectory()) {
            // Enumerate incrementally: a single oversized directory must not
            // allocate every filename before the entry budget can reject it.
            for await (const entry of await fsp.opendir(filename)) await visit(path.join(name, entry.name));
        }
    }
    await visit(''); return result;
}
async function selectedFile(filename, ancestors) {
    await checkedDirectory(path.dirname(filename), ancestors);
    const info = await fsp.lstat(filename, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 0n || info.size > BigInt(MAX_FILE)) throw failure('unsafe');
    return { filename, info, kind: 'file' };
}
async function hashStable(entry, capture = false) {
    const handle = await fsp.open(entry.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || !sameStamp(before, entry.info)) throw failure('changed');
        const size = Number(before.size);
        if (capture && size > 16 * 1024) throw failure('limit');
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size))), hash = crypto.createHash('sha256');
        const chunks = []; let at = 0;
        while (at < size) {
            const length = Math.min(buffer.length, size - at), { bytesRead } = await handle.read(buffer, 0, length, at);
            if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) throw failure('changed');
            const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
            if (capture) chunks.push(Buffer.from(chunk)); at += bytesRead;
        }
        if ((await handle.read(buffer, 0, 1, size)).bytesRead !== 0) throw failure('changed');
        if (!sameStamp(before, await handle.stat({ bigint: true })) || !sameStamp(before, await fsp.lstat(entry.filename, { bigint: true }))) throw failure('changed');
        return { digest: hash.digest('hex'), bytes: at, body: capture ? Buffer.concat(chunks) : null };
    } finally { await handle.close(); }
}
async function verifyPreparedRelease({ sourceRoot, installationRoot, releaseRoot, revision }) {
    if (![sourceRoot, installationRoot, releaseRoot].every(value => typeof value === 'string' && value && !value.includes('\0'))
        || typeof revision !== 'string' || !/^[a-f0-9]{16}$/.test(revision)
        || typeof process.geteuid !== 'function') throw failure('arguments');
    sourceRoot = path.resolve(sourceRoot); installationRoot = path.resolve(installationRoot); releaseRoot = path.resolve(releaseRoot);
    if (releaseRoot !== path.join(installationRoot, 'releases', revision)) throw failure('arguments');
    const uid = process.geteuid(), owner = { uid, gid: uid === 0 ? 0 : process.getegid() };
    const ancestors = new Map();
    await checkedDirectory(sourceRoot, ancestors); await checkedDirectory(installationRoot, ancestors);
    for (const directory of [installationRoot, path.join(installationRoot, 'releases')]) {
        await checkedDirectory(directory, ancestors);
        const info = ancestors.get(directory);
        if (info.uid !== BigInt(owner.uid) || info.gid !== BigInt(owner.gid) || Number(info.mode & 0o7777n) !== 0o755) throw failure('unsafe');
    }
    const sourceBudget = { entries: 0, bytes: 0 };
    const expected = new Map([['', { kind: 'directory', filename: null, info: null }], ['server', { kind: 'directory', filename: null, info: null }]]);
    for (const name of ['dist', 'server/node_modules']) {
        const entries = await inventory(path.join(sourceRoot, name), { ancestors, budget: sourceBudget });
        for (const [relative, entry] of entries) expected.set(path.join(name, relative), entry);
    }
    for (const name of ['server/index.js','server/package.json','server/package-lock.json']) {
        const entry = await selectedFile(path.join(sourceRoot, name), ancestors);
        expected.set(name, entry); sourceBudget.bytes += Number(entry.info.size); sourceBudget.entries++;
    }
    for (const name of ['dist/build.json', 'dist/index.html']) {
        if (expected.get(name)?.kind !== 'file') throw failure('mismatch');
    }
    if (sourceBudget.bytes > MAX_BYTES || sourceBudget.entries > MAX_ENTRIES) throw failure('limit');
    const destination = await inventory(releaseRoot, { destination: true, owner, ancestors, budget: { entries: 0, bytes: 0 } });
    if (expected.size !== destination.size || [...expected.keys()].some(name => !destination.has(name))) throw failure('mismatch');
    let files = 0, bytes = 0;
    for (const [name, source] of expected) {
        const target = destination.get(name);
        if (target.kind !== source.kind) throw failure('mismatch');
        const mode = source.kind === 'directory' ? 0o755 : ((Number(source.info.mode) & ~process.umask() & 0o111) ? 0o755 : 0o644);
        if (Number(target.info.mode & 0o7777n) !== mode) throw failure('unsafe');
        if (source.kind !== 'file') continue;
        if (source.info.size !== target.info.size) throw failure('mismatch');
        const a = await hashStable(source, name === path.join('dist', 'build.json'));
        const b = await hashStable(target);
        if (a.digest !== b.digest || a.bytes !== b.bytes) throw failure('mismatch');
        if (a.body) {
            let metadata; try { metadata = JSON.parse(a.body.toString('utf8')); } catch { throw failure('mismatch'); }
            if (metadata?.revision !== revision) throw failure('mismatch');
        }
        files++; bytes += a.bytes;
    }
    // Rewalk both inventories after the last hash so a file which finished
    // earlier cannot change unnoticed while another file is still being read.
    const finalExpected = new Map();
    for (const name of ['dist', 'server/node_modules']) {
        for (const [relative, entry] of await inventory(path.join(sourceRoot, name), { ancestors, budget: { entries: 0, bytes: 0 } })) finalExpected.set(path.join(name, relative), entry);
    }
    for (const name of ['server/index.js','server/package.json','server/package-lock.json']) finalExpected.set(name, await selectedFile(path.join(sourceRoot, name), ancestors));
    const finalDestination = await inventory(releaseRoot, { destination: true, owner, ancestors, budget: { entries: 0, bytes: 0 } });
    if (finalExpected.size !== expected.size - 2 || finalDestination.size !== destination.size) throw failure('changed');
    for (const [name, original] of expected) {
        if (original.filename && (!finalExpected.has(name) || !sameStamp(original.info, finalExpected.get(name).info))) throw failure('changed');
    }
    for (const [name, original] of destination) {
        if (!finalDestination.has(name) || !sameStamp(original.info, finalDestination.get(name).info)) throw failure('changed');
    }
    for (const [directory, before] of ancestors) {
        if (!sameAncestor(before, await fsp.lstat(directory, { bigint: true }))) throw failure('changed');
    }
    return { files, bytes, revision, readOnly: true };
}
if (require.main === module) {
    const args = process.argv.slice(2), [releaseRoot, installationRoot, revision] = args;
    const operation = args.length !== 3 ? Promise.reject(failure('arguments')) : verifyPreparedRelease({ sourceRoot: process.cwd(), installationRoot, releaseRoot, revision });
    operation.then(() => console.log('Verified exact prepared release; existing contents were not rewritten.'))
        .catch(error => { console.error(MESSAGES[error?.code] || 'Prepared release validation failed; no existing release contents were changed.'); process.exitCode = 1; });
}
module.exports = { verifyPreparedRelease };
