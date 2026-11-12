'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const id = 'a'.repeat(32);
function peer() {
  const context = { window: { ZeydropHash: {} }, Events: { fire() {} }, setTimeout, clearTimeout, performance, TextEncoder, Uint8Array };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('client/scripts/transfer.js', 'utf8') + '\nthis.Transfer = TransferPeer;', context);
  const p = new context.Transfer({}, 'paired-peer');
  p._verified = true; p._remoteHello = true; p._path = { direct: true };
  p._isConnected = () => true;
  p._send = () => {};
  return p;
}
function sender() {
  const p = peer();
  const state = { meta: { id, size: 64 }, phase: 'resuming', offset: 32, acked: 32,
    file: { slice() { throw Error('invalid offset must not access a file'); } } };
  p._outgoing = state;
  return { p, state };
}
test('invalid resume offsets cannot read file or advance state', async () => {
  for (const offset of [-1, 2.5, 65, Number.MAX_SAFE_INTEGER + 1]) {
    const { p, state } = sender();
    await assert.rejects(p._resumeFromOffset({ id, offset, sha256: '0'.repeat(64) }), /无效的续传确认/);
    assert.equal(state.offset, 32); assert.equal(state.phase, 'resuming');
  }
});
test('resume-at rejects wrong file identity and malformed prefix digest', async () => {
  for (const message of [
    { id: 'b'.repeat(32), offset: 0, sha256: '0'.repeat(64) },
    { id, offset: 0, sha256: 'not-a-hash' }
  ]) {
    const { p, state } = sender();
    await assert.rejects(p._resumeFromOffset(message), /无效的续传确认/);
    assert.equal(state.offset, 32);
  }
});
test('resume-at requires fresh direct-path and identity authorization', async () => {
  for (const key of ['identity', 'path']) {
    const { p, state } = sender();
    if (key === 'identity') p._verified = false; else p._path = { direct: false };
    await assert.rejects(p._resumeFromOffset({ id, offset: 0, sha256: '0'.repeat(64) }), /无效的续传确认/);
    assert.equal(state.phase, 'resuming');
  }
});
test('unsolicited resume-confirm cannot create a receiver or complete a file', async () => {
  const p = peer();
  await assert.rejects(p._onMessage(JSON.stringify({ type: 'resume-confirm', id, offset: 0, sha256: '0'.repeat(64) })), /前缀校验失败/);
  assert.equal(p._incoming, null);
});
