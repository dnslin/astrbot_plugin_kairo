import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import type { IKK9Driver, SendOptions, SendResult } from '@kairo/driver';

// 定位已安装的 Driver 包而非原始 vendor checkout，验证消费方实际产物及生成的渲染脚本。
// 包 exports 不公开内部子路径，从安装入口定位内部模块以覆盖安装后的包边界。
const entry = pathToFileURL(createRequire(import.meta.url).resolve('@kairo/driver'));
type CardOps = Pick<IKK9Driver, 'sendAppMessage' | 'sendUrlCard' | 'sendBizMessage' | 'sendText' | 'sendImage' | 'sendChatRecord' | 'getSendStatus'> & { cancelPendingSends(): Promise<void> };
const { BridgeMessageOps }: { BridgeMessageOps: new (cdp: NativeRenderer) => CardOps } = await import(new URL('./bridge/message-ops.js', entry).href);

type NativeRow = { contentType: number; content: unknown; receiver: number; sessionType: number; sessionID: number; id?: number; msgIdx?: number; status: string };
class NativeRenderer extends EventEmitter {
  calls: Array<{ method: string; args: unknown[] }> = [];
  messages: NativeRow[] = [];
  sent: NativeRow[] = [];
  drafts: NativeRow[] = [];
  budgets: number[] = [];
  pendingTimers = new Map<number, { delay: number; callback: () => void }>();
  nextTimerId = 0;
  mode: 'sent' | 'missing-receipt' | 'foreign-receipt' = 'sent';
  users = [{ id: 9, login_name: '00AbC-near' }, { id: 2, login_name: '00AbC' }];
  limited: number[] = [];
  profileLogin = '00AbC';
  window: { ipcRenderer: NativeRenderer; __kairo_pending_sends?: Map<string, () => void> } = { ipcRenderer: this };
  onLookup?: () => void;

  getStatus() { return 'connected'; }
  async evaluate(script: string, timeout?: number): Promise<unknown> {
    if (timeout !== undefined) this.budgets.push(timeout);
    return runInNewContext(script, {
      window: this.window, AbortController,
      clearTimeout: (id?: number) => { if (id !== undefined) this.pendingTimers.delete(id); },
      setTimeout: (callback: () => void, delay: number) => {
        const id = ++this.nextTimerId;
        this.pendingTimers.set(id, { delay, callback });
        return id;
      },
    });
  }
  send(channel: string, request: { id: number; args: [string, ...unknown[]] }) {
    assert.equal(channel, 'data');
    const [method, ...args] = request.args;
    this.calls.push({ method, args });
    let data: unknown;
    switch (method) {
      case 'getMemberDetail':
        data = args.length ? { id: 2, login_name: this.profileLogin, name: 'Recipient' } : { id: 1, name: 'Sender' };
        break;
      case 'unionSearch':
        this.onLookup?.();
        data = { users: this.users };
        break;
      case 'getUsersSessionLimit': data = this.limited; break;
      case 'getSessionBySessionID':
        assert.equal(args[0], 77, 'never consult the active chat or a guessed session');
        data = { id: 77, type: 0, typeID: 2, creater: 1, name: 'Recipient' };
        break;
      case 'insertSendBefoeMsg':
        // This in-process request was just constructed by the real renderer.
        this.drafts.push(structuredClone(args[0]) as NativeRow);
        data = { id: -31, msgIdx: 1 };
        break;
      case 'sendMessageNew': {
        // Native sends have the exact structured message shape above.
        const draft = structuredClone(args[0]) as NativeRow;
        this.sent.push(draft);
        data = null;
        if (this.mode !== 'missing-receipt') {
          const persisted = { ...draft, id: 901, msgIdx: 5, sessionID: 77, status: 'sent' };
          this.messages.push(persisted);
          const receipt = this.mode === 'foreign-receipt' ? { ...persisted, receiver: 99 } : persisted;
          queueMicrotask(() => this.emit('0-2-sendMsgCallback', {}, { args: { msgID: -31, code: 0, data: receipt } }));
        }
        if (this.mode !== 'sent') queueMicrotask(() => {
          // Advance only the receipt deadline after native submission; never sleep.
          for (const [id, timer] of this.pendingTimers) {
            if (timer.delay >= 4000) continue;
            this.pendingTimers.delete(id);
            timer.callback();
          }
        });
        break;
      }
      case 'getMessages': {
        const query = args[0];
        assert.ok(query && typeof query === 'object' && 'sessionID' in query);
        assert.equal(query.sessionID, 77);
        data = this.messages;
        break;
      }
      case 'getMessageByMsgId': data = this.messages.find(item => item.id === args[0]); break;
      default: throw new Error(`Unexpected native request: ${method}`);
    }
    queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 0, data }));
  }
}

const cards: Array<{ kind: string; contentType: number; content: Record<string, unknown>; send: (ops: Pick<IKK9Driver, 'sendAppMessage' | 'sendUrlCard' | 'sendBizMessage'>, options: SendOptions) => Promise<SendResult> }> = [
  { kind: 'app', contentType: 8, content: { title: 'App', content: '<p>native HTML</p>', linkUrl: '/app', pcAppCode: 'real-app' },
    send: (ops, options) => ops.sendAppMessage({ title: 'App', content: '<p>native HTML</p>', linkUrl: '/app', pcAppCode: 'real-app' }, options) },
  { kind: 'url', contentType: 10, content: { title: 'URL', summary: 'native summary', linkUrl: 'https://example.com', picUrl: '' },
    send: (ops, options) => ops.sendUrlCard({ title: 'URL', summary: 'native summary', linkUrl: 'https://example.com' }, options) },
  { kind: 'biz', contentType: 17, content: { title: 'Biz', content: 'native content', summary: ['detail'], bizUrl: '/task/1', bizType: 1 },
    send: (ops, options) => ops.sendBizMessage({ title: 'Biz', content: 'native content', summary: ['detail'], bizUrl: '/task/1', bizType: 1 }, options) },
];

for (const card of cards) {
  test(`${card.kind}: real native first-contact card uses exact login and confirmed session without preparatory text`, async () => {
    const native = new NativeRenderer();
    const ops = new BridgeMessageOps(native);
    const options = { operationId: `native-${card.kind}`, targetLoginName: ' 00AbC ', verifyTimeoutMs: 30 };
    const result = await card.send(ops, options);
    assert.equal(result.status, 'sent');
    assert.equal(result.messageId, '901');
    assert.equal(result.sessionId, '77');
    assert.equal(result.receipt?.sessionId, '77');
    assert.equal(native.sent.length, 1);
    assert.equal(native.drafts[0]?.sessionID, 0);
    assert.equal(native.sent[0]?.receiver, 2);
    assert.equal(native.sent[0]?.sessionType, 0);
    assert.equal(native.sent[0]?.contentType, card.contentType);
    assert.deepEqual(JSON.parse(JSON.stringify(native.sent[0]?.content)), card.content);
    assert.equal(native.calls.filter(call => call.method === 'getSessionBySessionID').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(native.calls.find(call => call.method === 'unionSearch')?.args[0])), { type: 'user', kwd: '00AbC', pageNo: 1, pageSize: 200 });
    assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0);
    assert.equal(native.window.__kairo_pending_sends?.size, 0);
    assert.equal((await card.send(ops, options)).status, 'sent');
    assert.equal(native.sent.length, 1, 'same operation never resubmits');
    await assert.rejects(card.send(ops, { ...options, targetLoginName: 'other-login' }), /operationId|指纹|意图|不同|冲突|不一致/);
    assert.equal(native.sent.length, 1);
  });

  test(`${card.kind}: explicit native session remains supported without login lookup`, async () => {
    const native = new NativeRenderer();
    const result = await card.send(new BridgeMessageOps(native), { targetSessionId: '77', operationId: `session-${card.kind}`, verifyTimeoutMs: 30 });
    assert.equal(result.status, 'sent');
    assert.equal(result.messageId, '901');
    assert.equal(result.receipt?.sessionId, '77');
    assert.equal(native.drafts[0]?.sessionID, 77);
    assert.equal(native.sent[0]?.contentType, card.contentType);
    assert.equal(native.sent.length, 1);
    assert.equal(native.calls.filter(call => call.method === 'unionSearch').length, 0);
  });


  test(`${card.kind}: empty, missing and dual targets fail before native evaluation`, async () => {
    const native = new NativeRenderer();
    const ops = new BridgeMessageOps(native);
    for (const [i, target] of [{}, { targetLoginName: '' }, { targetLoginName: '   ' },
      { targetLoginName: '00AbC', targetSessionId: '77' }, { targetLoginName: '00AbC', targetSessionId: '' }].entries()) {
      const result = await card.send(ops, { ...target, operationId: `invalid-${card.kind}-${i}` });
      assert.equal(result.status, 'failed');
      assert.equal(result.isPreTrigger, true);
    }
    assert.equal(native.calls.length, 0);
    assert.equal(native.budgets.length, 0);
  });

  test(`${card.kind}: absent or unrelated receipt remains unknown and retry never resends`, async () => {
    for (const mode of ['missing-receipt', 'foreign-receipt'] as const) {
      const native = new NativeRenderer();
      native.mode = mode;
      const ops = new BridgeMessageOps(native);
      const options = { operationId: `unknown-${card.kind}-${mode}`, targetLoginName: '00AbC', verifyTimeoutMs: 10 };
      assert.equal((await card.send(ops, options)).status, 'unknown');
      assert.equal((await card.send(ops, options)).status, 'unknown');
      assert.equal((await ops.getSendStatus(options.operationId)).status, 'unknown');
      assert.equal(native.sent.length, 1);
      assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0);
      assert.equal(native.window.__kairo_pending_sends?.size, 0);
    }
  });
}

test('directed native cards preserve exact profile, ambiguity and private-chat policy gates', async () => {
  for (const gate of ['not-found', 'ambiguous', 'profile-mismatch', 'restricted', 'self'] as const) {
    const native = new NativeRenderer();
    if (gate === 'not-found') native.users = [{ id: 9, login_name: '00AbC-near' }];
    if (gate === 'ambiguous') native.users.push({ id: 3, login_name: '00AbC' });
    if (gate === 'profile-mismatch') native.profileLogin = 'different';
    if (gate === 'restricted') native.limited = [2];
    if (gate === 'self') native.users = [{ id: 1, login_name: '00AbC' }];
    const result = await cards[0]!.send(new BridgeMessageOps(native), { targetLoginName: '00AbC', operationId: gate });
    assert.equal(result.status, 'failed');
    assert.equal(result.isPreTrigger, true);
    assert.equal(native.sent.length, 0);
    assert.equal(native.drafts.length, 0);
  }
});

test('login target is not silently accepted by unrelated text or media methods', async () => {
  const native = new NativeRenderer();
  const ops = new BridgeMessageOps(native);
  for (const [i, send] of [
    () => ops.sendText('text', { targetSessionId: '77', targetLoginName: '00AbC', operationId: 'unsupported-text' }),
    () => ops.sendChatRecord({ sourceSessionId: '77', msgArray: [{ messageId: '901', msgIdx: 5 }] }, { targetSessionId: '77', targetLoginName: '00AbC', operationId: 'unsupported-record' }),
  ].entries()) {
    assert.equal((await send()).status, 'failed', `unsupported target ${i}`);
  }
  assert.equal(native.calls.length, 0);
});

test('cancellation during directed native lookup cannot submit a draft or message', async () => {
  const native = new NativeRenderer();
  const ops = new BridgeMessageOps(native);
  native.onLookup = () => { void ops.cancelPendingSends(); };
  const result = await cards[0]!.send(ops, { targetLoginName: '00AbC', operationId: 'cancel-lookup' });
  assert.equal(result.status, 'failed');
  assert.equal(result.isPreTrigger, true);
  assert.equal(native.sent.length, 0);
  assert.equal(native.drafts.length, 0);
  assert.equal(native.window.__kairo_pending_sends?.size, 0);
});
