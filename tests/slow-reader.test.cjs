'use strict';
// Keep the kernel/socket integration in its explicit CLI, not every Node test.
const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { runSlowReader } = require('./slow-reader.cjs');
test('slow-reader rejects external targets and unbounded controls before creating a worker', async () => {
    for (const input of [{ target: 'wss://outside.invalid' }, { durationMs: 999999 }, { connections: 2000 }, { mode: 'unbounded' }]) {
        await assert.rejects(runSlowReader(input), error => ['invalid-options', 'invalid-mode'].includes(error.code));
    }
});
test('slow-reader CLI rejects and does not echo arbitrary external-target credentials', () => {
    const marker = 'PRIVATE_TOKEN_SLOW_READER_BOUNDARY';
    const result = spawnSync(process.execPath, ['tests/slow-reader.cjs', '--host', 'wss://outside.invalid/' + marker], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { schema: 1, status: 'failed', failure: 'fixture-cli-failed' });
    assert.ok(!result.stdout.includes(marker)); assert.ok(!result.stdout.includes('outside.invalid'));
});
