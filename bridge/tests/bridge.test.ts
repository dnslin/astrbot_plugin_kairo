import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer, WebSocket } from 'ws';
import { FakeKK9Driver, type KK9Message, InMemorySendOperationStore } from '@kairo/driver';
import { Bridge } from '../src/bridge.js';
import { parseConfig } from '../src/config.js';

const message: KK9Message = { id: 'm1', messageId: 'm1', sessionId: '1-8', sessionName: '测试群', sessionType: 'group', direction: 'inbound', sender: '测试员工', senderId: '2', content: 'hello', time: '', isMe: false, timestamp: 1 };
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
  const received: Record<string, any>[] = [];
  const peers: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${config.token}`);
    peers.push(socket);
    socket.on('message', (bytes) => {
      const value = JSON.parse(bytes.toString());
      received.push(value);
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 1 }));
    });
  });
  let readyCount = 0;
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) readyCount++; });
  const running = bridge.run();
  try {
    await until(() => readyCount === 1);
    driver.emit('message', { ...message, id: 'out', direction: 'outbound' });
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
    const params = { operation_id: 'send-1', target_session_id: '1-8', kind: 'text', text: 'reply', mentions: [{ uid: 'all', name: '所有人' }], reply_to: 'm1' };
    driver.setSendBehavior({ mode: 'post_trigger_timeout' });
    peer.send(JSON.stringify({ type: 'request', id: 'r1', action: 'send', params }));
    await until(() => received.some((item) => item.id === 'r1'));
    assert.equal(received.find((item) => item.id === 'r1')!.result.status, 'unknown');
    assert.equal(driver.recordedCalls[0]?.options?.targetSessionId, '1-8');
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
    if (JSON.parse(raw.toString()).type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 1 }));
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
