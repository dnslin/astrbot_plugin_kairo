import assert from 'node:assert/strict';
import * as nodeBuffer from 'node:buffer';
import * as nodeCrypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as nodeUrl from 'node:url';
import { runInNewContext } from 'node:vm';
import type { IKK9Driver, KK9FileInfo, KK9ImageInfo, KK9Message } from '@kairo/driver';
import { Attachments } from '../src/attachments.js';
import type { WireMessage } from '../src/attachments.js';
import { parseConfig } from '../src/config.js';

const require = createRequire(import.meta.url);
const entry = nodeUrl.pathToFileURL(require.resolve('@kairo/driver'));
// Package exports hide these internals, so static imports cannot address them;
// resolve and exercise the installed distributable at runtime.
const { saveNativeFile, downloadNativeImage }: {
  saveNativeFile: (cdp: FileRenderer, file: KK9FileInfo, target: string) => Promise<string>;
  downloadNativeImage: (cdp: FileRenderer, image: KK9ImageInfo, target: string) => Promise<string>;
} = await import(new URL('./bridge/attachment-ops.js', entry).href);
const { normalizeNativeMessage }: {
  normalizeNativeMessage: (raw: unknown) => KK9Message[];
} = await import(new URL('./bridge/converter.js', entry).href);

type DownloadInput = { uri: string; fullPath: string; override: boolean };
type NativeReply = { code: number; data?: { path: string }; error?: string };
type Transfer = { directory: string; path: string; holders: number; readers: number };
const resources = new Map([
  ['groupc7/first/23.txt', Buffer.from('abc')],
  ['groupc7/second/23.txt', Buffer.alloc(600123, 173)],
]);
const fileId = 'a'.repeat(32);

// Only CDP and native Electron IPC are substitutes. evaluate always executes the
// actual renderer program; all stat/open/read/write/rename/cleanup operations use fs.
class FileRenderer extends EventEmitter {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-file-receive-'));
  readonly remoteRoot = path.join(this.root, 'kk9-temp');
  readonly cacheRoot = path.join(this.root, 'kk9-cache');
  readonly targetDirectory = path.join(this.root, 'driver-target');
  readonly target = path.join(this.targetDirectory, '23.txt');
  readonly downloads: DownloadInput[] = [];
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  private nextTimerId = 0;
  respond?: (input: DownloadInput) => NativeReply;
  readonly window: {
    ipcRenderer: FileRenderer;
    require: (name: string) => unknown;
    __kairo_file_transfers?: Map<string, Transfer>;
  };

  constructor() {
    super();
    for (const directory of [this.remoteRoot, this.cacheRoot, this.targetDirectory]) fs.mkdirSync(directory);
    const modules: Record<string, unknown> = {
      fs, path, os: { ...os, tmpdir: () => this.remoteRoot },
      buffer: nodeBuffer, crypto: nodeCrypto, url: nodeUrl, electron: { ipcRenderer: this },
    };
    this.window = { ipcRenderer: this, require: name => {
      const module = modules[name.replace(/^node:/, '')];
      assert.ok(module, `Unexpected renderer module: ${name}`);
      return module;
    } };
  }

  getStatus() { return 'connected'; }

  async evaluate(script: string): Promise<unknown> {
    return await runInNewContext(script, {
      window: this.window, Buffer, URL, AbortController, console,
      setTimeout: (callback: () => void, delay: number) => {
        const id = ++this.nextTimerId;
        this.timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id?: number) => { if (id !== undefined) this.timers.delete(id); },
    });
  }

  send(channel: string, request: { id: number; args: [string, DownloadInput] }) {
    assert.equal(channel, 'data');
    assert.equal(request.args.length, 2);
    assert.equal(request.args[0], 'download');
    const input = request.args[1];
    assert.deepEqual(Object.keys(input).sort(), ['fullPath', 'override', 'uri']);
    assert.equal(typeof input.uri, 'string');
    assert.equal(typeof input.fullPath, 'string');
    assert.equal(input.override, true);
    assert.equal(path.dirname(path.dirname(input.fullPath)), this.remoteRoot);
    assert.notEqual(input.fullPath, this.target, 'native writes only into a KK9 temporary lease');
    const transfer = [...(this.window.__kairo_file_transfers?.values() ?? [])].find(item => item.path === input.fullPath);
    assert.ok(transfer, 'native download retains a real remote transfer');
    assert.equal(transfer.holders, 1);
    assert.equal(transfer.readers, 1);
    this.downloads.push(structuredClone(input));
    let reply: NativeReply;
    if (this.respond) reply = this.respond(input);
    else {
      const bytes = resources.get(input.uri);
      if (bytes) {
        fs.writeFileSync(input.fullPath, bytes);
        reply = { code: 0, data: { path: input.fullPath } };
      } else reply = { code: 404, error: 'Unknown native resource' };
    }
    queueMicrotask(() => this.emit(`data-${request.id}`, {}, reply));
  }

  assertClean() {
    assert.equal(this.eventNames().length, 0, 'native IPC listeners must be removed');
    assert.equal(this.timers.size, 0, 'renderer timers must be cleared');
    assert.equal(this.window.__kairo_file_transfers?.size ?? 0, 0, 'remote leases must be released');
    assert.deepEqual(fs.readdirSync(this.remoteRoot), [], 'KK9 temporary directories must be removed');
    assert.ok(fs.readdirSync(this.root, { recursive: true }).every(name => !String(name).endsWith('.part')), 'no partial host files remain');
  }
}

function nativeMessage(uri?: string, filePath = '', encoding: 'object' | 'json' = 'object'): KK9Message {
  const content = { filename: '23.txt', size: String(resources.get(uri ?? '')?.length ?? 3), mimetype: 'text/plain', uri, filepath: filePath };
  const [message] = normalizeNativeMessage({
    id: 101, sessionID: 93001, sessionType: 1, sender: 91002,
    senderName: '员工', contentType: 3, timestamp: 1700000000000,
    content: encoding === 'json' ? JSON.stringify(content) : content,
  });
  assert.ok(message, 'contentType=3 must normalize into a message');
  assert.equal(message.messageType, 'file');
  assert.equal(message.content, '[文件: 23.txt]');
  assert.equal(message.fileInfo?.fileName, '23.txt');
  return message;
}

function assertPrivateSourcesRemoved(message: WireMessage) {
  assert.equal(Object.hasOwn(message, 'raw'), false);
  const info = wireFileInfo(message);
  for (const field of ['uri', 'filePath', 'filepath', 'path', 'url']) assert.equal(Object.hasOwn(info, field), false, `wire fileInfo must omit ${field}`);
}

function wireFileInfo(message: WireMessage): Record<string, unknown> {
  const info = message.fileInfo;
  assert.ok(info && typeof info === 'object' && !Array.isArray(info));
  return info as Record<string, unknown>;
}

async function withFixture(run: (fixture: {
  native: FileRenderer;
  attachments: Attachments;
  driver: Pick<IKK9Driver, 'saveFile' | 'downloadImage'>;
  uploads: Array<{ bytes: Buffer; name: string | null }>;
}) => Promise<void>) {
  const native = new FileRenderer();
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, path.join(native.root, 'bridge'));
  const uploads: Array<{ bytes: Buffer; name: string | null }> = [];
  const attachments = new Attachments(config, (async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, config.serverUrl);
    assert.equal(target.pathname, '/files');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${config.token}`);
    assert.ok(init?.body instanceof Uint8Array);
    uploads.push({ bytes: Buffer.from(init.body), name: target.searchParams.get('name') });
    return Response.json({ file_id: fileId });
  }) as typeof fetch);
  const driver = {
    saveFile: (file: KK9FileInfo, target: string) => saveNativeFile(native, file, target),
    downloadImage: (image: KK9ImageInfo, target: string) => downloadNativeImage(native, image, target),
  };
  try {
    await run({ native, attachments, driver, uploads });
    native.assertClean();
  } finally {
    native.removeAllListeners();
    native.timers.clear();
    fs.rmSync(native.root, { recursive: true, force: true });
  }
}

function saveFailure(reason: RegExp): (error: unknown) => boolean {
  return error => {
    assert.ok(error && typeof error === 'object' && 'code' in error && 'message' in error);
    assert.equal(error.code, 'FILE_SAVE_FAILED');
    assert.match(String(error.message), reason);
    return true;
  };
}

for (const encoding of ['object', 'json'] as const) {
  test(`uri-only ${encoding} content uploads distinct native bytes for same-name files without source leakage`, async () => {
    await withFixture(async ({ native, attachments, driver, uploads }) => {
      for (const [uri, bytes] of resources) {
        const message = nativeMessage(uri, '', encoding);
        assert.ok(message.fileInfo && 'uri' in message.fileInfo, 'native normalization must retain the download URI');
        assert.equal(message.fileInfo.uri, uri);
        const result = await attachments.normalize(message, driver);
        assert.equal(result.content, '[文件: 23.txt]');
        assertPrivateSourcesRemoved(result);
        assert.deepEqual(result.fileInfo, {
          fileName: '23.txt', fileSize: String(bytes.length), fileExt: '.txt',
          file_id: fileId, name: '23.txt', size: bytes.length,
        });
        assert.deepEqual(uploads.at(-1), { bytes, name: '23.txt' });
        assert.ok(!JSON.stringify(result).includes(uri));
      }
      assert.equal(uploads.length, 2);
      assert.deepEqual(native.downloads.map(input => input.uri), [...resources.keys()]);
    });
  });
}

test('a real KK9 cached file wins over URI download and uploads its actual bytes', async () => {
  await withFixture(async ({ native, attachments, driver, uploads }) => {
    const cache = path.join(native.cacheRoot, '23.txt');
    const bytes = Buffer.from('cached bytes differ from the URI resource');
    fs.writeFileSync(cache, bytes);
    for (const source of [cache, nodeUrl.pathToFileURL(cache).href]) {
      await driver.saveFile({ fileName: '23.txt', filePath: source, uri: 'groupc7/first/23.txt' }, native.target);
      assert.deepEqual(fs.readFileSync(native.target), bytes);
      const result = await attachments.normalize(nativeMessage('groupc7/first/23.txt', source), driver);
      assert.deepEqual(uploads.at(-1), { bytes, name: '23.txt' });
      assert.equal(wireFileInfo(result).file_id, fileId);
      assertPrivateSourcesRemoved(result);
    }
    assert.equal(uploads.length, 2);
    assert.equal(native.downloads.length, 0);
    assert.deepEqual(fs.readFileSync(cache), bytes);
  });
});

test('a stale ENOENT cache falls back to exactly the native file URI', async () => {
  await withFixture(async ({ native, attachments, driver, uploads }) => {
    const uri = 'groupc7/second/23.txt';
    const stale = path.join(native.cacheRoot, 'missing', '23.txt');
    const result = await attachments.normalize(nativeMessage(uri, stale), driver);
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads, [{ bytes: resources.get(uri), name: '23.txt' }]);
    assert.equal(wireFileInfo(result).file_id, fileId);
    assertPrivateSourcesRemoved(result);
    assert.deepEqual(native.downloads.map(input => input.uri), [uri]);
    assert.equal(fs.existsSync(stale), false);
  });
});

test('native 403 preserves FILE_SAVE_FAILED, the reason and message body without uploading or replacing a target', async () => {
  await withFixture(async ({ native, attachments, driver, uploads }) => {
    fs.writeFileSync(native.target, 'previous successful target');
    native.respond = input => {
      fs.writeFileSync(input.fullPath, 'incomplete native download');
      return { code: 403, error: '附件已过期，拒绝下载' };
    };
    const message = nativeMessage('groupc7/expired/23.txt');
    await assert.rejects(driver.saveFile(message.fileInfo!, native.target), saveFailure(/403.*附件已过期，拒绝下载/));
    const result = await attachments.normalize({ ...message, content: '请保留附件正文' }, driver);
    const info = wireFileInfo(result);
    assert.equal(result.content, '请保留附件正文');
    assert.match(String(info.attachment_error), /403.*附件已过期，拒绝下载/);
    assert.equal(info.file_id, undefined);
    assertPrivateSourcesRemoved(result);
    assert.equal(uploads.length, 0);
    assert.equal(fs.readFileSync(native.target, 'utf8'), 'previous successful target');
    assert.deepEqual(fs.readdirSync(native.targetDirectory), ['23.txt']);
  });
});

test('a non-ENOENT filesystem cache error must not silently download or replace an existing target', async () => {
  await withFixture(async ({ native, attachments, driver, uploads }) => {
    fs.writeFileSync(native.target, 'previous successful target');
    // A NUL path produces a real, deterministic fs ERR_INVALID_ARG_VALUE on every
    // platform, without faking fs or depending on the account permission model.
    const invalidCache = path.join(native.cacheRoot, 'invalid\0cache.txt');
    const message = nativeMessage('groupc7/first/23.txt', invalidCache);
    await assert.rejects(driver.saveFile(message.fileInfo!, native.target), saveFailure(/null bytes/i));
    const result = await attachments.normalize(message, driver);
    assert.match(String(wireFileInfo(result).attachment_error), /null bytes/i);
    assertPrivateSourcesRemoved(result);
    assert.equal(native.downloads.length, 0);
    assert.equal(uploads.length, 0);
    assert.equal(fs.readFileSync(native.target, 'utf8'), 'previous successful target');
  });
});

for (const mode of ['missing-file', 'wrong-returned-path'] as const) {
  test(`native code0 with ${mode} is rejected and temporary files are cleaned`, async () => {
    await withFixture(async ({ native, attachments, driver, uploads }) => {
      fs.writeFileSync(native.target, 'previous successful target');
      native.respond = input => {
        if (mode === 'missing-file') fs.rmSync(input.fullPath);
        else fs.writeFileSync(input.fullPath, 'must not be published');
        return { code: 0, data: { path: mode === 'missing-file' ? input.fullPath : native.target } };
      };
      const message = nativeMessage('groupc7/first/23.txt');
      const reason = mode === 'missing-file' ? /ENOENT/ : /KK9.*路径/;
      await assert.rejects(driver.saveFile(message.fileInfo!, native.target), saveFailure(reason));
      const result = await attachments.normalize(message, driver);
      const info = wireFileInfo(result);
      assert.match(String(info.attachment_error), reason);
      assert.equal(info.file_id, undefined);
      assertPrivateSourcesRemoved(result);
      assert.equal(uploads.length, 0);
      assert.equal(fs.readFileSync(native.target, 'utf8'), 'previous successful target');
      assert.deepEqual(fs.readdirSync(native.targetDirectory), ['23.txt']);
    });
  });
}

test('a file with neither a cache nor URI retains FILE_SAVE_FAILED and does not discard its message body', async () => {
  await withFixture(async ({ native, attachments, driver, uploads }) => {
    const message = nativeMessage();
    await assert.rejects(driver.saveFile(message.fileInfo!, native.target), saveFailure(/缺少|没有|尚未缓存/));
    const result = await attachments.normalize({ ...message, content: '附件正文仍需展示' }, driver);
    assert.equal(result.content, '附件正文仍需展示');
    assert.ok(wireFileInfo(result).attachment_error);
    assertPrivateSourcesRemoved(result);
    assert.equal(native.downloads.length, 0);
    assert.equal(uploads.length, 0);
    assert.equal(fs.existsSync(native.target), false);
  });
});
