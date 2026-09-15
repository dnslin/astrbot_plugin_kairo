import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { parseRequest } from '../src/protocol.js';

test('明确拒绝任意远程方法、路径和不支持的附件引用', () => {
  const request = { type: 'request', id: 'r1', action: 'send', params: { operation_id: 'o1', target_session_id: '1-23', kind: 'image', file_id: 'a'.repeat(32) } };
  assert.equal(parseRequest(request).action, 'send');
  assert.throws(() => parseRequest({ ...request, action: 'evaluate' }), /仅支持/);
  assert.throws(() => parseRequest({ ...request, params: { ...request.params, file_id: '../secret' } }), /file_id/);
  assert.throws(() => parseRequest({ ...request, params: { ...request.params, reply_to: '3' } }), /不支持引用/);
  assert.doesNotThrow(() => parseRequest({ ...request, params: { operation_id: 'o1', target_session_id: '1-23', kind: 'text', text: '', mentions: [{ uid: 'all', name: '所有人' }] } }));
});

test('配置限制 CDP 回环地址且不接受容易混淆的服务路径', () => {
  const raw = { serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '123' };
  assert.equal(parseConfig(raw, tmpdir()).dataDir, join(tmpdir(), 'data'));
  assert.throws(() => parseConfig({ ...raw, serverUrl: 'http://host/api' }, '/tmp'), /不含路径/);
  assert.throws(() => parseConfig({ ...raw, cdp: { url: 'http://remote:9222' } }, '/tmp'), /回环/);
  assert.throws(() => parseConfig({ ...raw, token: 'short' }, '/tmp'), /32/);
});
