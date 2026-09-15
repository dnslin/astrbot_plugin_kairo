import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteSendOperationStore } from '../src/operation-store.js';

const claim = { operationId: 'operation-1', fingerprint: { targetSessionId: '0-123', messageType: 'text' as const, contentDigest: 'digest-1' } };

test('unknown 和 delivered 在进程重启后都不能再次声明发送', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-store-'));
  try {
    let store = new SqliteSendOperationStore(join(root, 'store.sqlite'));
    assert.equal((await store.claim(claim)).claimed, true);
    store.close();
    store = new SqliteSendOperationStore(join(root, 'store.sqlite'));
    assert.equal((await store.claim(claim)).claimed, false);
    assert.equal((await store.get(claim.operationId))?.status, 'unknown');
    await store.update(claim.operationId, { status: 'delivered', messageId: '777' });
    store.close();
    store = new SqliteSendOperationStore(join(root, 'store.sqlite'));
    assert.equal((await store.claim(claim)).operation.messageId, '777');
    await assert.rejects(store.claim({ ...claim, fingerprint: { ...claim.fingerprint, contentDigest: 'other' } }), /fingerprint/);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('仅确认发生在触发前的失败允许同一意图重试', async () => {
  const store = new SqliteSendOperationStore(':memory:');
  try {
    await store.claim(claim);
    await store.update(claim.operationId, { status: 'failed', isPreTrigger: false });
    assert.equal((await store.claim(claim)).claimed, false);
    await store.update(claim.operationId, { status: 'failed', isPreTrigger: true, error: 'not sent' });
    const retry = await store.claim(claim);
    assert.equal(retry.claimed, true);
    assert.equal(retry.operation.error, undefined);
    assert.equal(retry.operation.status, 'unknown');
  } finally { store.close(); }
});
