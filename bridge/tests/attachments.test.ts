import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FakeKK9Driver, type KK9Message } from '@kairo/driver';
import { Attachments, safeFilename } from '../src/attachments.js';
import { parseConfig } from '../src/config.js';

test('中文长文件名按字节截断并保留扩展名', () => {
  const name = safeFilename('报'.repeat(90) + '.pdf');
  assert.ok(Buffer.byteLength(name, 'utf8') <= 180);
  assert.ok(name.endsWith('.pdf'));
});

test('上传只读取桥接自管缓存，不能通过符号链接越界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-file-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const cache = join(config.dataDir, 'attachments');
  let requests = 0;
  const files = new Attachments(config, (async (_url, init) => {
    requests++;
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${config.token}`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  try {
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'ok.txt'), 'safe');
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(root, join(cache, 'escape'), 'junction');
    assert.equal((await files.upload(join(cache, 'ok.txt'), 'file')).size, 4);
    await assert.rejects(files.upload(join(root, 'secret.txt'), 'file'), /桥接附件缓存/);
    await assert.rejects(files.upload(join(cache, 'escape', 'secret.txt'), 'file'), /桥接附件缓存/);
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('未缓存附件保留说明并移除本地路径、URL和 raw，不阻断文本', async () => {
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, '/tmp');
  const files = new Attachments(config);
  const result = await files.normalize({ id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '请看附件', time: '', isMe: false, timestamp: 1, raw: { private: true }, images: [{ url: 'https://private/image', uri: 'private-uri' }], fileInfo: { fileName: 'doc.pdf' } } as KK9Message, new FakeKK9Driver());
  assert.equal(result.content, '请看附件');
  assert.equal(result.raw, undefined);
  const picture = (result.images as Record<string, unknown>[])[0]!;
  assert.equal(picture.url, undefined);
  assert.equal(picture.file_id, undefined);
  assert.match(String(picture.attachment_error), /private-uri/);
});

test('下载附件只请求固定服务的 file_id 并使用安全且稳定的本地名称', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-download-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const urls: string[] = [];
  const files = new Attachments(config, (async (url) => { urls.push(String(url)); return new Response('file-body'); }) as typeof fetch);
  try {
    const target = await files.download('b'.repeat(32), 'file', '../../document.txt');
    assert.equal(await readFile(target, 'utf8'), 'file-body');
    assert.equal(await files.download('b'.repeat(32), 'file', '../../document.txt'), target);
    assert.deepEqual(urls, [`http://127.0.0.1:6190/files/${'b'.repeat(32)}`]);
    assert.equal(safeFilename('C:\\secret\\CON.txt'), '_CON.txt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('消息路径即使在桥接本地存在，也只上传 Driver 提供的实际字节', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-cached-inbound-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const local = join(config.dataDir, 'attachments');
  const imagePath = join(local, 'picture.png');
  const filePath = join(local, 'document.txt');
  const original = Buffer.from('remote original');
  const document = Buffer.from('真实远程附件');
  const driver = new FakeKK9Driver();
  driver.setCachedFile(imagePath, original);
  driver.setCachedFile(filePath, document);
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'c'.repeat(32) });
  }) as typeof fetch);
  try {
    await mkdir(local, { recursive: true });
    await writeFile(imagePath, 'wrong local image');
    await writeFile(filePath, 'wrong local file');
    const input: KK9Message = { id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '附件正文', time: '', isMe: false, timestamp: 1, images: [{ filePath: imagePath, width: 2 }], fileInfo: { fileName: 'document.txt', filePath } };
    const normalized = await files.normalize(input, driver);
    assert.deepEqual(uploads, [original, document]);
    assert.deepEqual(normalized.images, [{ width: 2, file_id: 'c'.repeat(32), name: 'picture.png', size: original.length }]);
    assert.deepEqual(normalized.fileInfo, { fileName: 'document.txt', file_id: 'c'.repeat(32), name: 'document.txt', size: document.length });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('voice下载持有真实音频文件并使用100MiB通道而非图片限制', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-voice-download-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const audio = Buffer.alloc(21 * 1024 * 1024);
  audio.write('RIFF'); audio.write('WAVE', 8);
  const files = new Attachments(config, (async () => new Response(audio, { headers: { 'content-length': String(audio.length) } })) as typeof fetch);
  try {
    const target = await files.download('d'.repeat(32), 'voice', 'speech.wav');
    assert.deepEqual(await readFile(target), audio);
    await assert.rejects(files.download('e'.repeat(32), 'image', 'speech.wav'), /大小限制/);
    const oversized = new Attachments(config, (async () => new Response('audio', { headers: { 'content-length': String(100 * 1024 * 1024 + 1) } })) as typeof fetch);
    await assert.rejects(oversized.download('f'.repeat(32), 'voice', 'speech.mp3'), /大小限制/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('不同 URI 的同名图片与普通文件使用各自缓存，不会错传附件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-uri-image-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/one/resource', Buffer.from('first original'));
  driver.setImageResource('server/two/resource', Buffer.from('second original'));
  driver.setCachedFile('server/one/resource', Buffer.from('ordinary file'));
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'f'.repeat(32) });
  }) as typeof fetch);
  try {
    for (const uri of ['server/one/resource', 'server/two/resource']) {
      await files.normalize(inboundImage([{ uri }]), driver);
    }
    await files.normalize({ ...inboundImage([]), fileInfo: { fileName: 'resource', filePath: 'server/one/resource' } }, driver);
    assert.deepEqual(uploads, [Buffer.from('first original'), Buffer.from('second original'), Buffer.from('ordinary file')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('普通文件上传失败后重开桥接仍复用完整缓存，过期后重新保存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-remote-file-cache-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  const fileInfo = { fileName: '报告.txt', filePath: 'R:\\KK9\\报告.txt' };
  driver.setCachedFile(fileInfo.filePath, Buffer.from('complete report'));
  const nativeSave = driver.saveFile.bind(driver);
  let saves = 0;
  driver.saveFile = async (file, target) => { saves++; return nativeSave(file, target); };
  const uploads: Buffer[] = [];
  const fetcher = (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return uploads.length === 1 ? new Response('', { status: 503 }) : Response.json({ file_id: 'f'.repeat(32) });
  }) as typeof fetch;
  const message = { ...inboundImage([]), fileInfo };
  try {
    const failed = await new Attachments(config, fetcher).normalize(message, driver);
    assert.match(String((failed.fileInfo as Record<string, unknown>).attachment_error), /HTTP 503/);
    const saved = await new Attachments(config, fetcher).normalize(message, driver);
    assert.equal((saved.fileInfo as Record<string, unknown>).size, 15);
    assert.equal(saves, 1);
    const [id] = await readdir(join(config.dataDir, 'attachments'));
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(join(config.dataDir, 'attachments', id!), old, old);
    await new Attachments(config, fetcher).cleanup();
    await new Attachments(config, fetcher).normalize(message, driver);
    assert.equal(saves, 2);
    assert.deepEqual(uploads, [Buffer.from('complete report'), Buffer.from('complete report'), Buffer.from('complete report')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const inboundImage = (images: NonNullable<KK9Message['images']>): KK9Message => ({ id: 'original-image', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '原图正文', time: '', isMe: false, timestamp: 1, images });

test('Windows 原图缓存无 URI 与普通文件均由 Driver 保存到桥接本地后上传', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-remote-inbound-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const image = { originalFilePath: 'R:\\KK9\\原图.png', filePath: 'R:\\KK9\\缩略图.png', uri: 'server/thumb' };
  const fileInfo = { fileName: '远程文档.txt', filePath: 'R:\\KK9\\远程文档.txt' };
  const bytes = [Buffer.from('remote original'), Buffer.from('remote document')];
  const uploaded: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploaded.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  const driver = {
    async downloadImage(received: unknown, target: string) {
      assert.deepEqual(received, image);
      await writeFile(target, bytes[0]!);
      return target;
    },
    async saveFile(received: unknown, target: string) {
      assert.deepEqual(received, fileInfo);
      await writeFile(target, bytes[1]!);
      return target;
    },
  };
  try {
    const result = await files.normalize({ ...inboundImage([image]), fileInfo }, driver);
    assert.deepEqual(uploaded, bytes);
    assert.deepEqual(result.images, [{ file_id: 'a'.repeat(32), name: '原图.png', size: bytes[0]!.length }]);
    assert.deepEqual(result.fileInfo, { fileName: fileInfo.fileName, file_id: 'a'.repeat(32), name: fileInfo.fileName, size: bytes[1]!.length });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('远端原图与缩略图不同时仅上传原图，且不泄露原图路径和 URI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-cached-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  const driver = new FakeKK9Driver();
  driver.setCachedFile('R:\\KK9\\thumb.png', Buffer.from('thumbnail'));
  driver.setCachedFile('R:\\KK9\\original.png', Buffer.from('original bytes'));
  driver.setImageResource('server/original.png', Buffer.from('original bytes'));
  try {
    for (const original of [{ originalFilePath: 'R:\\KK9\\original.png' }, { originalUri: 'server/original.png' }]) {
      const result = await files.normalize(inboundImage([{ filePath: 'R:\\KK9\\thumb.png', uri: 'server/thumb', ...original, width: 580 }]), driver);
      assert.deepEqual(result.images, [{ width: 580, file_id: 'a'.repeat(32), name: 'original.png', size: 14 }]);
    }
    assert.deepEqual(uploads, [Buffer.from('original bytes'), Buffer.from('original bytes')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const stalePath of [false, true]) {
  test(`原图缓存未命中原生下载并上传实际字节，过期远端路径=${stalePath}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-original-download-'));
    const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
    const original = Buffer.from('downloaded original bytes');
    const driver = new FakeKK9Driver();
    driver.setImageResource('server/original', original);
    let downloads = 0;
    const nativeDownload = driver.downloadImage.bind(driver);
    driver.downloadImage = async (image, target) => { downloads++; return nativeDownload(image, target); };
    const uploads: Buffer[] = [];
    const files = new Attachments(config, (async (_url, init) => {
      uploads.push(Buffer.from(init!.body as Uint8Array));
      return Response.json({ file_id: 'a'.repeat(32) });
    }) as typeof fetch);
    try {
      await mkdir(join(root, 'image'));
      await writeFile(join(root, 'image', 'thumb.png'), 'thumbnail');
      const input = inboundImage([{ filePath: join(root, 'image', 'thumb.png'), uri: 'server/thumb', originalUri: 'server/original', ...(stalePath ? { originalFilePath: join(root, 'image', 'expired.png') } : {}) }]);
      const result = await files.normalize(input, driver);
      assert.equal((result.images as Array<{size:number}>)[0]!.size, original.length);
      assert.deepEqual(uploads, [original]);
      await files.normalize(input, driver);
      assert.equal(downloads, 1);
      assert.deepEqual(uploads, [original, original]);
      const old = new Date(Date.now() - 25 * 3600_000);
      const [cacheId] = await readdir(join(config.dataDir, 'attachments'));
      await utimes(join(config.dataDir, 'attachments', cacheId!), old, old);
      await files.cleanup();
      assert.deepEqual(await readdir(join(config.dataDir, 'attachments')), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('原生下载失败保留错误和文本，不能上传现有缩略图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-failed-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  let uploads = 0;
  const files = new Attachments(config, (async () => { uploads++; return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  const driver = new FakeKK9Driver();
  driver.downloadImage = async (_image, target) => { await writeFile(target, 'partial'); throw new Error('原图原生下载失败：连接已断开'); };
  try {
    await mkdir(join(root, 'image'));
    await writeFile(join(root, 'image', 'thumb.png'), 'thumbnail');
    const result = await files.normalize(inboundImage([{ filePath: join(root, 'image', 'thumb.png'), uri: 'server/thumb', originalUri: 'server/original' }]), driver);
    assert.equal(result.content, '原图正文');
    assert.match(String((result.images as Array<{attachment_error:string}>)[0]!.attachment_error), /原生下载失败/);
    assert.equal(uploads, 0);
    const directories = await readdir(join(config.dataDir, 'attachments'));
    for (const directory of directories) assert.deepEqual(await readdir(join(config.dataDir, 'attachments', directory)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('原图上传失败不能触发再次下载，下一次处理复用下载缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-upload-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/original', Buffer.from('original'));
  let downloads = 0;
  const nativeDownload = driver.downloadImage.bind(driver);
  driver.downloadImage = async (image, target) => { downloads++; return nativeDownload(image, target); };
  let uploads = 0;
  const files = new Attachments(config, (async () => { uploads++; return uploads === 1 ? new Response('', { status: 503 }) : Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    const input = inboundImage([{ originalUri: 'server/original' }]);
    assert.match(String(((await files.normalize(input, driver)).images as Array<{attachment_error:string}>)[0]!.attachment_error), /HTTP 503/);
    assert.equal(((await files.normalize(input, driver)).images as Array<{size:number}>)[0]!.size, 8);
    assert.equal(downloads, 1);
    assert.equal(uploads, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('缺失或显式空原图来源不能改用缩略图，Driver 错误逐项保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-boundaries-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/thumb', Buffer.from('thumbnail'));
  driver.setCachedFile('R:\\KK9\\thumb.png', Buffer.from('thumbnail'));
  let uploads = 0;
  const files = new Attachments(config, (async () => { uploads++; return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    const cases = [
      { originalFilePath: 'R:\\KK9\\missing.png' },
      { originalUri: '' },
      { originalFilePath: '' },
    ];
    for (const original of cases) {
      const result = await files.normalize(inboundImage([{ ...original, uri: 'server/thumb', filePath: 'R:\\KK9\\thumb.png' }]), driver);
      assert.match(String((result.images as Array<{attachment_error:string}>)[0]!.attachment_error), /原图.*URI/);
    }
    driver.downloadImage = async () => { throw new Error('远端磁盘读取失败：EACCES'); };
    const failed = await files.normalize(inboundImage([{ originalUri: 'server/original' }]), driver);
    assert.match(String((failed.images as Array<{attachment_error:string}>)[0]!.attachment_error), /远端磁盘读取失败：EACCES/);
    assert.equal(failed.content, '原图正文');
    assert.equal(uploads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('没有原图字段的旧单一远端资源仍可下载，原图超过20MiB不能上传', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-limits-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/legacy', Buffer.from('legacy original'));
  driver.setImageResource('server/oversized', Buffer.alloc(20 * 1024 * 1024 + 1));
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => { uploads.push(Buffer.from(init!.body as Uint8Array)); return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    const result = await files.normalize(inboundImage([{ uri: 'server/legacy' }, { originalUri: 'server/oversized' }]), driver);
    assert.deepEqual(uploads, [Buffer.from('legacy original')]);
    assert.match(String((result.images as Array<{attachment_error:string}>)[1]!.attachment_error), /20 MiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('同一消息重复原图 URI 只下载一次并分别上传，避免共用缓存写入竞争', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-shared-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/shared', Buffer.from('shared original'));
  let downloads = 0;
  const nativeDownload = driver.downloadImage.bind(driver);
  driver.downloadImage = async (image, target) => { downloads++; return nativeDownload(image, target); };
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => { uploads.push(Buffer.from(init!.body as Uint8Array)); return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    const result = await files.normalize(inboundImage([{ originalUri: 'server/shared' }, { originalUri: 'server/shared' }]), driver);
    assert.equal(downloads, 1);
    assert.deepEqual(uploads, [Buffer.from('shared original'), Buffer.from('shared original')]);
    assert.deepEqual((result.images as Array<{size:number}>).map(image => image.size), [15, 15]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('原图缓存目录尚未创建时仍可下载到桥接缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-uninitialized-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  const original = Buffer.from('original without client cache');
  driver.setImageResource('server/uninitialized', original);
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  try {
    const result = await files.normalize(inboundImage([{ originalFilePath: join(root, 'not-created', 'original.png'), originalUri: 'server/uninitialized' }]), driver);
    assert.deepEqual(uploads, [original]);
    assert.equal((result.images as Array<{size:number}>)[0]!.size, original.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('原图下载进程中断后重启必须重新取得完整图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-interrupted-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII=', 'base64');
  const input = inboundImage([{ originalUri: 'server/interrupted', size: original.length }]);
  const child = `
    import { writeFile } from 'node:fs/promises';
    import { Attachments } from ${JSON.stringify(new URL('../src/attachments.ts', import.meta.url).href)};
    const files = new Attachments(${JSON.stringify(config)});
    await files.normalize(${JSON.stringify(input)}, {
      async downloadImage(_image, target) {
        await writeFile(target, Buffer.from(${JSON.stringify([...original.subarray(0, 24)])}));
        process.exit(17);
      }
    });
  `;
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/interrupted', original);
  try {
    const interrupted = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(interrupted.status, 17, interrupted.stderr);
    const result = await files.normalize(input, driver);
    assert.deepEqual(uploads, [original]);
    assert.equal((result.images as Array<{size:number}>)[0]!.size, original.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('超时原图的迟到写入不能覆盖后续成功缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-late-write-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const original = Buffer.from('complete original after retry');
  const driver = new FakeKK9Driver();
  driver.setImageResource('server/late', original);
  const nativeDownload = driver.downloadImage.bind(driver);
  let expiredTarget: string | undefined;
  driver.downloadImage = async (image, target) => {
    if (expiredTarget === undefined) {
      expiredTarget = target;
      throw new Error('原生下载超时');
    }
    return nativeDownload(image, target);
  };
  const uploads: Buffer[] = [];
  const fetcher = (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch;
  const files = new Attachments(config, fetcher);
  const input = inboundImage([{ originalUri: 'server/late' }]);
  try {
    const failed = await files.normalize(input, driver);
    assert.match(String((failed.images as Array<{attachment_error:string}>)[0]!.attachment_error), /超时/);
    await files.normalize(input, driver);
    await writeFile(expiredTarget!, 'late partial');
    const reopened = await new Attachments(config, fetcher).normalize(input, driver);
    assert.deepEqual(uploads, [original, original]);
    assert.equal((reopened.images as Array<{size:number}>)[0]!.size, original.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('普通文件保存失败清理半文件并保留正文，不直接读取同名本地文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-file-failed-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  driver.saveFile = async (_file, target) => { await writeFile(target, 'partial'); throw new Error('远端文件保存失败：连接已断开'); };
  let uploads = 0;
  const files = new Attachments(config, (async () => { uploads++; return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    const source = join(root, 'same-name.txt');
    await writeFile(source, 'must not upload');
    const failed = await files.normalize({ ...inboundImage([]), fileInfo: { fileName: 'same-name.txt', filePath: source } }, driver);
    assert.equal(failed.content, '原图正文');
    assert.match(String((failed.fileInfo as Record<string, unknown>).attachment_error), /远端文件保存失败：连接已断开/);
    assert.equal(uploads, 0);
    for (const id of await readdir(join(config.dataDir, 'attachments'))) {
      assert.deepEqual(await readdir(join(config.dataDir, 'attachments', id)), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('保存结果路径不一致、空文件和超过100MiB的文件均不能上传或发布缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-file-limits-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1' }, root);
  const driver = new FakeKK9Driver();
  let uploads = 0;
  const files = new Attachments(config, (async () => { uploads++; return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    for (const size of [-1, 0, 100 * 1024 * 1024 + 1]) {
      driver.saveFile = async (_file, target) => {
        await writeFile(target, '');
        if (size === -1) return join(root, 'unexpected.txt');
        await truncate(target, size);
        return target;
      };
      const result = await files.normalize({ ...inboundImage([]), fileInfo: { fileName: 'limit.bin', filePath: `R:\\KK9\\${size}.bin` } }, driver);
      assert.match(String((result.fileInfo as Record<string, unknown>).attachment_error), size === -1 ? /路径不一致/ : /100 MiB/);
    }
    assert.equal(uploads, 0);
    for (const id of await readdir(join(config.dataDir, 'attachments'))) {
      assert.deepEqual(await readdir(join(config.dataDir, 'attachments', id)), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
