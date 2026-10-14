import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import type { IKK9Driver, SendOptions, SendResult } from '@kairo/driver';

const require = createRequire(import.meta.url);
const entry = pathToFileURL(require.resolve('@kairo/driver'));
type MediaOps = Pick<IKK9Driver, 'sendImage' | 'sendFile' | 'getSendStatus'> & { cancelPendingSends(): Promise<void> };
// Package exports intentionally hide internals; resolve the installed distributable at runtime.
const { BridgeMessageOps }: { BridgeMessageOps: new (cdp: MediaRenderer) => MediaOps } = await import(new URL('./bridge/message-ops.js', entry).href);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
const pngSignature = png.subarray(0, 8);
type ImageNode = { filepath: string; filepath_h: string; mimetype: string; width: number; height: number; size: number };
type FileContent = { filepath: string; filename: string; size: string; mimetype: string };
type NativeRow = { sender: number; receiver: number; sessionType: number; sessionID: number; msgFlag: string; id?: number; msgIdx?: number; status: string } & (
  { contentType: 3; content: FileContent } | { contentType: 4; content: { content: ImageNode[] } }
);
type Transfer = { id: string; directory: string; path: string; holders: number; readers: number; releaseRequested: boolean };

// Only Electron/native IPC and CDP are faked. Every transfer, renderer script,
// filesystem check, native payload, operation store and receipt correlator is real.
class MediaRenderer extends EventEmitter {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-media-test-'));
  calls: Array<{ method: string; args: unknown[] }> = [];
  messages: NativeRow[] = [];
  sent: NativeRow[] = [];
  drafts: NativeRow[] = [];
  deadlines: number[] = [];
  bytes: Buffer[] = [];
  budgets: number[] = [];
  timers = new Map<number, { delay: number; callback: () => void }>();
  nextTimerId = 0;
  mode: 'sent' | 'missing-receipt' | 'foreign-receipt' | 'unacknowledged-read' = 'sent';
  users = [{ id: 9, login_name: '00AbC-near' }, { id: 2, login_name: '00AbC' }];
  profileLogin = '00AbC';
  currentUserId = 1;
  limited: number[] = [];
  corruptArtwork = false;
  onLookup?: () => void;
  onChunk?: () => void;
  nativeRead?: { requestId: number; file: string };
  window: { ipcRenderer: MediaRenderer; require: (name: string) => unknown; __kairo_pending_sends?: Map<string, () => void>; __kairo_file_transfers?: Map<string, Transfer> };

  constructor() {
    super();
    this.window = { ipcRenderer: this, require: name => {
      if (name === 'os') return { tmpdir: () => this.root };
      if (name === 'file-type') return (bytes: Buffer) => bytes.subarray(0, 8).equals(pngSignature) ? { mime: 'image/png' } : undefined;
      if (name === 'electron') return { ipcRenderer: this, nativeImage: { createFromBuffer: (bytes: Buffer) => ({
        isEmpty: () => !bytes.subarray(0, 8).equals(pngSignature),
        getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
        resize: ({ width, height }: { width: number; height: number }) => {
          assert.equal(width, 1); assert.equal(height, 1);
          return { toPNG: () => Buffer.from(png) };
        },
      }) } };
      return require(name);
    } };
  }
  close() { fs.rmSync(this.root, { recursive: true, force: true }); }
  source(kind: string) {
    const file = path.join(this.root, kind === 'image' ? 'pixel.png' : 'report.bin');
    fs.writeFileSync(file, kind === 'image' ? png : Buffer.alloc(600123, 173));
    return file;
  }
  getStatus() { return 'connected'; }
  async evaluate(script: string, timeout?: number): Promise<unknown> {
    if (timeout !== undefined) this.budgets.push(timeout);
    const result = await runInNewContext(script, {
      window: this.window, AbortController, console,
      clearTimeout: (id?: number) => { if (id !== undefined) this.timers.delete(id); },
      setTimeout: (callback: () => void, delay: number) => {
        if (delay >= 18000 && delay < 60000) this.deadlines.push(delay);
        const id = ++this.nextTimerId;
        this.timers.set(id, { delay, callback });
        return id;
      },
    });
    if (script.includes('fs.writeSync')) this.onChunk?.();
    return result;
  }
  send(channel: string, request: { id: number; args: [string, ...unknown[]] }) {
    assert.equal(channel, 'data');
    const [method, ...args] = request.args;
    this.calls.push({ method, args });
    let data: unknown;
    switch (method) {
      case 'getMemberDetail':
        data = args.length ? { id: 2, login_name: this.profileLogin, name: 'Recipient' } : { id: this.currentUserId, name: 'Sender' };
        break;
      case 'unionSearch': this.onLookup?.(); data = { users: this.users }; break;
      case 'getUsersSessionLimit': data = this.limited; break;
      case 'getSessionBySessionID':
        assert.equal(args[0], 77, 'only the native confirmed formal session may be read');
        data = { id: 77, type: 0, typeID: 2, creater: 1, name: 'Recipient' };
        break;
      case 'sendingImgBeforeHandle': {
        const [thumbnail, source] = args;
        assert.equal(typeof thumbnail, 'string'); assert.equal(typeof source, 'string');
        if (typeof thumbnail !== 'string' || typeof source !== 'string') throw new Error('Invalid native image inputs');
        assert.deepEqual(fs.readFileSync(source), png, 'actual CDP-uploaded source bytes');
        const thumbPath = path.join(this.root, 'native-thumb.png');
        const artworkPath = path.join(this.root, 'native-artwork.png');
        fs.writeFileSync(thumbPath, Buffer.from(thumbnail, 'base64'));
        fs.copyFileSync(source, artworkPath);
        if (this.corruptArtwork) fs.writeFileSync(artworkPath, Buffer.from('not an image'));
        data = { thumbPath, artworkPath };
        break;
      }
      case 'insertSendBefoeMsg': {
        // The real renderer just constructed this in-process native draft.
        const draft = structuredClone(args[0]) as NativeRow;
        this.drafts.push(draft); data = { id: -31, msgIdx: 1 }; break;
      }
      case 'sendMessageNew': {
        // The real renderer constructed the same native payload as the draft above.
        const draft = structuredClone(args[0]) as NativeRow;
        this.sent.push(draft);
        const file = draft.contentType === 3 ? draft.content.filepath : draft.content.content[0].filepath_h;
        this.bytes.push(fs.readFileSync(file));
        const transfer = [...(this.window.__kairo_file_transfers?.values() ?? [])][0]!;
        assert.equal(transfer.holders, 1);
        assert.equal(transfer.readers, 1, 'native reads retain their file lease');
        if (this.mode === 'unacknowledged-read') this.nativeRead = { requestId: request.id, file };
        if (this.mode === 'sent' || this.mode === 'foreign-receipt') {
          const persisted = { ...draft, id: 901, msgIdx: 5, sessionID: 77, status: 'sent' };
          this.messages.push(persisted);
          const receipt = this.mode === 'foreign-receipt' ? { ...persisted, receiver: 99 } : persisted;
          queueMicrotask(() => this.emit('0-2-sendMsgCallback', {}, { args: { msgID: -31, code: 0, data: receipt } }));
        }
        if (this.mode !== 'sent') queueMicrotask(() => {
          for (const [id, timer] of this.timers) {
            if (timer.delay >= 4000) continue;
            this.timers.delete(id); timer.callback();
          }
        });
        if (this.mode === 'unacknowledged-read') return;
        data = null;
        break;
      }
      case 'getMessages': {
        const query = args[0];
        assert.ok(query && typeof query === 'object' && 'sessionID' in query);
        assert.equal(query.sessionID, 77); data = this.messages; break;
      }
      case 'getMessageByMsgId': data = this.messages.find(item => item.id === args[0]); break;
      default: throw new Error(`Unexpected native request: ${method}`);
    }
    queueMicrotask(() => this.emit(`data-${request.id}`, {}, { code: 0, data }));
  }
}

const media: Array<{ kind: string; contentType: number; send: (ops: MediaOps, file: string, options: SendOptions) => Promise<SendResult> }> = [
  { kind: 'image', contentType: 4, send: (ops, file, options) => ops.sendImage(file, options) },
  { kind: 'file', contentType: 3, send: (ops, file, options) => ops.sendFile(file, options) },
];

for (const item of media) {
  test(`${item.kind}: actual bytes reach exact first-contact receiver without preparatory text`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close());
    const source = native.source(item.kind);
    const ops = new BridgeMessageOps(native);
    const options = { targetLoginName: ' 00AbC ', operationId: `first-${item.kind}`, verifyTimeoutMs: 30 };
    const result = await item.send(ops, source, options);
    assert.equal(result.status, 'sent');
    assert.equal(result.messageId, '901');
    assert.equal(result.sessionId, '77');
    assert.equal(result.receipt?.sessionId, '77');
    assert.equal(native.sent.length, 1);
    assert.equal(native.sent[0]?.contentType, item.contentType);
    assert.equal(native.sent[0]?.receiver, 2);
    assert.equal(native.sent[0]?.sessionType, 0);
    assert.equal(native.drafts[0]?.sessionID, 0);
    assert.deepEqual(native.bytes[0], fs.readFileSync(source));
    const sent = native.sent[0]!;
    if (sent.contentType === 3) {
      assert.equal(sent.content.filename, 'report.bin');
      assert.equal(sent.content.size, '600123');
      assert.equal(sent.content.mimetype, 'application/octet-stream');
    } else {
      const image = sent.content.content[0]!;
      assert.equal(image.mimetype, 'image/png');
      assert.equal(image.width, 1); assert.equal(image.height, 1);
      assert.equal(image.size, png.length);
      assert.deepEqual(fs.readFileSync(image.filepath), png);
    }
    assert.equal(native.calls.filter(call => call.method === 'getSessionBySessionID').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(native.calls.find(call => call.method === 'unionSearch')?.args[0])), { type: 'user', kwd: '00AbC', pageNo: 1, pageSize: 200 });
    assert.ok(native.budgets.includes(20030), 'directed media gets the same targeted CDP budget as text/cards');
    assert.ok(native.deadlines.includes(18030), 'renderer cancellation deadline precedes CDP timeout');
    assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0);
    assert.equal(native.window.__kairo_pending_sends?.size, 0);
    assert.equal(native.window.__kairo_file_transfers?.size, 0);
    assert.equal(native.timers.size, 0);
    assert.equal((await item.send(ops, source, { ...options, targetLoginName: '00AbC' })).status, 'sent');
    await assert.rejects(item.send(ops, source, { ...options, targetLoginName: 'other' }), /operationId|指纹|意图|不同|冲突|不一致/);
    await assert.rejects(item.send(ops, source + '.different', options), /operationId|指纹|意图|不同|冲突|不一致/);
    assert.equal(native.sent.length, 1);
  });

  test(`${item.kind}: explicit native session sends unchanged without employee lookup`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close());
    const result = await item.send(new BridgeMessageOps(native), native.source(item.kind), { targetSessionId: '77', operationId: `session-${item.kind}`, verifyTimeoutMs: 30 });
    assert.equal(result.status, 'sent');
    assert.equal(result.receipt?.sessionId, '77');
    assert.equal(native.drafts[0]?.sessionID, 77);
    assert.equal(native.sent[0]?.contentType, item.contentType);
    assert.equal(native.calls.filter(call => call.method === 'unionSearch').length, 0);
    assert.equal(native.window.__kairo_file_transfers?.size, 0);
  });

  test(`${item.kind}: empty, missing and dual targets reject before CDP transfer`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close());
    const ops = new BridgeMessageOps(native);
    for (const [i, target] of [{}, { targetLoginName: '' }, { targetLoginName: '  ' },
      { targetLoginName: '00AbC', targetSessionId: '77' }, { targetLoginName: '00AbC', targetSessionId: '' }].entries()) {
      const result = await item.send(ops, native.source(item.kind), { ...target, operationId: `target-${item.kind}-${i}` });
      assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    }
    assert.equal(native.budgets.length, 0); assert.equal(native.calls.length, 0);
  });

  test(`${item.kind}: targeted whole-round deadline aborts lookup before draft and cleans lease`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close());
    native.onLookup = () => {
      for (const [id, timer] of native.timers) {
        if (timer.delay < 18000 || timer.delay >= 60000) continue;
        native.timers.delete(id); timer.callback();
      }
    };
    const result = await item.send(new BridgeMessageOps(native), native.source(item.kind), { targetLoginName: '00AbC', operationId: `${item.kind}-deadline` });
    assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    assert.equal(native.sent.length, 0); assert.equal(native.drafts.length, 0);
    assert.equal(native.window.__kairo_file_transfers?.size, 0);
    assert.equal(native.window.__kairo_pending_sends?.size, 0);
    assert.equal(native.timers.size, 0);
  });


  test(`${item.kind}: identity/policy gates reject and clean transferred files before any native draft`, async t => {
    for (const gate of ['not-found', 'ambiguous', 'profile-mismatch', 'restricted', 'self', 'missing-identity'] as const) {
      const native = new MediaRenderer(); t.after(() => native.close());
      if (gate === 'not-found') native.users = [{ id: 9, login_name: '00AbC-near' }];
      if (gate === 'ambiguous') native.users.push({ id: 3, login_name: '00AbC' });
      if (gate === 'profile-mismatch') native.profileLogin = 'other';
      if (gate === 'restricted') native.limited = [2];
      if (gate === 'self') native.users = [{ id: 1, login_name: '00AbC' }];
      if (gate === 'missing-identity') native.currentUserId = 0;
      const result = await item.send(new BridgeMessageOps(native), native.source(item.kind), { targetLoginName: '00AbC', operationId: `${item.kind}-${gate}` });
      assert.equal(result.status, 'failed', gate); assert.equal(result.isPreTrigger, true, gate);
      assert.equal(native.sent.length, 0); assert.equal(native.drafts.length, 0);
      assert.equal(native.window.__kairo_file_transfers?.size, 0);
      assert.equal(native.window.__kairo_pending_sends?.size, 0);
      assert.equal(native.timers.size, 0);
    }
  });

  test(`${item.kind}: absent/foreign receipt stays unknown and never retries native submission`, async t => {
    for (const mode of ['missing-receipt', 'foreign-receipt'] as const) {
      const native = new MediaRenderer(); t.after(() => native.close()); native.mode = mode;
      const ops = new BridgeMessageOps(native);
      const source = native.source(item.kind);
      const options = { targetLoginName: '00AbC', operationId: `${item.kind}-${mode}`, verifyTimeoutMs: 10 };
      assert.equal((await item.send(ops, source, options)).status, 'unknown');
      assert.equal((await item.send(ops, source, options)).status, 'unknown');
      assert.equal((await ops.getSendStatus(options.operationId)).status, 'unknown');
      assert.equal(native.sent.length, 1);
      assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0);
      assert.equal(native.window.__kairo_pending_sends?.size, 0);
      assert.equal(native.window.__kairo_file_transfers?.size, 0);
      assert.equal(native.timers.size, 0);
    }
  });

  test(`${item.kind}: unknown native read retains lease until real late completion`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close()); native.mode = 'unacknowledged-read';
    const ops = new BridgeMessageOps(native);
    const source = native.source(item.kind);
    const options = { targetLoginName: '00AbC', operationId: `${item.kind}-late-read`, verifyTimeoutMs: 10 };
    assert.equal((await item.send(ops, source, options)).status, 'unknown');
    const lease = [...native.window.__kairo_file_transfers!.values()][0]!;
    assert.equal(lease.holders, 0); assert.equal(lease.readers, 1); assert.equal(lease.releaseRequested, true);
    assert.ok(fs.existsSync(lease.path));
    assert.equal((await item.send(ops, source, options)).status, 'unknown');
    assert.equal(native.sent.length, 1);
    native.emit(`data-${native.nativeRead!.requestId}`, {}, { code: 0, data: null });
    assert.equal(native.window.__kairo_file_transfers?.size, 0);
    assert.equal(fs.existsSync(lease.directory), false);
    assert.equal(native.listenerCount('0-2-sendMsgCallback'), 0);
    assert.equal(native.timers.size, 0);
  });

  test(`${item.kind}: cancellation during upload cleans resources and cannot submit`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close());
    const ops = new BridgeMessageOps(native);
    native.onChunk = () => { void ops.cancelPendingSends(); };
    const result = await item.send(ops, native.source(item.kind), { targetLoginName: '00AbC', operationId: `${item.kind}-cancel-transfer` });
    assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    assert.equal(native.calls.length, 0); assert.equal(native.sent.length, 0);
    assert.equal(native.window.__kairo_file_transfers?.size, 0);
    assert.equal(native.timers.size, 0);
  });

  test(`${item.kind}: cancellation during exact lookup cleans leases without draft`, async t => {
    const native = new MediaRenderer(); t.after(() => native.close());
    const ops = new BridgeMessageOps(native);
    native.onLookup = () => { void ops.cancelPendingSends(); };
    const result = await item.send(ops, native.source(item.kind), { targetLoginName: '00AbC', operationId: `${item.kind}-cancel-lookup` });
    assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
    assert.equal(native.sent.length, 0); assert.equal(native.drafts.length, 0);
    assert.equal(native.window.__kairo_file_transfers?.size, 0);
    assert.equal(native.window.__kairo_pending_sends?.size, 0);
    assert.equal(native.timers.size, 0);
  });
}

test('directed image still validates real native artwork before draft submission', async t => {
  const native = new MediaRenderer(); t.after(() => native.close()); native.corruptArtwork = true;
  const result = await new BridgeMessageOps(native).sendImage(native.source('image'), { targetLoginName: '00AbC', operationId: 'corrupt-native-artwork' });
  assert.equal(result.status, 'failed'); assert.equal(result.isPreTrigger, true);
  assert.equal(native.sent.length, 0); assert.equal(native.drafts.length, 0);
  assert.equal(native.window.__kairo_file_transfers?.size, 0);
  assert.equal(native.window.__kairo_pending_sends?.size, 0);
});
