import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { WebSocketServer, WebSocket } from 'ws';
import { FakeKK9Driver, type IKK9Driver, type KK9EmployeeSearchItem, type KK9EmployeeSearchResult, type KK9GroupMember, type KK9Message, type SendOutcome, InMemorySendOperationStore } from '@kairo/driver';
import { Bridge } from '../src/bridge.js';
import { parseConfig } from '../src/config.js';

const message: KK9Message = { id: '101', messageId: '101', msgIdx: 1, sessionId: '8', sessionName: '测试群', sessionType: 'group', direction: 'inbound', sender: '测试员工', senderId: '2', content: 'hello', time: '', isMe: false, timestamp: 1 };
async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4000) throw new Error('等待测试条件超时');
    await delay(10);
  }
}

test('只提交入站、忽略 at 快捷事件、重连重放未 ACK 事件，发送 unknown 不重复触发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-bridge-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${(address as { port: number }).port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const store = new InMemorySendOperationStore();
  const driver = new FakeKK9Driver(store);
  driver.setCurrentUserId('1');
  driver.setMessages([message]);
  const received: Record<string, any>[] = [];
  const peers: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${config.token}`);
    peers.push(socket);
    socket.on('message', (bytes) => {
      const value = JSON.parse(bytes.toString());
      received.push(value);
      if (value.type === 'hello') {
        assert.equal(value.version, 2);
        socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      }
    });
  });
  let readyCount = 0;
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) readyCount++; });
  const running = bridge.run();
  try {
    await until(() => readyCount === 1);
    driver.emit('message', { ...message, id: 'out', direction: 'outbound' });
    driver.emit('message', { ...message, id: 'self', isMe: true });
    driver.emit('message', { ...message, id: 'recalled', isRecalled: true });
    driver.emit('message', { ...message, id: 'system', origin: 'system' });
    driver.emit('message', { ...message, id: 'system-type', messageType: 'system' });
    driver.emit('at', message);
    driver.emit('message', message);
    await until(() => received.some((item) => item.type === 'event'));
    assert.equal(received.filter((item) => item.type === 'event').length, 1);
    const first = received.find((item) => item.type === 'event')!;
    peers[0]!.terminate();
    await until(() => readyCount === 2 && received.filter((item) => item.type === 'event').length === 2);
    assert.equal(received.filter((item) => item.type === 'event')[1]!.event_id, first.event_id);
    const peer = peers[1]!;
    peer.send(JSON.stringify({ type: 'ack', event_id: first.event_id }));
    const params = { operation_id: 'send-1', target_session_id: '8', kind: 'text', text: 'reply', mentions: [{ uid: 'all', name: '所有人' }], reply_to: '101' };
    driver.setSendBehavior({ mode: 'post_trigger_timeout' });
    peer.send(JSON.stringify({ type: 'request', id: 'r1', action: 'send', params }));
    await until(() => received.some((item) => item.id === 'r1'));
    assert.equal(received.find((item) => item.id === 'r1')!.result.status, 'unknown');
    assert.equal(driver.recordedCalls[0]?.options?.targetSessionId, '8');
    assert.equal((driver.recordedCalls[0]?.options as any).mentions, 'all');
    peer.send(JSON.stringify({ type: 'request', id: 'r2', action: 'send', params }));
    await until(() => received.some((item) => item.id === 'r2'));
    assert.equal(received.find((item) => item.id === 'r2')!.result.status, 'unknown');
    assert.equal(driver.recordedCalls.length, 1);
    peer.send(JSON.stringify({ type: 'request', id: 'r3', action: 'get_send_status', params: { operation_id: 'send-1' } }));
    await until(() => received.some((item) => item.id === 'r3'));
    assert.equal(received.find((item) => item.id === 'r3')!.result.status, 'unknown');
    peer.terminate();
    await until(() => readyCount === 3);
    await delay(30);
    assert.equal(received.filter((item) => item.type === 'event').length, 2);
  } finally {
    bridge.stop();
    await running;
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('登录身份不符时不建立桥接连接，每次恢复使用新实例', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-reconnect-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:1', token: 'x'.repeat(32), expectedUserId: 'expected', reconnectDelayMs: 100 }, root);
  const drivers: FakeKK9Driver[] = [];
  let mismatchCount = 0;
  const bridge = new Bridge(config, () => {
    const driver = new FakeKK9Driver();
    driver.setCurrentUserId('wrong-account');
    drivers.push(driver);
    return driver;
  }, (_level, text) => { if (text.includes('UID 与 expectedUserId 不一致')) mismatchCount++; });
  const running = bridge.run();
  try {
    await until(() => mismatchCount >= 2);
    assert.ok(drivers.length >= 2);
    assert.notEqual(drivers[0], drivers[1]);
    assert.equal(drivers.reduce((sum, driver) => sum + driver.recordedCalls.length, 0), 0);
  } finally { bridge.stop(); await running; await rm(root, { recursive: true, force: true }); }
});

test('CDP health 失效后清理旧 Driver 并创建新实例', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-health-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const drivers: FakeKK9Driver[] = [];
  let disconnects = 0, ready = 0;
  server.on('connection', (socket) => socket.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
  }));
  const bridge = new Bridge(config, () => {
    const driver = new FakeKK9Driver();
    driver.setCurrentUserId('1');
    driver.disconnect = async () => { disconnects++; };
    drivers.push(driver);
    return driver;
  }, (_level, message) => { if (message.startsWith('AstrBot 桥接已连接')) ready++; });
  const running = bridge.run();
  try {
    await until(() => ready === 1);
    drivers[0]!.emit('health', { kind: 'cdp_invalidated', startupGenerationId: 'test', connectionIdentity: null, observedAt: Date.now(), cause: new Error('closed') });
    await until(() => ready === 2);
    assert.equal(disconnects, 1);
    assert.equal(drivers.length, 2);
    assert.notEqual(drivers[0], drivers[1]);
    drivers[1]!.emit('error', new Error('event bridge invalidated'));
    await until(() => ready === 3);
    assert.equal(disconnects, 2);
    assert.equal(drivers.length, 3);
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('RPC公开查询、三类卡片、图片文件语音和首次工号通知经过真实分派与附件下载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-native-rpc-'));
  const fileId = 'a'.repeat(32);
  const wav = Buffer.alloc(48);
  wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(4, 40);
  const http = createServer((request, response) => {
    assert.equal(request.url, `/files/${fileId}`);
    assert.equal(request.headers.authorization, `Bearer ${'x'.repeat(32)}`);
    response.end(wav);
  });
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const driver = new FakeKK9Driver();
  driver.setCurrentUserId('1');
  const sessions = [{ id: '8', name: '测试群', type: 'group' as const, nativeType: 1, receiverId: '88', unread: false }];
  const employee = { id: '2', loginName: 'AbC', name: '测试员工', updatedAt: 1, raw: { id: '2', login_name: 'AbC' } };
  driver.setSessions(sessions);
  driver.setEmployees([employee]);
  const responses = new Map<string, any>();
  let peer: WebSocket | undefined, ready = false;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') {
        assert.equal(value.version, 2);
        socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      } else if (value.type === 'response') responses.set(value.id, value);
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  let counter = 0;
  const rpc = async (action: string, params: Record<string, unknown>) => {
    const id = `rpc-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action, params }));
    await until(() => responses.has(id));
    return responses.get(id);
  };
  try {
    await until(() => ready);
    assert.deepEqual((await rpc('get_sessions', {})).result, { sessions });
    assert.deepEqual((await rpc('get_user_profile', { user_id: '2' })).result, { profile: employee });
    assert.deepEqual((await rpc('get_user_profile', { user_id: '999' })).result, { profile: null });
    driver.setEmployees([{ id: '3', loginName: '3', name: '缺少工号', updatedAt: 1, raw: { id: '3' } }]);
    const missingLogin = await rpc('get_user_profile', { user_id: '3' });
    assert.equal(missingLogin.ok, false);
    assert.equal(missingLogin.error.code, 'IDENTITY_UNAVAILABLE');
    driver.setEmployees([{ id: '3', loginName: '3', name: '数字工号', updatedAt: 1, raw: { id: '3', login_name: '3' } }]);
    assert.equal((await rpc('get_user_profile', { user_id: '3' })).result.profile.loginName, '3');
    driver.setEmployees([employee]);
    assert.equal(driver.recordedCalls.length, 0);
    assert.equal((await rpc('send', { operation_id: 'mixed-mentions', target_session_id: '8', kind: 'text', text: '群通知', mentions: [{ uid: 'all', name: '全体成员' }, { uid: '2', name: '测试员工' }] })).result.status, 'sent');
    assert.deepEqual(driver.recordedCalls.at(-1)!.options, { targetSessionId: '8', operationId: 'mixed-mentions', mentions: ['all', { uid: '2', name: '测试员工' }] });
    const cards = [
      { kind: 'app_card', card: { title: '通知', content: '<p>正文</p>' }, call: 'appMessage' },
      { kind: 'url_card', card: { title: '链接', summary: '摘要', linkUrl: 'https://example.com' }, call: 'urlCard' },
      { kind: 'biz_card', card: { title: '业务', content: '正文', bizType: 2, bizUrl: '/', summary: ['一'] }, call: 'bizMessage' },
    ];
    for (const [index, item] of cards.entries()) {
      const response = await rpc('send', { operation_id: `card-${index}`, target_session_id: '8', kind: item.kind, card: item.card });
      assert.equal(response.result.status, 'sent');
      assert.equal('success' in response.result, false);
      assert.equal('recall' in response.result, false);
      assert.equal(driver.recordedCalls.at(-1)!.type, item.call);
      assert.deepEqual(driver.recordedCalls.at(-1)!.payload, item.card);
      assert.equal(driver.recordedCalls.at(-1)!.options!.targetSessionId, '8');
    }
    for (const kind of ['image', 'file', 'voice']) {
      const response = await rpc('send', { operation_id: `media-${kind}`, target_session_id: '8', kind, file_id: fileId, name: 'audio.wav' });
      assert.equal(response.result.status, 'sent');
      const call = driver.recordedCalls.at(-1)!;
      assert.equal(call.type, kind);
      let path: string;
      if (kind === 'voice') {
        assert.ok(typeof call.payload === 'object' && 'filePath' in call.payload);
        assert.equal(typeof call.payload.filePath, 'string');
        path = call.payload.filePath!;
      } else {
        assert.equal(typeof call.payload, 'string');
        assert.ok(typeof call.payload === 'string');
        path = call.payload;
      }
      assert.deepEqual(await readFile(path), wav);
      if (kind === 'voice') assert.deepEqual(call.payload, { filePath: path });
    }
    const notify = await rpc('send_to_user', { operation_id: 'notify', login_name: ' AbC ', text: '首次通知' });
    assert.equal(notify.result.status, 'sent');
    assert.match(notify.result.sessionId, /^[1-9]\d*$/);
    assert.equal(driver.recordedCalls.at(-1)!.type, 'textToUser');
    assert.equal(driver.recordedCalls.at(-1)!.targetLoginName, 'AbC');
    const count = driver.recordedCalls.length;
    assert.deepEqual((await rpc('send_to_user', { operation_id: 'notify', login_name: 'AbC', text: '首次通知' })).result, notify.result);
    assert.equal(driver.recordedCalls.length, count);
    assert.deepEqual((await rpc('get_send_status', { operation_id: 'notify' })).result, notify.result);
    const mismatch = await rpc('send_to_user', { operation_id: 'notify', login_name: 'abc', text: '首次通知' });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, 'SEND_ERROR');
    assert.match(mismatch.error.message, /fingerprint/);
    assert.equal(driver.recordedCalls.length, count);
    const missing = await rpc('send_to_user', { operation_id: 'missing', login_name: 'abc', text: '不改投' });
    assert.equal(missing.result.status, 'failed');
    assert.match(missing.result.error, /未找到准确工号/);
    driver.getUserProfile = async () => { throw Object.assign(new Error('原生档案查询失败 (403)'), { code: 'NATIVE_PROFILE_FAILED' }); };
    assert.deepEqual((await rpc('get_user_profile', { user_id: '2' })).error, { code: 'NATIVE_PROFILE_FAILED', message: '原生档案查询失败 (403)' });
    driver.getSessions = async () => { throw new Error('原生会话查询断线'); };
    assert.deepEqual((await rpc('get_sessions', {})).error, { code: 'BRIDGE_ERROR', message: '原生会话查询断线' });
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('首次工号卡片无需已有私聊或预备文本，三类载荷原样发送并防止 unknown 重发与换收件人', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-directed-cards-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const driver = new FakeKK9Driver();
  driver.setCurrentUserId('1');
  driver.setEmployees([{ id: '2', loginName: '00AbC', name: '首次联系员工', updatedAt: 1, raw: { id: '2', login_name: '00AbC' } }]);
  const readSessions = driver.getSessions.bind(driver);
  driver.getSessions = async () => { throw new Error('按工号卡片不能依赖会话列表'); };
  const responses = new Map<string, any>();
  let peer: WebSocket | undefined, ready = false;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      else if (value.type === 'response') responses.set(value.id, value);
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  let counter = 0;
  const rpc = async (action: string, params: Record<string, unknown>) => {
    const id = `directed-card-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action, params }));
    await until(() => responses.has(id));
    return responses.get(id);
  };
  const cards = [
    { kind: 'app_card', card: { title: '通知', content: '<p>正文</p>', linkUrl: '/app', pcAppCode: 'real-app' }, call: 'appMessage' },
    { kind: 'url_card', card: { title: '链接', summary: '摘要', linkUrl: 'https://example.com', picUrl: 'https://example.com/image.png' }, call: 'urlCard' },
    { kind: 'biz_card', card: { title: '业务', content: '正文', bizType: 2, bizUrl: '/detail?id=1', summary: ['一', '二'] }, call: 'bizMessage' },
  ];
  try {
    await until(() => ready);
    for (const item of cards) {
      for (const status of ['sent', 'unknown']) {
        driver.setSessions([]);
        assert.deepEqual(await readSessions(), []);
        driver.setSendBehavior(status === 'sent' ? { mode: 'success' } : { mode: 'post_trigger_timeout' });
        const operation_id = `${item.kind}-${status}`;
        const params = { operation_id, login_name: ' 00AbC ', kind: item.kind, card: item.card };
        const before = driver.recordedCalls.length;
        const response = await rpc('send_card_to_user', params);
        assert.equal(response.ok, true);
        assert.equal(response.result.status, status);
        assert.equal(response.result.operationId, operation_id);
        assert.equal(driver.recordedCalls.length, before + 1);
        const call = driver.recordedCalls.at(-1)!;
        assert.equal(call.type, item.call);
        assert.deepEqual(call.payload, item.card);
        assert.deepEqual(call.options, { targetLoginName: '00AbC', operationId: operation_id });
        if (status === 'sent') {
          assert.match(response.result.sessionId, /^[1-9]\d*$/);
          const session = (await readSessions()).find((entry) => entry.id === response.result.sessionId);
          assert.equal(session?.type, 'private');
          assert.equal(session?.receiverId, '2');
        } else assert.equal(response.result.sessionId, undefined);
        driver.setSendBehavior({ mode: 'success', messageId: 'must-not-resubmit' });
        assert.deepEqual((await rpc('send_card_to_user', { ...params, login_name: '00AbC' })).result, response.result);
        assert.deepEqual((await rpc('get_send_status', { operation_id })).result, response.result);
        const mismatch = await rpc('send_card_to_user', { ...params, login_name: '00abc' });
        assert.equal(mismatch.ok, false);
        assert.equal(mismatch.error.code, 'SEND_ERROR');
        assert.match(mismatch.error.message, /fingerprint/);
        assert.equal(driver.recordedCalls.length, before + 1);
      }
    }
    assert.equal(driver.recordedCalls.length, 6);
    assert.ok(driver.recordedCalls.every((call) => ['appMessage', 'urlCard', 'bizMessage'].includes(call.type)));
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('首次工号图片文件下载原始字节与文件名，不依赖私聊或预备文本且防止重复与 unknown 重发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-directed-media-'));
  const token = 'x'.repeat(32);
  const downloads: string[] = [];
  const files = new Map<string, Buffer>();
  const http = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    downloads.push(request.url!);
    const bytes = files.get(request.url!);
    assert.ok(bytes, 'only the selected stable file_id is downloaded');
    response.end(bytes);
  });
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token, expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const driver = new FakeKK9Driver();
  driver.setCurrentUserId('1');
  driver.setEmployees([
    { id: '2', loginName: '00AbC', name: '首次联系员工', updatedAt: 1, raw: { id: '2', login_name: '00AbC' } },
    { id: '3', loginName: '00abc', name: '其他员工', updatedAt: 1, raw: { id: '3', login_name: '00abc' } },
  ]);
  const readSessions = driver.getSessions.bind(driver);
  driver.getSessions = async () => { throw new Error('按工号媒体不能依赖会话列表'); };
  const responses = new Map<string, any>();
  let peer: WebSocket | undefined, ready = false;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      else if (value.type === 'response') responses.set(value.id, value);
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  let counter = 0;
  const rpc = async (action: string, params: Record<string, unknown>) => {
    const id = `directed-media-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action, params }));
    await until(() => responses.has(id));
    return responses.get(id);
  };
  try {
    await until(() => ready);
    let fileIndex = 0;
    for (const kind of ['image', 'file']) {
      for (const status of ['sent', 'unknown']) {
        driver.setSessions([]);
        assert.deepEqual(await readSessions(), []);
        driver.setSendBehavior(status === 'sent' ? { mode: 'success' } : { mode: 'post_trigger_timeout' });
        const file_id = (++fileIndex).toString(16).padStart(32, '0');
        const bytes = Buffer.from([0, 255, fileIndex, 128, 13, 10, 42]);
        files.set(`/files/${file_id}`, bytes);
        const operation_id = `${kind}-${status}`;
        const name = kind === 'image' ? '原始 图片.png' : '原始 文件.bin';
        const params = { operation_id, login_name: ' 00AbC ', kind, file_id, name };
        const before = driver.recordedCalls.length;
        const response = await rpc('send_media_to_user', params);
        assert.equal(response.ok, true);
        assert.equal(response.result.status, status);
        assert.equal(response.result.operationId, operation_id);
        assert.equal(driver.recordedCalls.length, before + 1);
        const call = driver.recordedCalls.at(-1)!;
        assert.equal(call.type, kind);
        assert.equal(typeof call.payload, 'string');
        assert.ok(typeof call.payload === 'string');
        assert.equal(basename(call.payload), name);
        assert.deepEqual(await readFile(call.payload), bytes);
        assert.deepEqual(call.options, { targetLoginName: '00AbC', operationId: operation_id });
        if (status === 'sent') {
          assert.match(response.result.sessionId, /^[1-9]\d*$/);
          const session = (await readSessions()).find((entry) => entry.id === response.result.sessionId);
          assert.equal(session?.type, 'private');
          assert.equal(session?.receiverId, '2');
        } else assert.equal(response.result.sessionId, undefined);
        driver.setSendBehavior({ mode: 'success', messageId: 'must-not-resubmit' });
        assert.deepEqual((await rpc('send_media_to_user', { ...params, login_name: '00AbC' })).result, response.result);
        assert.deepEqual((await rpc('get_send_status', { operation_id })).result, response.result);
        const mismatch = await rpc('send_media_to_user', { ...params, login_name: '00abc' });
        assert.equal(mismatch.ok, false);
        assert.equal(mismatch.error.code, 'SEND_ERROR');
        assert.match(mismatch.error.message, /fingerprint/);
        assert.equal(driver.recordedCalls.length, before + 1);
      }
    }
    assert.equal(driver.recordedCalls.length, 4);
    assert.ok(driver.recordedCalls.every((call) => call.type === 'image' || call.type === 'file'));
    assert.deepEqual(downloads, [...files.keys()]);
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ['image', 'file']) {
  test(`工号 ${kind} 下载被拒绝或下载期间切换账号时绝不发送`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-directed-media-denied-'));
    const token = 'x'.repeat(32);
    const deniedId = 'd'.repeat(32), changedId = 'e'.repeat(32);
    const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
    const driver = new FakeKK9Driver();
    driver.setCurrentUserId('1');
    driver.setEmployees([{ id: '2', loginName: '00AbC', name: '首次联系员工', updatedAt: 1, raw: { id: '2', login_name: '00AbC' } }]);
    driver.getSessions = async () => { throw new Error('不能读取会话列表'); };
    const downloads: string[] = [];
    const http = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      downloads.push(request.url!);
      if (request.url === `/files/${deniedId}`) {
        response.writeHead(403);
        response.end('denied');
      } else {
        assert.equal(request.url, `/files/${changedId}`);
        driver.setCurrentUserId('999');
        response.end(bytes);
      }
    });
    const server = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token, expectedUserId: '1', reconnectDelayMs: 100 }, root);
    const responses = new Map<string, any>();
    let peer: WebSocket | undefined, ready = false;
    server.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
        else if (value.type === 'response') responses.set(value.id, value);
      });
    });
    const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
    const running = bridge.run();
    try {
      await until(() => ready);
      const params = { operation_id: `${kind}-denied`, login_name: '00AbC', kind, file_id: deniedId, name: '原始附件.bin' };
      peer!.send(JSON.stringify({ type: 'request', id: 'denied', action: 'send_media_to_user', params }));
      await until(() => responses.has('denied'));
      assert.deepEqual(responses.get('denied').error, { code: 'FILE_DOWNLOAD_FAILED', message: '附件下载失败 (HTTP 403)' });
      assert.equal(responses.get('denied').ok, false);
      assert.equal(driver.recordedCalls.length, 0);
      peer!.send(JSON.stringify({ type: 'request', id: 'changed', action: 'send_media_to_user', params: { ...params, operation_id: `${kind}-changed`, file_id: changedId } }));
      await until(() => peer!.readyState === WebSocket.CLOSED);
      bridge.stop(); await running;
      assert.deepEqual(await readFile(join(config.dataDir, 'attachments', changedId, params.name)), bytes);
      assert.deepEqual(downloads, [`/files/${deniedId}`, `/files/${changedId}`]);
      assert.equal(driver.recordedCalls.length, 0, 'identity must be rechecked after bytes are downloaded');
      assert.equal(responses.has('changed'), false, 'identity mismatch terminates the authenticated connection');
    } finally {
      bridge.stop(); await running;
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('文本语音无附件 HTTP 依赖，原生结果及既有发送记录防重并拒绝更换文本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-voice-text-'));
  let httpRequests = 0;
  const http = createServer((_request, response) => { httpRequests++; response.writeHead(404).end(); });
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const store = new InMemorySendOperationStore();
  const driver = new FakeKK9Driver(store);
  const historicalDriver = new FakeKK9Driver(store);
  driver.setCurrentUserId('1');
  const responses = new Map<string, any>();
  let peer: WebSocket | undefined, ready = false;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      else if (value.type === 'response') responses.set(value.id, value);
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  let counter = 0;
  const rpc = async (action: string, params: Record<string, unknown>) => {
    const id = `voice-rpc-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action, params }));
    await until(() => responses.has(id));
    return responses.get(id);
  };
  const outcomes: SendOutcome[] = [
    { status: 'sent', messageId: 'voice-message', sessionId: '8', nativeCode: 0, receipt: { draftId: 'voice-draft', sessionId: '8', code: 0, businessCode: 0, messageId: 'voice-message', msgIdx: 7 }, isPreTrigger: false, verifyLatencyMs: 12 },
    { status: 'failed', error: '原生语音准备失败', nativeCode: 617, isPreTrigger: true },
    { status: 'unknown', error: '原生发送回执超时', receipt: { draftId: 'pending-voice', sessionId: '8', code: 0 }, isPreTrigger: false, verifyLatencyMs: 20_000 },
  ];
  try {
    await until(() => ready);
    for (const existing of [false, true]) {
      for (const outcome of outcomes) {
        const operation_id = `voice-${existing ? 'existing' : 'new'}-${outcome.status}`;
        const text = `  读出 ${outcome.status}\n保留原文  `;
        const params = { operation_id, target_session_id: '8', kind: 'voice_text', text };
        if (existing) {
          historicalDriver.setSendBehavior({ mode: 'custom', handler: () => outcome });
          await historicalDriver.sendVoice({ text }, { targetSessionId: '8', operationId: operation_id });
        }
        const before = driver.recordedCalls.length;
        driver.setSendBehavior({ mode: 'custom', handler: () => outcome });
        const response = await rpc('send', params);
        assert.equal(response.ok, true);
        assert.deepEqual(response.result, { ...outcome, operationId: operation_id });
        const expectedCalls = before + (existing ? 0 : 1);
        assert.equal(driver.recordedCalls.length, expectedCalls);
        if (!existing) {
          const call = driver.recordedCalls.at(-1)!;
          assert.equal(call.type, 'voice');
          assert.deepEqual(call.payload, { text });
          assert.deepEqual(call.options, { targetSessionId: '8', operationId: operation_id });
        }
        driver.setSendBehavior({ mode: 'success', messageId: 'must-not-resubmit' });
        assert.deepEqual((await rpc('send', params)).result, response.result);
        assert.deepEqual((await rpc('get_send_status', { operation_id })).result, response.result);
        const changed = await rpc('send', { ...params, text: '这是不同的发送意图' });
        assert.equal(changed.ok, false);
        assert.equal(changed.error.code, 'SEND_ERROR');
        assert.match(changed.error.message, /fingerprint/);
        assert.equal(driver.recordedCalls.length, expectedCalls);
      }
    }
    const before = driver.recordedCalls.length;
    const next = await rpc('send', { operation_id: 'voice-changed-new-intent', target_session_id: '8', kind: 'voice_text', text: '这是不同的发送意图' });
    assert.equal(next.result.status, 'sent');
    assert.equal(next.result.operationId, 'voice-changed-new-intent');
    assert.equal(driver.recordedCalls.length, before + 1);
    assert.deepEqual(driver.recordedCalls.at(-1)!.payload, { text: '这是不同的发送意图' });
    assert.equal(httpRequests, 0);
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('员工搜索通过真实 JSON WebSocket 完整返回候选，不回退身份、不发送且保留原生错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-employee-search-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const driver = new FakeKK9Driver();
  driver.setCurrentUserId('1');
  driver.setEmployees([{ id: '999', loginName: 'organization-only', name: '张三', updatedAt: 1 }]);
  const employees: KK9EmployeeSearchItem[] = [
    { id: '2', name: '张三', loginName: 'AbC', departmentPaths: ['总公司/研发部/平台组', '总公司/项目组'] },
    { id: '3', name: '张三', loginName: null, departmentPaths: null },
    { id: '4', name: null, loginName: '张三-login', departmentPaths: ['总公司/人事部'] },
    ...Array.from({ length: 500 }, (_, index) => ({ id: String(index + 10), name: `张三-${index}`, loginName: `Employee-${index}`, departmentPaths: [`总公司/部门-${index}`] })),
  ];
  driver.setSearchEmployees(employees);
  driver.getUserProfile = async () => { throw new Error('搜索不应另查展示档案'); };
  driver.getSessions = async () => { throw new Error('搜索不应操作会话'); };
  const responses = new Map<string, any>();
  let peer: WebSocket | undefined, ready = false;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      else if (value.type === 'response') responses.set(value.id, value);
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  let counter = 0;
  const rpc = async (params: Record<string, unknown>) => {
    const id = `search-rpc-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action: 'search_employees', params }));
    await until(() => responses.has(id));
    return responses.get(id);
  };
  try {
    await until(() => ready);
    const found = await rpc({ keyword: '  张三  ' });
    assert.equal(found.ok, true);
    assert.deepEqual(found.result, { employees, hasMore: false });
    for (const params of [{ keyword: '' }, { keyword: '张三', operation_id: 'must-not-send' }, { keyword: '张三', page: 1 }]) {
      assert.equal((await rpc(params)).error.code, 'INVALID_REQUEST');
    }
    driver.setSearchEmployees([]);
    assert.deepEqual((await rpc({ keyword: '  张三  ' })).result, { employees: [], hasMore: false });
    for (const code of ['IPC_QUERY_FAILED', 'IPC_INVALID_RESPONSE']) {
      driver.searchEmployees = async () => { throw Object.assign(new Error(`原生搜索失败 (${code})`), { code }); };
      assert.deepEqual(await rpc({ keyword: '张三' }), { type: 'response', id: `search-rpc-${counter}`, ok: false, error: { code, message: `原生搜索失败 (${code})` } });
    }
    driver.searchEmployees = async () => { throw new Error('搜索连接中断'); };
    const disconnected = await rpc({ keyword: '张三' });
    assert.equal(disconnected.ok, false);
    assert.deepEqual(disconnected.error, { code: 'BRIDGE_ERROR', message: '搜索连接中断' });
    assert.equal(driver.recordedCalls.length, 0);
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('群成员经已安装 Driver 原生查询和 JSON RPC 返回全员，空群与失败分离且不发送', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-group-members-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const members: KK9GroupMember[] = [
    { id: '2', name: '张三', loginName: '00AbC', position: '平台工程师', departmentPaths: ['总公司 / 研发部', '总公司 / 项目组'] },
    { id: '3', name: null, loginName: null, position: null, departmentPaths: null },
    ...Array.from({ length: 500 }, (_, index) => ({ id: String(index + 10), name: `成员-${index}`, loginName: `Employee-${index}`, position: '工程师', departmentPaths: ['总公司 / 研发部'] })),
  ];
  let failure: 'query' | 'profile' | null = null;
  class GroupRenderer extends EventEmitter {
    async evaluate(script: string): Promise<unknown> {
      return runInNewContext(script, { window: { ipcRenderer: this }, setTimeout, clearTimeout });
    }
    send(channel: string, request: { id: number; args: [string, ...unknown[]] }): void {
      assert.equal(channel, 'data');
      const [method, key] = request.args;
      let data: unknown;
      switch (method) {
        case 'getSessionBySessionID':
          data = key === 8 ? { id: 8, type: 1, typeID: 88 } : key === 9 ? { id: 9, type: 1, typeID: 99 } : key === 10 ? { id: 10, type: 0, typeID: 2 } : null;
          break;
        case 'getGroupsAllMembers':
          assert.ok(key === 88 || key === 99, '原生群对象必须来自会话，不能把会话 ID 当群对象');
          data = key === 88 ? [...members.map(member => ({ id: Number(member.id) })), { id: 2 }] : [];
          break;
        case 'getMemberDetail': {
          const member = members.find(item => Number(item.id) === key)!;
          if (key === 3 && failure === 'query') {
            queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 73, error: '原生档案不可用' }));
            return;
          }
          data = { id: key === 3 && failure === 'profile' ? 999 : key, name: member.name, login_name: member.loginName, pos: member.position };
          break;
        }
        case 'getAllDeptPaths':
          data = (members.find(item => Number(item.id) === key)!.departmentPaths ?? []).map(path => ({ deptPaths: path.split(' / ').map(name => ({ name })) }));
          break;
        default: throw new Error(`群成员查询不得调用 ${method}`);
      }
      queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 0, data }));
    }
  }
  // 包 exports 不公开内部子路径，须从安装入口动态定位以测试消费方产物及原生 IPC 脚本。
  const entry = pathToFileURL(createRequire(import.meta.url).resolve('@kairo/driver'));
  const { BridgeOrgOps }: { BridgeOrgOps: new (cdp: GroupRenderer) => Pick<IKK9Driver, 'getGroupMembers'> } = await import(new URL('./bridge/org-ops.js', entry).href);
  const native = new GroupRenderer();
  const ops = new BridgeOrgOps(native);
  const driver = new FakeKK9Driver();
  driver.setCurrentUserId('1');
  driver.getGroupMembers = ops.getGroupMembers.bind(ops);
  driver.getSessions = async () => { throw new Error('不能用展示会话列表代替原生群查询'); };
  driver.getUserProfile = async () => { throw new Error('不能用展示档案补群成员资料'); };
  const responses = new Map<string, any>();
  let peer: WebSocket | undefined, ready = false;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      else if (value.type === 'response') responses.set(value.id, value);
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  let counter = 0;
  const rpc = async (params: Record<string, unknown>) => {
    const id = `group-rpc-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action: 'get_group_members', params }));
    await until(() => responses.has(id));
    return responses.get(id);
  };
  try {
    await until(() => ready);
    assert.deepEqual(await rpc({ session_id: '8' }), { type: 'response', id: `group-rpc-${counter}`, ok: true, result: { members } });
    assert.deepEqual(await rpc({ session_id: '9' }), { type: 'response', id: `group-rpc-${counter}`, ok: true, result: { members: [] } });
    for (const params of [{ session_id: '08' }, { session_id: '测试群' }, { session_id: '8', operation_id: 'must-not-send' }, { session_id: '8', limit: 1 }]) {
      assert.equal((await rpc(params)).error.code, 'INVALID_REQUEST');
    }
    for (const [session_id, code] of [['10', 'INVALID_SESSION_ID'], ['88', 'IPC_INVALID_RESPONSE']]) {
      const response = await rpc({ session_id });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, code);
      assert.equal('result' in response, false);
    }
    for (const [mode, code] of [
      ['query', 'IPC_QUERY_FAILED'],
      ['profile', 'IPC_INVALID_RESPONSE'],
    ] as const) {
      failure = mode;
      const response = await rpc({ session_id: '8' });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, code);
      assert.match(response.error.message, /UID 3/);
      assert.equal('result' in response, false, '后续成员失败不得返回已读取的部分成员');
    }
    assert.equal(driver.recordedCalls.length, 0);
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
