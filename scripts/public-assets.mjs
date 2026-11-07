import { constants } from 'node:fs';
import { lstat, open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// This is a publication boundary, not a recursive directory convention.
// Adding a public asset requires an explicit source-review change here.
export const PUBLIC_CLIENT_FILES = Object.freeze([
    'client/config.js',
    'client/images/android-chrome-192x192-maskable.png',
    'client/images/android-chrome-192x192.png',
    'client/images/android-chrome-512x512-maskable.png',
    'client/images/android-chrome-512x512.png',
    'client/images/apple-touch-icon.png',
    'client/images/favicon-96x96.png',
    'client/images/mstile-150x150.png',
    'client/images/zeydrop-mark.svg',
    'client/index.html',
    'client/manifest.json',
    'client/scripts/diagnostics.js',
    'client/scripts/network.js',
    'client/scripts/recovery-worker.js',
    'client/scripts/recovery.js',
    'client/scripts/send-queue-store.js',
    'client/scripts/transfer.js',
    'client/scripts/ui.js',
    'client/scripts/vendor.js',
    'client/service-worker.js',
    'client/styles.css'
]);
const approved = new Set(PUBLIC_CLIENT_FILES);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

// Validate each component inside the project (including the project/client
// parent directories), then bind the bytes to the opened regular file. Git
// metadata is deliberately unnecessary for extracted source candidates.
export async function readApprovedSourceFile(root, relative) {
    root = path.resolve(root);
    const parts = relative.split('/');
    if (path.isAbsolute(relative) || relative.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) throw Error('Invalid approved input path');
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw Error('Invalid source root');
    const chain = [{ filename: root, before: rootInfo, directory: true }];
    let filename = root;
    for (let index = 0; index < parts.length; index++) {
        filename = path.join(filename, parts[index]);
        const before = await lstat(filename), directory = index < parts.length - 1;
        if (before.isSymbolicLink()) throw Error('Symbolic link rejected in approved input: ' + relative);
        if (directory ? !before.isDirectory() : !before.isFile()) throw Error('Non-regular approved input: ' + relative);
        chain.push({ filename, before, directory });
    }
    const expected = chain.at(-1).before;
    if (expected.size > MAX_INPUT_BYTES) throw Error('Approved input exceeds size limit: ' + relative);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) throw Error('Approved input changed before reading: ' + relative);
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs || bytes.length !== expected.size) throw Error('Approved input changed while reading: ' + relative);
        for (const item of chain) {
            const current = await lstat(item.filename);
            if (current.isSymbolicLink() || current.dev !== item.before.dev || current.ino !== item.before.ino || (item.directory ? !current.isDirectory() : !current.isFile())) throw Error('Approved input path changed while reading: ' + relative);
        }
        return bytes;
    } finally { await handle.close(); }
}
export async function snapshotPublicClient(root) {
    const snapshot = new Map(); let total = 0;
    for (const filename of PUBLIC_CLIENT_FILES) {
        const bytes = await readApprovedSourceFile(root, filename);
        total += bytes.length;
        if (total > 64 * 1024 * 1024) throw Error('Public asset snapshot exceeds total size limit');
        snapshot.set(filename, bytes);
    }
    return snapshot;
}
export async function writePublicClient(snapshot, destination) {
    if (snapshot.size !== approved.size || [...snapshot.keys()].some(filename => !approved.has(filename))) throw Error('Unexpected public snapshot entry');
    for (const [filename, bytes] of snapshot) {
        const target = path.join(destination, filename.slice('client/'.length));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
    }
}
