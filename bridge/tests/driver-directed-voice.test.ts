import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { FakeKK9Driver, KK9Driver } from '@kairo/driver';
import type { IKK9Driver, SendOptions } from '@kairo/driver';

const require = createRequire(import.meta.url);
const entry = pathToFileURL(require.resolve('@kairo/driver'));
type VoiceOps = Pick<IKK9Driver, 'sendVoice' | 'getSendStatus'> & { cancelPendingSends(): Promise<void> };
// Installed package exports hide internals; runtime resolution intentionally tests the consumer artifact.
const { BridgeMessageOps }: { BridgeMessageOps: new (cdp: VoiceRenderer) => VoiceOps } = await import(new URL('./bridge/message-ops.js', entry).href);
type NativeRow = { contentType: number; content: { duration: number; data: string }; sender: number; receiver: number; sessionType: number; sessionID: number; msgFlag: string; id?: number; msgIdx?: number; status: string };
const amrHeader = Buffer.from('#!AMR\n');
const amrFrame = Buffer.from('IyFBTVIKLA4ajszcQMium6nIdhHVkehAIOju', 'base64').subarray(6);

// Only the native AMR codec and Electron IPC are substituted. WAV decoding,
// voice preparation, all renderer scripts, receipts and operation replay are real.
class VoiceRenderer extends EventEmitter {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-voice-native-'));
  calls: Array<{ method: string; args: unknown[] }> = [];
  sent: NativeRow[] = [];
  drafts: NativeRow[] = [];
  messages: NativeRow[] = [];
  budgets: number[] = [];
  timers = new Map<number, { delay: number; callback: () => void }>();
  nextTimerId = 0;
  encodes = 0;
  mode: 'sent' | 'missing-receipt' | 'foreign-receipt' | 'business-failed' = 'sent';
  users = [{ id: 9, login_name: '00abc' }, { id: 8, login_name: 'AbC' }, { id: 2, login_name: '00AbC' }];
  profileLogin = '00AbC';
  profileId = 2;
  currentUserId = 1;
  limited: number[] = [];
  onLookup?: () => void;
  onEncode?: () => void;
  onSubmit?: () => void;
  window: { ipcRenderer: VoiceRenderer; process: { resourcesPath: string }; require: (name: string) => unknown; __kairo_pending_sends?: Map<string, () => void> };

  constructor() {
    super();
    this.window = { ipcRenderer: this, process: { resourcesPath: '/offline-kk9/resources' }, require: name => {
      if (name.endsWith('amrnb')) return {
        Mode: { MR795: 5 },
        encode: (pcm: Float32Array, rate: number, mode: number) => {
          assert.equal(rate, 8000); assert.equal(mode, 5);
          assert.ok(pcm.some(sample => sample > 0));
          this.encodes++; this.onEncode?.();
          return Buffer.concat([amrHeader, ...Array.from({ length: pcm.length / 160 - 1 }, () => amrFrame)]);
        },
        decode: (encoded: Uint8Array) => new Float32Array((encoded.length - 6) / amrFrame.length * 160),
      };
      if (name === 'electron') return { ipcRenderer: this };
      return require(name);
    } };
  }
  close() { fs.rmSync(this.root, { recursive: true, force: true }); }
  source() {
    const wav = Buffer.alloc(44 + 800 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(1600, 40);
    for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(8000, offset);
    const file = path.join(this.root, 'voice.wav'); fs.writeFileSync(file, wav); return file;
  }
  getStatus() { return 'connected'; }
  async evaluate(script: string, timeout?: number): Promise<unknown> {
    if (timeout !== undefined) this.budgets.push(timeout);
    return runInNewContext(script, {
      window: this.window, AbortController,
      clearTimeout: (id?: number) => { if (id !== undefined) this.timers.delete(id); },
      setTimeout: (callback: () => void, delay: number) => {
        const id = ++this.nextTimerId; this.timers.set(id, { delay, callback }); return id;
      },
    });
  }
  send(channel: string, request: { id: number; args: [string, ...unknown[]] }) {
    assert.equal(channel, 'data');
    const [method, ...args] = request.args; this.calls.push({ method, args });
    let data: unknown;
    switch (method) {
      case 'getMemberDetail': data = args.length ? { id: this.profileId, login_name: this.profileLogin, name: 'Recipient' } : { id: this.currentUserId, name: 'Sender' }; break;
      case 'unionSearch': this.onLookup?.(); data = { users: this.users }; break;
      case 'getUsersSessionLimit': data = this.limited; break;
      case 'getSessionBySessionID':
        assert.equal(args[0], 77, 'only a formal confirmed session may be consulted');
        data = { id: 77, type: 0, typeID: 2, creater: 1, name: 'Recipient' }; break;
      case 'insertSendBefoeMsg': this.drafts.push(structuredClone(args[0]) as NativeRow); data = { id: -31, msgIdx: 1 }; break;
      case 'sendMessageNew': {
        const draft = structuredClone(args[0]) as NativeRow; this.sent.push(draft); data = null;
        this.onSubmit?.();
        if (this.mode !== 'missing-receipt') {
          const persisted = { ...draft, id: 901, msgIdx: 5, sessionID: 77, status: 'sent' };
          if (this.mode !== 'business-failed') this.messages.push(persisted);
          const receipt = this.mode === 'foreign-receipt' ? { ...persisted, receiver: 99 } : persisted;
          queueMicrotask(() => this.emit('0-2-sendMsgCallback', {}, { args: { msgID: -31, code: this.mode === 'business-failed' ? 617 : 0, data: receipt } }));
        }
        if (this.mode !== 'sent') queueMicrotask(() => {
          for (const [id, timer] of this.timers) {
            if (timer.delay >= 4000) continue;
            this.timers.delete(id); timer.callback();
          }
        });
        break;
      }
      case 'getMessageByMsgId': data = this.messages.find(row => row.id === args[0]); break;
      case 'getMessages': {
        const query = args[0];
        assert.ok(query && typeof query === 'object' && 'sessionID' in query);
        assert.equal(query.sessionID, 77); data = this.messages; break;
      }
      default: throw new Error(`Unexpected native request: ${method}`);
    }
    queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 0, data }));
  }
}

test('voice: text synthesis uses real preparation and native voice renderer, never a preparatory text send', async t => {
  const native = new VoiceRenderer(); t.after(() => native.close());
  const audio = fs.readFileSync(native.source());
  // Stub only the external TTS service; the installed Driver and codec renderer still execute.
  const { EdgeTTS } = createRequire(entry)('node-edge-tts');
  const syntheses: Array<{ text: string; file: string }> = [];
  t.mock.method(EdgeTTS.prototype, 'ttsPromise', async (text: string, file: string) => {
    syntheses.push({ text, file }); fs.writeFileSync(file, audio);
  });
  const ops = new BridgeMessageOps(native);
  const input = { text: '  读出 <研发&财务>\n正文  ' };
  const options = { targetLoginName: '00AbC', operationId: 'voice-tts-native', verifyTimeoutMs: 30 };
  const result = await ops.sendVoice(input, options);
  assert.equal(result.status, 'sent'); assert.equal(result.sessionId, '77');
  assert.deepEqual(syntheses.map(call => call.text), [input.text.trim()]);
  assert.equal(fs.existsSync(syntheses[0]!.file), false);
  assert.equal(fs.existsSync(path.dirname(syntheses[0]!.file)), false);
  assert.equal(native.sent.length, 1); assert.equal(native.sent[0]?.contentType, 2); assert.equal(native.encodes, 1);
  assert.equal((await ops.sendVoice(input, options)).status, 'sent');
  assert.equal(syntheses.length, 1); assert.equal(native.sent.length, 1);
});

test('voice: exact first-contact renderer and formal receipt', async t => {
    const native = new VoiceRenderer(); t.after(() => native.close());
    const ops = new BridgeMessageOps(native);
    const input = { filePath: native.source() };
    const options = { targetLoginName: ' 00AbC ', operationId: 'voice-first-contact', verifyTimeoutMs: 30 };
    const result = await ops.sendVoice(input, options);
    assert.equal(result.status, 'sent'); assert.equal(result.messageId, '901'); assert.equal(result.sessionId, '77');
    assert.equal(result.receipt?.sessionId, '77'); assert.equal(result.receipt?.messageId, '901');
    assert.equal(native.sent.length, 1); assert.equal(native.sent[0]?.contentType, 2);
    assert.equal(native.sent[0]?.receiver, 2); assert.equal(native.sent[0]?.sessionType, 0); assert.equal(native.drafts[0]?.sessionID, 0);
    assert.equal(native.sent[0]?.content.duration, 1);
    assert.ok(Buffer.from(native.sent[0]!.content.data, 'base64').subarray(0, 6).equals(amrHeader));
    assert.deepEqual(Object.keys(native.sent[0]!.content).sort(), ['data', 'duration']);
    assert.deepEqual(JSON.parse(JSON.stringify(native.calls.find(call => call.method === 'unionSearch')?.args[0])), { type: 'user', kwd: '00AbC', pageNo: 1, pageSize: 200 });
    assert.ok(native.budgets.includes(20030));
    assert.equal((await ops.sendVoice(input, { ...options, targetLoginName: '00AbC' })).status, 'sent');
    await assert.rejects(ops.sendVoice(input, { ...options, targetLoginName: '00abc' }), /operationId|指纹|fingerprint|冲突/);
    await assert.rejects(ops.sendVoice({ filePath: input.filePath + '.different' }, options), /operationId|指纹|fingerprint|冲突/);
    assert.equal(native.sent.length, 1); assert.equal(native.encodes, 1);
    assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0); assert.equal(native.window.__kairo_pending_sends?.size, 0); assert.equal(native.timers.size, 0);
  });

test('voice: explicit session remains unchanged and bypasses employee lookup', async t => {
  const native = new VoiceRenderer(); t.after(() => native.close());
  const result = await new BridgeMessageOps(native).sendVoice({ filePath: native.source() }, { targetSessionId: '77', operationId: 'voice-session', verifyTimeoutMs: 30 });
  assert.equal(result.status, 'sent'); assert.equal(native.drafts[0]?.sessionID, 77);
  assert.equal(native.calls.filter(call => call.method === 'unionSearch').length, 0); assert.equal(native.sent[0]?.contentType, 2);
});

for (const mode of ['missing-receipt', 'foreign-receipt', 'business-failed'] as const) {
  test(`voice: ${mode} cannot become success or resubmit`, async t => {
    const native = new VoiceRenderer(); t.after(() => native.close()); native.mode = mode;
    const ops = new BridgeMessageOps(native); const input = { filePath: native.source() };
    const options = { targetLoginName: '00AbC', operationId: `voice-${mode}`, verifyTimeoutMs: 30 };
    const result = await ops.sendVoice(input, options);
    assert.equal(result.status, mode === 'business-failed' ? 'failed' : 'unknown');
    if (mode === 'business-failed') assert.equal(result.nativeCode, 617);
    native.mode = 'sent';
    assert.equal((await ops.getSendStatus(options.operationId)).status, result.status);
    assert.equal((await ops.sendVoice(input, options)).status, result.status);
    assert.equal(native.sent.length, 1); assert.equal(native.encodes, 1); assert.equal(native.timers.size, 0);
  });
}

for (const boundary of ['wrong-case', 'missing-zeroes', 'profile-login', 'profile-uid', 'ambiguous', 'self', 'restricted'] as const) {
  test(`voice: ${boundary} rejects before draft or submission`, async t => {
    const native = new VoiceRenderer(); t.after(() => native.close());
    if (boundary === 'wrong-case') native.users = [{ id: 2, login_name: '00abc' }];
    if (boundary === 'missing-zeroes') native.users = [{ id: 2, login_name: 'AbC' }];
    if (boundary === 'profile-login') native.profileLogin = '00abc';
    if (boundary === 'profile-uid') native.profileId = 99;
    if (boundary === 'ambiguous') native.users.push({ id: 5, login_name: '00AbC' });
    if (boundary === 'self') native.currentUserId = 2;
    if (boundary === 'restricted') native.limited = [2];
    const result = await new BridgeMessageOps(native).sendVoice({ filePath: native.source() }, { targetLoginName: '00AbC', operationId: `voice-${boundary}` });
    assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    assert.equal(native.drafts.length, 0); assert.equal(native.sent.length, 0); assert.equal(native.timers.size, 0);
  });
}

for (const phase of ['prepare', 'lookup', 'deadline'] as const) {
  test(`voice: cancellation during ${phase} cannot submit`, async t => {
    const native = new VoiceRenderer(); t.after(() => native.close()); const ops = new BridgeMessageOps(native);
    const cancel = () => { void ops.cancelPendingSends(); };
    if (phase === 'prepare') native.onEncode = cancel;
    if (phase === 'lookup') native.onLookup = cancel;
    if (phase === 'deadline') native.onLookup = () => {
      for (const [id, timer] of native.timers) if (timer.delay >= 18000 && timer.delay < 60000) { native.timers.delete(id); timer.callback(); }
    };
    const result = await ops.sendVoice({ filePath: native.source() }, { targetLoginName: '00AbC', operationId: `voice-cancel-${phase}` });
    assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    assert.equal(native.drafts.length, 0); assert.equal(native.sent.length, 0); assert.equal(native.timers.size, 0);
  });
}

test('voice: cancellation after native submission is unknown, removes listeners and never resubmits', async t => {
  const native = new VoiceRenderer(); t.after(() => native.close()); native.mode = 'missing-receipt';
  const ops = new BridgeMessageOps(native);
  native.onSubmit = () => { void ops.cancelPendingSends(); };
  const input = { filePath: native.source() };
  const options = { targetLoginName: '00AbC', operationId: 'voice-cancel-after-submit', verifyTimeoutMs: 30 };
  const result = await ops.sendVoice(input, options);
  assert.equal(result.status, 'unknown'); assert.equal(result.isPreTrigger, false);
  assert.equal((await ops.sendVoice(input, options)).status, 'unknown');
  assert.equal(native.sent.length, 1); assert.equal(native.encodes, 1);
  assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0);
  assert.equal(native.window.__kairo_pending_sends?.size, 0); assert.equal(native.timers.size, 0);
});

test('voice: malformed targets reject without even preparing audio', async () => {
  const native = new VoiceRenderer(); try {
    const ops = new BridgeMessageOps(native);
    for (const [index, target] of [{}, { targetLoginName: '' }, { targetLoginName: ' ' }, { targetLoginName: '00AbC', targetSessionId: '77' }].entries()) {
      const result = await ops.sendVoice({ filePath: '/does-not-exist.wav' }, { ...target, operationId: `voice-target-${index}` });
      assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    }
    assert.equal(native.budgets.length, 0); assert.equal(native.encodes, 0);
  } finally { native.close(); }
});

test('voice: public Driver recall uses native confirmed session, not a window or zero draft session', async t => {
  const native = new VoiceRenderer(); t.after(() => native.close());
  const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: 'renderer.html' } });
  Object.defineProperty(driver, 'bridgeMessageOps', { value: new BridgeMessageOps(native) });
  const recalls: unknown[][] = [];
  driver.recallMessage = async (...args) => { recalls.push(args); return true; };
  const result = await driver.sendVoice({ filePath: native.source() }, { targetLoginName: '00AbC', operationId: 'voice-public-recall', verifyTimeoutMs: 30 });
  assert.equal(result.status, 'sent'); assert.equal(typeof result.recall, 'function');
  assert.equal(await result.recall?.(), true); assert.deepEqual(recalls, [['901', '77']]);
});

test('voice: Fake uses exact employee identity, first contact, existing session and unknown replay', async () => {
  const driver = new FakeKK9Driver(); driver.setCurrentUserId('1');
  driver.setEmployees([{ id: '2', name: 'Recipient', loginName: '00AbC' }]);
  for (const login of ['00abc', 'AbC']) {
    assert.equal((await driver.sendVoice({ text: '正文' }, { targetLoginName: login, operationId: `fake-${login}` })).status, 'failed');
  }
  const first = await driver.sendVoice({ text: '正文' }, { targetLoginName: '00AbC', operationId: 'fake-first' });
  assert.equal(first.status, 'sent'); assert.ok(first.sessionId);
  const next = await driver.sendVoice({ text: '第二条' }, { targetLoginName: '00AbC', operationId: 'fake-existing' });
  assert.equal(next.status, 'sent'); assert.equal(next.sessionId, first.sessionId);
  assert.equal((await driver.getSessions()).length, 1);
  driver.setSendBehavior({ mode: 'post_trigger_timeout' });
  const options: SendOptions = { targetLoginName: '00AbC', operationId: 'fake-unknown' };
  assert.equal((await driver.sendVoice({ text: 'unknown' }, options)).status, 'unknown');
  driver.setSendBehavior({ mode: 'success' });
  assert.equal((await driver.sendVoice({ text: 'unknown' }, options)).status, 'unknown');
  await assert.rejects(driver.sendVoice({ text: 'changed' }, options), /fingerprint/);
  assert.equal(driver.recordedCalls.length, 3); assert.ok(driver.recordedCalls.every(call => call.type === 'voice'));
});
