'use strict';
// Actual Chromium OPFS worker durability; localhost is a secure context.
// This tests browser disk persistence, not real-world cross-network WebRTC.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../client/scripts');
async function main() {
    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end('<script src="/scripts/recovery.js"></script>');
        }
        const name = req.url === '/scripts/recovery.js' ? 'recovery.js'
            : req.url === '/scripts/recovery-worker.js' ? 'recovery-worker.js' : null;
        if (!name) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        fs.createReadStream(path.join(root, name)).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        assert.equal(await page.evaluate(() => window.ZeydropRecovery.available()), true);
        const id = crypto.randomUUID();
        const prefix = Buffer.alloc(16384, 7);
        const tail = Buffer.alloc(8192, 9);
        const uncommitted = Buffer.alloc(4096, 5);
        const meta = { id, name: 'recoverable.bin', size: prefix.length + tail.length, mime: 'application/octet-stream' };
        const digest = content => crypto.createHash('sha256').update(content).digest('hex');
        const prefixSha = digest(prefix), fullSha = digest(Buffer.concat([prefix, tail]));
        await page.evaluate(async ({ meta, prefix, sha, uncommitted }) => {
            const sink = await window.ZeydropRecovery.open(meta);
            await sink.write(Uint8Array.from(prefix));
            await sink.checkpoint(sha, true);
            // Deliberate crash window: the file has extra bytes but no published checkpoint.
            await sink.write(Uint8Array.from(uncommitted));
            window.__unclosedSink = sink;
        }, { meta, prefix: [...prefix], sha: prefixSha, uncommitted: [...uncommitted] });
        await page.reload(); // kills the writer while leaving the committed prefix.
        const listing = await page.evaluate(() => window.ZeydropRecovery.list());
        assert.equal(listing.length, 1);
        assert.equal(listing[0].id, id);
        assert.equal(listing[0].offset, prefix.length);
        await assert.rejects(page.evaluate(async ({ id, meta }) =>
            window.ZeydropRecovery.restore(id, { ...meta, name: 'different.bin' }), { id, meta }), /匹配/);
        const restored = await page.evaluate(async ({ id, meta, tail, prefixSha, fullSha }) => {
            const store = window.ZeydropRecovery;
            // A terminated worker can briefly own a stale handle after navigation.
            let result;
            for (let i = 0; i < 30; i++) {
                try { result = await store.restore(id, meta); break; }
                catch (e) {
                    if (i === 29) throw e;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
                .map(byte => byte.toString(16).padStart(2, '0')).join('');
            const found = await hash(await result.snapshot.arrayBuffer());
            if (result.offset !== 16384 || result.snapshot.size !== result.offset || found !== prefixSha)
                throw Error('Failed to roll back uncommitted bytes or verify prefix');
            await result.sink.write(Uint8Array.from(tail));
            await result.sink.checkpoint(fullSha, true);
            const completed = await result.sink.finish(fullSha);
            return { offset: result.offset, size: completed.blob.size, locallyStored: completed.locallyStored };
        }, { id, meta, tail: [...tail], prefixSha, fullSha });
        assert.deepEqual(restored, { offset: prefix.length, size: meta.size, locallyStored: true });
        await page.reload();
        const complete = await page.evaluate(async id => {
            const store = window.ZeydropRecovery;
            const { meta, blob } = await store.completed(id);
            const sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
                .map(byte => byte.toString(16).padStart(2, '0')).join('');
            await store.erase(id);
            return { phase: meta.phase, hash: sum, count: (await store.list()).length };
        }, id);
        assert.deepEqual(complete, { phase: 'complete', hash: fullSha, count: 0 });
        // True cross-tab contention: never steal a partial held by another
        // OPFS worker. The first tab must remain able to release it normally.
        const lockId = crypto.randomUUID();
        const lockMeta = { id: lockId, name: 'locked.bin', size: 2048, mime: 'application/octet-stream' };
        const lockSha = digest(Buffer.alloc(1024, 4));
        await page.evaluate(async ({ meta, sha }) => {
            const sink = await window.ZeydropRecovery.open(meta);
            await sink.write(new Uint8Array(1024).fill(4));
            await sink.checkpoint(sha, true);
            window.__testLockedSink = sink;
        }, { meta: lockMeta, sha: lockSha });
        const other = await context.newPage();
        await other.goto(url);
        const lockError = await other.evaluate(async ({ id, meta }) => {
            try { await window.ZeydropRecovery.restore(id, meta); return 'no error'; }
            catch (e) { return String(e.message); }
        }, { id: lockId, meta: lockMeta });
        assert.match(lockError, /另一标签页/);
        await page.evaluate(sha => window.__testLockedSink.park(sha), lockSha);
        const released = await other.evaluate(async ({ id, meta, sha }) => {
            const { sink, snapshot, offset } = await window.ZeydropRecovery.restore(id, meta);
            const sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await snapshot.arrayBuffer())))
                .map(byte => byte.toString(16).padStart(2, '0')).join('');
            await sink.park(sha); await window.ZeydropRecovery.erase(id);
            return { offset, sum };
        }, { id: lockId, meta: lockMeta, sha: lockSha });
        assert.deepEqual(released, { offset: 1024, sum: lockSha });
        await other.close();

        // Corrupted indexes must stay visible and deletable even if the item
        // count is above the normal creation limit; silently slicing prevents cleanup.
        const corruptIds = await page.evaluate(async () => {
            const dir = await (await navigator.storage.getDirectory())
                .getDirectoryHandle('zeydrop-recovery-v1', { create: true });
            const ids = [];
            for (let i = 0; i < 21; i++) {
                const id = crypto.randomUUID(), file = await dir.getFileHandle(id + '.json', { create: true });
                const writer = await file.createWritable();
                await writer.write('{truncated metadata');
                await writer.close();
                ids.push(id);
            }
            return ids;
        });
        const found = await page.evaluate(() => window.ZeydropRecovery.list());
        assert.equal(found.length, 21, 'do not hide corrupted overflow records');
        assert.ok(found.every(record => record.phase === 'invalid'));
        await assert.rejects(page.evaluate(async id => {
            await window.ZeydropRecovery.open({
                id, name: 'one-too-many.bin', size: 512, mime: 'application/octet-stream'
            });
        }, crypto.randomUUID()), /最多保留 20 个断点/);
        await page.evaluate(async ids => {
            for (const id of ids) await window.ZeydropRecovery.erase(id);
        }, corruptIds);
        assert.equal((await page.evaluate(() => window.ZeydropRecovery.list())).length, 0);

        // Propagate actionable quota/permission errors through the worker bridge.
        const typed = await page.evaluate(async () => {
            const store = window.ZeydropRecovery, realWorker = store.worker;
            const names = [];
            try {
                for (const errorName of ['QuotaExceededError', 'NotAllowedError']) {
                    const fake = {
                        onmessage: realWorker.onmessage,
                        postMessage({ request }) {
                            queueMicrotask(() => fake.onmessage({
                                data: { request, ok: false, errorName, error: 'simulated storage failure' }
                            }));
                        }
                    };
                    store.worker = fake;
                    try { await store.request('probe'); names.push('no error'); }
                    catch (error) { names.push(error.name); }
                }
            } finally { store.worker = realWorker; }
            return names;
        });
        assert.deepEqual(typed, ['QuotaExceededError', 'NotAllowedError']);
        console.log('PASS real Chromium OPFS: exclusive second-tab lock, corrupted 21-record cleanup, typed failures');
        assert.deepEqual(errors, []);
        console.log('PASS actual Chromium OPFS: checkpoint, abrupt reload, rollback, prefix verify, finish, cleanup');
        await context.close();
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
