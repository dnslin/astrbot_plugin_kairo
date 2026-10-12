import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteSendOperationStore } from '../src/operation-store.js';

const claim = { operationId: 'operation-1', fingerprint: { targetSessionId: '123', messageType: 'text' as const, contentDigest: 'digest-1' } };

test('unknown 和 sent 在进程重启后都不能再次声明发送且完整回执持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-store-'));
  let store = new SqliteSendOperationStore(join(root, 'store.sqlite'));
  try {
    assert.equal((await store.claim(claim)).claimed, true);
    store.close();
    store = new SqliteSendOperationStore(join(root, 'store.sqlite'));
    assert.equal((await store.claim(claim)).claimed, false);
    assert.equal((await store.get(claim.operationId))?.status, 'unknown');
    const receipt = { draftId: 'd', sessionId: '123', code: 0, businessCode: 0, messageId: '777', msgIdx: 7 };
    await store.update(claim.operationId, { status: 'sent', messageId: '777', sessionId: '123', receipt, nativeCode: 0, verifyLatencyMs: 12 });
    store.close();
    store = new SqliteSendOperationStore(join(root, 'store.sqlite'));
    const replay = await store.claim(claim);
    assert.equal(replay.claimed, false);
    assert.equal(replay.operation.messageId, '777');
    assert.equal(replay.operation.sessionId, '123');
    assert.deepEqual(replay.operation.receipt, receipt);
    await assert.rejects(store.claim({ ...claim, fingerprint: { ...claim.fingerprint, contentDigest: 'other' } }), /fingerprint/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('前置失败也只返回原结果，迟到unknown不能覆盖sent或failed', async () => {
  const store = new SqliteSendOperationStore(':memory:');
  try {
    await store.claim(claim);
    const failed = await store.update(claim.operationId, { status: 'failed', isPreTrigger: true, error: 'not sent', nativeCode: 403 });
    const replay = await store.claim(claim);
    assert.equal(replay.claimed, false);
    assert.deepEqual(replay.operation, failed);
    assert.deepEqual(await store.update(claim.operationId, { status: 'unknown', error: 'late timeout' }), failed);
    const sent = await store.update(claim.operationId, { status: 'sent', messageId: '777', sessionId: '123' });
    assert.deepEqual(await store.update(claim.operationId, { status: 'unknown' }), sent);
  } finally { store.close(); }
});

test('工号参与指纹，跨连接更新读取实际终态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-store-concurrent-'));
  const path = join(root, 'store.sqlite');
  const first = new SqliteSendOperationStore(path), second = new SqliteSendOperationStore(path);
  const notification = { operationId: 'notify', fingerprint: { targetSessionId: '', targetLoginName: 'AbC', messageType: 'text-to-user' as const, contentDigest: 'same' } };
  try {
    await first.claim(notification);
    await assert.rejects(second.claim({ ...notification, fingerprint: { ...notification.fingerprint, targetLoginName: 'abc' } }), /fingerprint/);
    await second.update('notify', { status: 'sent', sessionId: '21', messageId: 'm' });
    assert.equal((await first.update('notify', { status: 'unknown' })).sessionId, '21');
    assert.equal((await first.claim(notification)).claimed, false);
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});
