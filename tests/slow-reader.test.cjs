'use strict';
// Keep the kernel/socket integration in its explicit CLI, not every Node test.
const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFile } = require('node:fs/promises'), { createHash } = require('node:crypto');
const { runSlowReader, normalizeSlowReaderOptions, readSlowReaderSource } = require('./slow-reader.cjs');
test('slow-reader source evidence contains only fixed-input SHA-256 digests', async () => {
    const source = await readSlowReaderSource();
    assert.deepEqual(Object.keys(source).sort(), ['serverSha256', 'toolSha256']);
    for (const value of Object.values(source)) assert.match(value, /^[a-f0-9]{64}$/);
    assert.equal(source.serverSha256, createHash('sha256').update(await readFile('server/index.js')).digest('hex'));
    assert.equal(source.toolSha256, createHash('sha256').update(await readFile('tests/slow-reader.cjs')).digest('hex'));
});
test('slow-reader rejects external targets and unbounded controls before creating a worker', async () => {
    for (const input of [{ target: 'wss://outside.invalid' }, { permanent: true, target: 'wss://outside.invalid' },
        { durationMs: 999999 }, { connections: 2000 }, { mode: 'unbounded' }]) {
        await assert.rejects(runSlowReader(input), error => ['invalid-options', 'invalid-mode'].includes(error.code));
    }
});
test('real close-timeout waiting is opt-in and requires a strict boolean', async () => {
    assert.deepEqual(normalizeSlowReaderOptions(), { mode: 'auto', permanent: false });
    assert.deepEqual(normalizeSlowReaderOptions({ mode: 'constrained', permanent: true }), { mode: 'constrained', permanent: true });
    for (const permanent of [null, 'true', 'false', 1, {}, []]) {
        await assert.rejects(runSlowReader({ permanent }), { code: 'invalid-permanent' });
    }
});
test('slow-reader CLI rejects and does not echo arbitrary external-target credentials', () => {
    const marker = 'PRIVATE_TOKEN_SLOW_READER_BOUNDARY';
    const result = spawnSync(process.execPath, ['tests/slow-reader.cjs', '--host', 'wss://outside.invalid/' + marker], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { schema: 1, status: 'failed', failure: 'fixture-cli-failed' });
    assert.ok(!result.stdout.includes(marker)); assert.ok(!result.stdout.includes('outside.invalid'));
});
