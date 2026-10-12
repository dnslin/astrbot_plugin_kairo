import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { parseRequest, serializeResult } from '../src/protocol.js';

const request = { type: 'request', id: 'r1', action: 'send', params: { operation_id: 'o1', target_session_id: '23', kind: 'image', file_id: 'a'.repeat(32) } };

test('只接受原生正整数字符串会话与公开请求，不接受路径或非文本引用', () => {
  assert.equal(parseRequest(request).action, 'send');
  assert.throws(() => parseRequest({ ...request, action: 'evaluate' }), /仅支持/);
  for (const target of ['0', '01', '-2', '1-23', '0-2', ' 23', '23 ', '2.3', 23]) {
    assert.throws(() => parseRequest({ ...request, params: { ...request.params, target_session_id: target } }), /target_session_id/);
  }
  assert.throws(() => parseRequest({ ...request, params: { ...request.params, file_id: '../secret' } }), /file_id/);
  for (const kind of ['image', 'file', 'voice', 'app_card', 'url_card', 'biz_card']) {
    for (const extra of [{ reply_to: '3' }, { mentions: [] }]) {
      assert.throws(() => parseRequest({ ...request, params: { ...request.params, kind, ...extra } }), /不支持引用/);
    }
  }
  assert.doesNotThrow(() => parseRequest({ ...request, params: { operation_id: 'o1', target_session_id: '23', kind: 'text', text: '', mentions: [{ uid: 'all', name: '所有人' }] } }));
});

test('查询无须发送operation_id，工号trim但保留大小写', () => {
  assert.deepEqual(parseRequest({ type: 'request', id: 'q', action: 'get_sessions', params: {} }).params, {});
  assert.deepEqual(parseRequest({ type: 'request', id: 'q', action: 'get_user_profile', params: { user_id: '32' } }).params, { user_id: '32' });
  assert.deepEqual(parseRequest({ type: 'request', id: 'n', action: 'send_to_user', params: { operation_id: 'o', login_name: ' AbC ', text: 'hello' } }).params, { operation_id: 'o', login_name: 'AbC', text: 'hello' });
  assert.throws(() => parseRequest({ type: 'request', id: 'q', action: 'get_sessions', params: [] }), /请求格式/);
  assert.throws(() => parseRequest({ type: 'request', id: 'n', action: 'send_to_user', params: { operation_id: 'o', login_name: 'x', text: 'hello', mentions: [] } }), /不支持/);
});

test('三类原生卡片保留准确Driver字段且拒绝额外或错误字段', () => {
  const cards = [
    { kind: 'app_card', card: { title: '通知', content: '<p>内容</p>', linkUrl: '/app', pcAppCode: 'real-app' } },
    { kind: 'url_card', card: { title: '链接', summary: '摘要', linkUrl: 'https://example.com', picUrl: 'https://example.com/image.png' } },
    { kind: 'biz_card', card: { title: '业务', content: '内容', summary: ['摘要'], bizUrl: '/', bizType: 1 } },
  ];
  for (const item of cards) {
    const parsed = parseRequest({ ...request, params: { operation_id: 'o', target_session_id: '23', ...item } });
    assert.equal(parsed.action, 'send');
    if (parsed.action === 'send' && 'card' in parsed.params) assert.deepEqual(parsed.params.card, item.card);
    assert.throws(() => parseRequest({ ...request, params: { operation_id: 'o', target_session_id: '23', ...item, card: { ...item.card, type: 'kairo.app' } } }), /card/);
  }
  assert.throws(() => parseRequest({ ...request, params: { operation_id: 'o', target_session_id: '23', kind: 'biz_card', card: { title: 't', content: 'c', bizType: 3, bizUrl: '/' } } }), /bizType/);
});

test('结果保留原生回执与查询载荷，发送不返回success或recall', () => {
  const receipt = { draftId: 'd', sessionId: '23', code: 0, businessCode: 0, messageId: 'm', msgIdx: 5 };
  const result = serializeResult({ status: 'sent', operationId: 'o', messageId: 'm', sessionId: '23', nativeCode: 0, receipt, isPreTrigger: false, verifyLatencyMs: 7, recall: async () => true });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'sent', operationId: 'o', messageId: 'm', sessionId: '23', nativeCode: 0, receipt, isPreTrigger: false, verifyLatencyMs: 7 });
  assert.deepEqual(serializeResult({ sessions: [] }), { sessions: [] });
  assert.deepEqual(serializeResult({ profile: null }), { profile: null });
});

test('配置限制 CDP 回环地址且不接受容易混淆的服务路径', () => {
  const raw = { serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '123' };
  assert.equal(parseConfig(raw, tmpdir()).dataDir, join(tmpdir(), 'data'));
  assert.throws(() => parseConfig({ ...raw, serverUrl: 'http://host/api' }, '/tmp'), /不含路径/);
  assert.throws(() => parseConfig({ ...raw, cdp: { url: 'http://remote:9222' } }, '/tmp'), /回环/);
  assert.throws(() => parseConfig({ ...raw, token: 'short' }, '/tmp'), /32/);
});
