import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { WebSocketServer, WebSocket } from 'ws';
import { FakeKK9Driver, InMemorySendOperationStore, type IKK9Driver, type KK9Message, type SendResult } from '@kairo/driver';
import { Bridge } from '../src/bridge.js';
import { parseConfig } from '../src/config.js';
import type { HistoryMessage } from '../src/protocol.js';

const message: KK9Message = { id: '101', messageId: '101', msgIdx: 1, sessionId: '8', sessionName: '测试群', sessionType: 'group', direction: 'inbound', sender: '测试员工', senderId: '2', content: 'hello', time: '', isMe: false, timestamp: 1 };
async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4000) throw new Error('等待测试条件超时');
    await delay(10);
  }
}

test('群历史与聊天记录经真实原生脚本：原群排序及安全摘要，原生拒绝和持久意图防重', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-chat-record-'));
  let httpRequests = 0;
  const http = createServer((_request, response) => { httpRequests++; response.writeHead(404).end(); });
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(32), expectedUserId: '1', reconnectDelayMs: 100 }, root);
  const sessions = [
    { id: '8', name: '来源群', type: 'group' as const, nativeType: 1, receiverId: '88', unread: false },
    { id: '9', name: '其他群', type: 'group' as const, nativeType: 1, receiverId: '99', unread: false },
    { id: '10', name: '私聊', type: 'private' as const, nativeType: 0, receiverId: '2', unread: false },
  ];
  type NativeRow = { id: number; msgIdx?: number; sessionID: number; sender: number; senderName: string; sendTime: number; contentType: number; content: unknown; msgFlag: string; [key: string]: unknown };
  const source = (id: number, msgIdx: number, content: unknown, contentType = 0): NativeRow => ({ id, msgIdx, sessionID: 8, sender: 2, senderName: '真实员工', sendTime: 1_700_000_000, contentType, content, msgFlag: 'N' });
  const rows = [
    source(103, 3, { filename: '报告.pdf', filepath: 'C:/private/report.pdf', size: 12 }, 3),
    source(102, 2, { senderName: '原发送者', sessionType: 1, typeName: '来源群', msgArray: [{ content: '不应展开的内层正文', filePath: 'C:/private/inner.pdf' }] }, 15),
    source(101, 1, '第一条真实正文'),
  ];
  class RecordRenderer extends EventEmitter {
    calls: Array<{ method: string; args: unknown[] }> = [];
    drafts: NativeRow[] = [];
    sent: NativeRow[] = [];
    timers = new Map<number, { delay: number; callback: () => void }>();
    nextTimer = 0;
    historyFailure: 'query' | 'shape' | null = null;
    missingReceipt = false;
    window = { ipcRenderer: this };
    getStatus() { return 'connected'; }
    async evaluate(script: string): Promise<unknown> {
      return runInNewContext(script, {
        window: this.window, AbortController,
        setTimeout: (callback: () => void, delay: number) => {
          const id = ++this.nextTimer;
          this.timers.set(id, { delay, callback });
          return id;
        },
        clearTimeout: (id?: number) => { if (id !== undefined) this.timers.delete(id); },
      });
    }
    send(channel: string, request: { id: number; args: [string, ...unknown[]] }): void {
      assert.equal(channel, 'data');
      const [method, ...args] = request.args;
      this.calls.push({ method, args });
      let data: unknown;
      switch (method) {
        case 'getMemberDetail': data = { id: 1, name: '真实机器人' }; break;
        case 'getSessionBySessionID':
          assert.equal(args[0], 8, '原生发送只能读取明确来源群，不能用当前窗口');
          data = { id: 8, type: 1, typeID: 88, typeName: '来源群' };
          break;
        case 'getMessages': {
          const query = args[0] as { sessionID: number };
          assert.ok(query.sessionID === 8 || query.sessionID === 9);
          if (this.historyFailure === 'query') {
            queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 73, error: '原生历史不可用' }));
            return;
          }
          data = this.historyFailure === 'shape' ? null : query.sessionID === 8 ? rows : [];
          break;
        }
        case 'getMessageBySessionIDAndMsgIdx':
          assert.equal(args[0], 8);
          data = rows.filter((row) => row.sessionID === args[0] && row.msgIdx === args[1]);
          break;
        case 'insertSendBefoeMsg':
          this.drafts.push(structuredClone(args[0]) as NativeRow);
          data = { id: -31, msgIdx: 10 };
          break;
        case 'sendMessageNew': {
          const draft = structuredClone(args[0]) as NativeRow;
          this.sent.push(draft);
          data = null;
          if (this.missingReceipt) {
            queueMicrotask(() => {
              for (const [id, timer] of this.timers) {
                if (timer.delay >= 4000) continue;
                this.timers.delete(id);
                timer.callback();
              }
            });
          } else {
            const persisted = { ...draft, id: 901, msgIdx: 10 };
            queueMicrotask(() => this.emit('1-88-sendMsgCallback', {}, { args: { msgID: -31, code: 0, data: persisted } }));
          }
          break;
        }
        default: throw new Error(`聊天记录不得调用 ${method}`);
      }
      queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 0, data }));
    }
  }
  // 包 exports 不公开内部子路径；从运行时安装入口定位实际消费产物，不能静态导入源码。
  const entry = pathToFileURL(createRequire(import.meta.url).resolve('@kairo/driver'));
  type RecordOps = Pick<IKK9Driver, 'getRecentMessages' | 'sendChatRecord' | 'getSendStatus'>;
  const { BridgeMessageOps }: { BridgeMessageOps: new (cdp: RecordRenderer, store: InMemorySendOperationStore) => RecordOps } = await import(new URL('./bridge/message-ops.js', entry).href);
  const native = new RecordRenderer();
  const store = new InMemorySendOperationStore();
  const ops = new BridgeMessageOps(native, store);
  const driver = new FakeKK9Driver();
  driver.setCurrentUserId('1');
  driver.setSessions(sessions);
  driver.getRecentMessages = ops.getRecentMessages.bind(ops);
  driver.sendChatRecord = (record, options) => ops.sendChatRecord(record, { ...options, verifyTimeoutMs: 30 });
  driver.getSendStatus = ops.getSendStatus.bind(ops);
  type RpcResponse<T> = { type: string; id: string; ok: boolean; result: T; error: { code: string; message: string } };
  const responses = new Map<string, RpcResponse<unknown>>();
  let peer: WebSocket | undefined, ready = false, counter = 0, events = 0;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 2 }));
      else if (value.type === 'response') responses.set(value.id, value);
      else if (value.type === 'event') events++;
    });
  });
  const bridge = new Bridge(config, () => driver, (_level, text) => { if (text.startsWith('AstrBot 桥接已连接')) ready = true; });
  const running = bridge.run();
  const rpc = async <T = SendResult>(action: string, params: Record<string, unknown>): Promise<RpcResponse<T>> => {
    const id = `record-rpc-${++counter}`;
    peer!.send(JSON.stringify({ type: 'request', id, action, params }));
    await until(() => responses.has(id));
    // 响应由本测试创建的RPC请求确定类型，Map仅用于不同请求共享收件箱。
    return responses.get(id)! as RpcResponse<T>;
  };
  try {
    await until(() => ready);
    const history = await rpc<{ messages: HistoryMessage[] }>('get_recent_messages', { session_id: '8', limit: 3 });
    assert.equal(history.ok, true);
    assert.deepEqual(history.result.messages.map((item) => [item.messageId, item.msgIdx, item.content]), [
      ['101', 1, '第一条真实正文'], ['102', 2, '原发送者的聊天记录'], ['103', 3, '[文件: 报告.pdf]'],
    ]);
    for (const item of history.result.messages) {
      assert.deepEqual(Object.keys(item).sort(), ['messageId', 'msgIdx', 'senderId', 'sender', 'content', 'timestamp', 'messageType', 'isRecalled'].sort());
      assert.equal(item.senderId, '2');
      assert.equal(item.timestamp, 1_700_000_000_000);
    }
    assert.doesNotMatch(JSON.stringify(history.result), /private|inner\.pdf|不应展开|filePath|filepath|raw/);
    assert.deepEqual(JSON.parse(JSON.stringify(native.calls.find((call) => call.method === 'getMessages')!.args)), [{ sessionID: 8, count: 3, endIdx: 2147483647, sendTime: 0 }]);
    assert.deepEqual((await rpc<{ messages: HistoryMessage[] }>('get_recent_messages', { session_id: '9' })).result, { messages: [] });
    for (const [session_id, code] of [['88', 'SESSION_NOT_FOUND'], ['10', 'INVALID_SESSION_ID']]) {
      const before = native.calls.length;
      const rejected = await rpc('get_recent_messages', { session_id });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, code);
      assert.equal(native.calls.length, before, '不存在或非群会话不得查询原生历史');
    }
    for (const [failure, code] of [['query', 'IPC_QUERY_FAILED'], ['shape', 'IPC_INVALID_RESPONSE']] as const) {
      native.historyFailure = failure;
      const rejected = await rpc('get_recent_messages', { session_id: '8' });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, code);
      assert.equal('result' in rejected, false, '失败不得伪装为空历史');
    }
    native.historyFailure = null;
    driver.getRecentMessages = async () => [
      { ...message, id: 'local-not-the-native-id', messageId: '201', msgIdx: undefined, senderId: undefined, messageType: undefined },
      { ...message, id: '202', messageId: undefined, msgIdx: 2, isRecalled: true },
      { ...message, id: '203', messageId: '203', msgIdx: 1 },
    ];
    const incomplete = (await rpc<{ messages: HistoryMessage[] }>('get_recent_messages', { session_id: '8' })).result.messages;
    assert.deepEqual(incomplete.map((item) => [item.messageId, item.msgIdx]), [['203', 1], ['202', 2], ['201', null]]);
    assert.equal(incomplete[1]!.isRecalled, true);
    assert.equal(incomplete[2]!.senderId, null);
    assert.equal(incomplete[2]!.messageType, null);
    assert.equal(native.drafts.length, 0);
    assert.equal(native.sent.length, 0);
    const record = { sourceSessionId: '8', msgArray: [{ messageId: '103', msgIdx: 3 }, { messageId: '101', msgIdx: 1 }] };
    const params = { operation_id: 'native-record', target_session_id: '8', kind: 'chat_record', record };
    const sent = await rpc('send', params);
    assert.equal(sent.ok, true);
    assert.equal(sent.result.status, 'sent');
    assert.equal(sent.result.messageId, '901');
    assert.ok(sent.result.receipt);
    assert.equal(sent.result.receipt.sessionId, '8');
    assert.equal('recall' in sent.result, false);
    assert.equal('success' in sent.result, false);
    const submitted: { contentType: number; sessionID: number; receiver: number; content: { sessionID: number; typeID: number; senderName: string; msgArray: Array<{ id: number; msgIdx: number; senderID: number; senderName: string; content: unknown }> } } = JSON.parse(JSON.stringify(native.sent[0]));
    assert.equal(submitted.contentType, 15);
    assert.equal(submitted.sessionID, 8);
    assert.equal(submitted.receiver, 88);
    assert.equal(submitted.content.sessionID, 8);
    assert.equal(submitted.content.typeID, 88);
    assert.equal(submitted.content.senderName, '真实机器人');
    assert.deepEqual(submitted.content.msgArray.map((item) => [item.id, item.msgIdx, item.senderID, item.senderName]), [[101, 1, 2, '真实员工'], [103, 3, 2, '真实员工']]);
    assert.deepEqual(submitted.content.msgArray[0]!.content, { content: [{ type: 0, text: '第一条真实正文' }] });
    assert.deepEqual((await rpc('send', params)).result, sent.result);
    const conflict = await rpc('send', { ...params, record: { sourceSessionId: '8', msgArray: [{ messageId: '102', msgIdx: 2 }] } });
    assert.equal(conflict.ok, false);
    assert.match(conflict.error.message, /operationId|指纹|意图|不同|冲突|不一致/);
    assert.equal(native.sent.length, 1);
    for (const [index, ref] of [{ messageId: '999', msgIdx: 1 }, { messageId: '101', msgIdx: 2 }, { messageId: '101', msgIdx: 1 }].entries()) {
      if (index === 2) rows.find((row) => row.id === 101)!.msgFlag = 'C';
      const rejected = await rpc('send', { ...params, operation_id: `native-rejected-${index}`, record: { sourceSessionId: '8', msgArray: [ref] } });
      assert.equal(rejected.ok, true);
      assert.equal(rejected.result.status, 'failed');
      assert.equal(rejected.result.isPreTrigger, true);
      assert.match(rejected.result.error!, /不存在|索引不符|撤回/);
      assert.equal(native.drafts.length, 1, '错误引用不得创建草稿');
      assert.equal(native.sent.length, 1);
    }
    rows.find((row) => row.id === 101)!.msgFlag = 'N';
    native.missingReceipt = true;
    const pending = { ...params, operation_id: 'native-record-unknown' };
    const unknown = await rpc('send', pending);
    assert.equal(unknown.result.status, 'unknown');
    assert.match(unknown.result.error!, /回执超时/);
    native.missingReceipt = false;
    const recovered = new BridgeMessageOps(native, store);
    driver.sendChatRecord = (record, options) => recovered.sendChatRecord(record, { ...options, verifyTimeoutMs: 30 });
    driver.getSendStatus = recovered.getSendStatus.bind(recovered);
    assert.deepEqual((await rpc('send', pending)).result, unknown.result);
    assert.deepEqual((await rpc('get_send_status', { operation_id: pending.operation_id })).result, unknown.result);
    assert.equal(native.sent.length, 2);
    assert.equal(native.drafts.length, 2);
    assert.equal(native.listenerCount('1-88-sendMsgCallback'), 0);
    assert.equal(httpRequests, 0, '历史及聊天记录不下载附件');
    assert.equal(events, 0, '历史查询不派发实时事件');
    assert.equal(driver.recordedCalls.length, 0, '全部发送均走已安装Driver原生卡片脚本');
    const before = native.calls.length;
    driver.setCurrentUserId('switched-account');
    const closed = new Promise<void>((resolve) => peer!.once('close', () => resolve()));
    peer!.send(JSON.stringify({ type: 'request', id: 'history-identity', action: 'get_recent_messages', params: { session_id: '8' } }));
    await closed;
    assert.equal(native.calls.length, before, '每次历史查询先核对登录身份');
  } finally {
    bridge.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
