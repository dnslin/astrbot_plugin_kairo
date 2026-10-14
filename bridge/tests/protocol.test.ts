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

test('文本语音只接受非空文字及明确发送意图，长度按 UTF-16 限制', () => {
  const params = { operation_id: 'voice-text', target_session_id: '23', kind: 'voice_text', text: '  请读出这段文字\n保留换行  ' };
  assert.deepEqual(parseRequest({ ...request, params }).params, params);
  assert.doesNotThrow(() => parseRequest({ ...request, params: { ...params, text: '😀'.repeat(64_000) } }));
  for (const invalid of ['', '  ', '\r\n', undefined, null, 123, true, {}, [], '😀'.repeat(64_001), 'a'.repeat(128_001)]) {
    assert.throws(() => parseRequest({ ...request, params: { ...params, text: invalid } }), /text/);
  }
});

test('文本语音拒绝文件、音色、引用、提及及所有额外字段', () => {
  const params = { operation_id: 'voice-text', target_session_id: '23', kind: 'voice_text', text: '读出正文' };
  for (const extra of [
    { file_id: 'a'.repeat(32) }, { filePath: '/tmp/audio.wav' }, { voice: 'zh-CN-XiaoxiaoNeural' },
    { reply_to: '101' }, { quote: '101' }, { mentions: [] }, { name: 'audio.wav' }, { card: {} }, { extra: true },
  ]) {
    assert.throws(() => parseRequest({ ...request, params: { ...params, ...extra } }), /不支持/);
  }
});

test('查询无须发送operation_id，工号trim但保留大小写', () => {
  assert.deepEqual(parseRequest({ type: 'request', id: 'q', action: 'get_sessions', params: {} }).params, {});
  assert.deepEqual(parseRequest({ type: 'request', id: 'q', action: 'get_user_profile', params: { user_id: '32' } }).params, { user_id: '32' });
  assert.deepEqual(parseRequest({ type: 'request', id: 'n', action: 'send_to_user', params: { operation_id: 'o', login_name: ' AbC ', text: 'hello' } }).params, { operation_id: 'o', login_name: 'AbC', text: 'hello' });
  assert.throws(() => parseRequest({ type: 'request', id: 'q', action: 'get_sessions', params: [] }), /请求格式/);
  assert.throws(() => parseRequest({ type: 'request', id: 'n', action: 'send_to_user', params: { operation_id: 'o', login_name: 'x', text: 'hello', mentions: [] } }), /不支持/);
});

test('员工搜索只接受非空 keyword，不接受分页、身份或发送参数', () => {
  const search = { type: 'request', id: 'search', action: 'search_employees', params: { keyword: '  张三  ' } };
  assert.deepEqual(parseRequest(search), search);
  for (const keyword of [undefined, null, '', '  ', '\r\n', 123, true, {}, [], 'a'.repeat(257)]) {
    assert.throws(() => parseRequest({ ...search, params: { keyword } }), { code: 'INVALID_REQUEST' });
  }
  for (const extra of [
    { operation_id: 'send-intent' }, { page: 1 }, { pageSize: 10 }, { limit: 10 },
    { user_id: '2' }, { login_name: 'AbC' }, { target_session_id: '8' }, { text: '通知' }, { timeoutMs: 0 },
  ]) {
    assert.throws(() => parseRequest({ ...search, params: { ...search.params, ...extra } }), { code: 'INVALID_REQUEST' });
  }
  for (const params of [null, [], '张三']) assert.throws(() => parseRequest({ ...search, params }), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseRequest({ ...search, action: 'search_employee' }), { code: 'UNSUPPORTED_ACTION' });
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

test('按工号发送三类卡片保留原生载荷，工号 trim 并保留大小写与前导零', () => {
  const cards = [
    { kind: 'app_card', card: { title: '通知', content: '<p>内容</p>', linkUrl: '/app', pcAppCode: 'real-app' } },
    { kind: 'url_card', card: { title: '链接', summary: '摘要', linkUrl: 'https://example.com', picUrl: 'https://example.com/image.png' } },
    { kind: 'biz_card', card: { title: '业务', content: '内容', summary: ['摘要'], bizUrl: '/', bizType: 2 } },
  ];
  for (const item of cards) {
    const directed = { type: 'request', id: 'card-user', action: 'send_card_to_user', params: { operation_id: 'card-intent', login_name: ' 00AbC ', ...item } };
    assert.deepEqual(parseRequest(directed), { ...directed, params: { ...directed.params, login_name: '00AbC' } });
    for (const extra of [
      { target_session_id: '23' }, { targetSessionId: '23' }, { targetLoginName: 'other' },
      { text: '不能先发文本' }, { reply_to: '101' }, { quote: '101' }, { mentions: [] }, { extra: true },
    ]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, ...extra } }), /不支持/);
    }
    for (const login_name of [undefined, null, '', '  ', 123, 'a'.repeat(257)]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, login_name } }), /login_name/);
    }
    for (const card of [undefined, null, [], 'card', { ...item.card, unsupported: true }, { ...item.card, title: '' }, { ...item.card, title: 'a'.repeat(128_001) }]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, card } }), /card/);
    }
    assert.doesNotThrow(() => parseRequest({ ...directed, params: { ...directed.params, card: { ...item.card, title: '😀'.repeat(64_000) } } }));
  }
});

test('按工号卡片拒绝非卡片类型和错误原生卡片字段', () => {
  const directed = { type: 'request', id: 'card-user', action: 'send_card_to_user', params: { operation_id: 'card-intent', login_name: '00AbC', kind: 'biz_card', card: { title: '业务', content: '正文', bizUrl: '/', bizType: 1 } } };
  for (const kind of [undefined, null, 'text', 'voice_text', 'image', 'file', 'voice', 'chat_record', 'other']) {
    assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, kind } }), { code: 'UNSUPPORTED_MESSAGE' });
  }
  for (const card of [
    { title: '业务', content: '正文', bizUrl: '/', bizType: 3 },
    { title: '业务', content: '正文', bizUrl: 'https://example.com', bizType: 1 },
    { title: '业务', content: '正文', bizUrl: '//example.com', bizType: 1 },
    { title: '业务', content: '正文', bizUrl: '/', bizType: 1, summary: '摘要' },
    { title: '业务', content: '正文', bizUrl: '/', bizType: 1, summary: [1] },
  ]) {
    assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, card } }), /card/);
  }
  assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, kind: 'app_card', card: { title: '通知', content: '正文', linkUrl: 123 } } }), /card.linkUrl/);
  assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, kind: 'url_card', card: { title: '链接', summary: '摘要' } } }), /card.linkUrl/);
});

test('按工号图片文件保留 file_id 与文件名，工号 trim 并保留大小写及前导零', () => {
  for (const kind of ['image', 'file']) {
    const directed = { type: 'request', id: 'media-user', action: 'send_media_to_user', params: { operation_id: 'media-intent', login_name: ' 00AbC ', kind, file_id: 'a0'.repeat(16), name: '原始 文件名.png' } };
    assert.deepEqual(parseRequest(directed), { ...directed, params: { ...directed.params, login_name: '00AbC' } });
    const { name: _name, ...withoutName } = directed.params;
    assert.deepEqual(parseRequest({ ...directed, params: withoutName }).params, { ...withoutName, login_name: '00AbC' });
    for (const extra of [
      { target_session_id: '23' }, { targetSessionId: '23' }, { targetLoginName: 'other' }, { session_id: '23' },
      { path: '/tmp/private.png' }, { filePath: '/tmp/private.png' }, { url: 'https://example.com/image.png' },
      { text: '不能先发文本' }, { reply_to: '101' }, { quote: '101' }, { mentions: [] }, { card: {} }, { extra: true },
    ]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, ...extra } }), { code: 'INVALID_REQUEST' });
    }
    for (const login_name of [undefined, null, '', '  ', 123, {}, [], 'a'.repeat(257)]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, login_name } }), /login_name/);
    }
    for (const file_id of [undefined, null, '', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32), ` ${'a'.repeat(32)}`, '../secret', 'https://example.com/image.png', 123, {}, []]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, file_id } }), /file_id/);
    }
    for (const name of [null, '', '  ', '\r\n', 123, {}, [], 'a'.repeat(257)]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, name } }), /name/);
    }
    for (const operation_id of [undefined, null, '', '  ', 123]) {
      assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, operation_id } }), /operation_id/);
    }
  }
});

test('按工号媒体拒绝图片文件以外的类型及错误请求形状', () => {
  const directed = { type: 'request', id: 'media-user', action: 'send_media_to_user', params: { operation_id: 'media-intent', login_name: '00AbC', kind: 'image', file_id: 'a'.repeat(32) } };
  for (const kind of [undefined, null, 'text', 'voice_text', 'voice', 'app_card', 'url_card', 'biz_card', 'chat_record', 'other', 1, {}, []]) {
    assert.throws(() => parseRequest({ ...directed, params: { ...directed.params, kind } }), { code: 'UNSUPPORTED_MESSAGE' });
  }
  for (const params of [undefined, null, [], 'image', 1]) {
    assert.throws(() => parseRequest({ ...directed, params }), { code: 'INVALID_REQUEST' });
  }
});

test('结果保留原生回执与查询载荷，发送不返回success或recall', () => {
  const receipt = { draftId: 'd', sessionId: '23', code: 0, businessCode: 0, messageId: 'm', msgIdx: 5 };
  const result = serializeResult({ status: 'sent', operationId: 'o', messageId: 'm', sessionId: '23', nativeCode: 0, receipt, isPreTrigger: false, verifyLatencyMs: 7, recall: async () => true });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'sent', operationId: 'o', messageId: 'm', sessionId: '23', nativeCode: 0, receipt, isPreTrigger: false, verifyLatencyMs: 7 });
  assert.deepEqual(serializeResult({ sessions: [] }), { sessions: [] });
  assert.deepEqual(serializeResult({ profile: null }), { profile: null });
});

test('配置保留服务地址、凭据及桥接本地数据目录规则', () => {
  const raw = { serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '123' };
  const config = parseConfig(raw, tmpdir());
  assert.equal(config.serverUrl, raw.serverUrl);
  assert.equal(config.dataDir, join(tmpdir(), 'data'));
  assert.equal(config.cdp.url, 'http://127.0.0.1:9222/');
  for (const serverUrl of ['http://host/api', 'http://user:secret@host', 'http://host?x=1', 'http://host#fragment', 'ws://host']) {
    assert.throws(() => parseConfig({ ...raw, serverUrl }, tmpdir()), /不含路径/);
  }
  assert.throws(() => parseConfig({ ...raw, token: 'short' }, tmpdir()), /32/);
});

test('CDP 接受远程 HTTP(S)、IPv6、回环及反向代理路径前缀', () => {
  const raw = { serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '123' };
  for (const url of [
    'http://remote:9222', 'http://172.16.0.18:9222', 'https://kk9.example.com',
    'http://[2001:db8::18]:9222', 'http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222',
    'https://kk9.example.com/proxy/kk9', 'https://kk9.example.com/proxy/kk9///', 'https://kk9.example.com/json-proxy',
  ]) {
    const config = parseConfig({ ...raw, cdp: { url, pageMatch: 'custom-renderer.html' } }, tmpdir());
    assert.equal(config.cdp.url, new URL(url).toString());
    assert.equal(config.cdp.pageMatch, 'custom-renderer.html');
  }
});

test('CDP 明确拒绝错误协议、URL 凭据、查询、片段和末尾 json 发现路径', () => {
  const raw = { serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '123' };
  for (const url of [
    'ws://remote:9222', 'wss://remote:9222', 'file:///tmp/cdp', 'ftp://remote:9222',
    'http://user:secret@remote:9222', 'http://user@remote:9222', 'http://:secret@remote:9222',
    'http://remote:9222?x=1', 'http://remote:9222?', 'http://remote:9222#fragment', 'http://remote:9222#',
    'http://remote:9222/json', 'http://remote:9222/json/', 'https://remote/proxy/json///',
  ]) {
    assert.throws(() => parseConfig({ ...raw, cdp: { url } }, tmpdir()), /cdp\.url/);
  }
});
