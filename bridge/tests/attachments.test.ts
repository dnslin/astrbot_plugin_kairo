import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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

test('附件必须位于真实白名单目录内，不能通过符号链接越界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-file-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./cache'] }, root);
  let requests = 0;
  const files = new Attachments(config, (async (_url, init) => {
    requests++;
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${config.token}`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  try {
    await mkdir(join(root, 'cache'));
    await writeFile(join(root, 'cache', 'ok.txt'), 'safe');
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(root, join(root, 'cache', 'escape'), 'junction');
    assert.equal((await files.upload(join(root, 'cache', 'ok.txt'), 'file')).size, 4);
    await assert.rejects(files.upload(join(root, 'secret.txt'), 'file'), /attachmentRoots/);
    await assert.rejects(files.upload(join(root, 'cache', 'escape', 'secret.txt'), 'file'), /attachmentRoots/);
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

test('已缓存图片与文件上传实际字节，缓存外路径保留具体失败原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-cached-inbound-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./cache'] }, root);
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    assert.ok(init?.body instanceof Uint8Array);
    uploads.push(Buffer.from(init.body));
    return Response.json({ file_id: 'c'.repeat(32) });
  }) as typeof fetch);
  try {
    await mkdir(join(root, 'cache'));
    await writeFile(join(root, 'cache', 'picture.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, 'cache', 'document.txt'), '真实附件');
    await writeFile(join(root, 'outside.txt'), '不得读取');
    const input: KK9Message = { id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '附件正文', time: '', isMe: false, timestamp: 1, images: [{ filePath: join(root, 'cache', 'picture.png'), width: 2 }], fileInfo: { fileName: 'document.txt', filePath: join(root, 'cache', 'document.txt') } };
    const normalized = await files.normalize(input, new FakeKK9Driver());
    assert.deepEqual(uploads, [Buffer.from([137, 80, 78, 71]), Buffer.from('真实附件')]);
    assert.deepEqual(normalized.images, [{ width: 2, file_id: 'c'.repeat(32), name: 'picture.png', size: 4 }]);
    assert.deepEqual(normalized.fileInfo, { fileName: 'document.txt', file_id: 'c'.repeat(32), name: 'document.txt', size: Buffer.byteLength('真实附件') });
    const denied = await files.normalize({ ...input, images: [], fileInfo: { fileName: 'outside.txt', filePath: join(root, 'outside.txt') } }, new FakeKK9Driver());
    assert.ok(denied.fileInfo && typeof denied.fileInfo === 'object' && 'attachment_error' in denied.fileInfo);
    assert.match(String(denied.fileInfo.attachment_error), /attachmentRoots/);
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

test('URI 图片按资源文件名读取已有 PNG 缓存，不能误选前缀相同的其他图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-uri-image-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII=', 'base64');
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'f'.repeat(32) });
  }) as typeof fetch);
  try {
    await mkdir(join(root, 'image'));
    await writeFile(join(root, 'image', 'resource-other.png'), 'wrong image');
    await writeFile(join(root, 'image', 'resource.png'), png);
    const input = { id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '识别图片', time: '', isMe: false, timestamp: 1, images: [{ uri: 'groupc7/M00/7B/6A/resource', mimeType: 'image/png' }] } as KK9Message;
    const result = await files.normalize(input, new FakeKK9Driver());
    assert.deepEqual(uploads, [png]);
    assert.deepEqual(result.images, [{ mimeType: 'image/png', file_id: 'f'.repeat(32), name: 'resource.png', size: png.length }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('URI 图片缓存无扩展名时读取准确资源，同名多扩展名不能任意选图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-uri-exact-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
  const uploads: string[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array).toString());
    return Response.json({ file_id: 'f'.repeat(32) });
  }) as typeof fetch);
  try {
    await mkdir(join(root, 'image'));
    await writeFile(join(root, 'image', 'resource'), 'exact cached image');
    await writeFile(join(root, 'image', 'resource.png'), 'different conversion');
    const input = { id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '识别图片', time: '', isMe: false, timestamp: 1, images: [{ uri: 'groupc7/M00/resource' }] } as KK9Message;
    assert.equal(((await files.normalize(input, new FakeKK9Driver())).images as Array<{name:string}>)[0]!.name, 'resource');
    assert.deepEqual(uploads, ['exact cached image']);
    await rm(join(root, 'image', 'resource'));
    await writeFile(join(root, 'image', 'resource.jpg'), 'another conversion');
    const ambiguous = await files.normalize(input, new FakeKK9Driver());
    assert.match(String((ambiguous.images as Array<{attachment_error:string}>)[0]!.attachment_error), /多个/);
    assert.deepEqual(uploads, ['exact cached image']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('URI 图片命中的缓存链接仍不能越过 attachmentRoots 读取其他文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-uri-link-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
  let uploads = 0;
  const files = new Attachments(config, (async () => { uploads++; return Response.json({ file_id: 'f'.repeat(32) }); }) as typeof fetch);
  try {
    await mkdir(join(root, 'image'));
    await symlink(root, join(root, 'image', 'resource.png'), 'junction');
    const input = { id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '识别图片', time: '', isMe: false, timestamp: 1, images: [{ uri: 'groupc7/M00/resource' }] } as KK9Message;
    const result = await files.normalize(input, new FakeKK9Driver());
    const image = (result.images as Array<{attachment_error:string}>)[0]!;
    assert.match(String(image.attachment_error), /attachmentRoots/);
    assert.equal(uploads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const inboundImage = (images: NonNullable<KK9Message['images']>): KK9Message => ({ id: 'original-image', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '原图正文', time: '', isMe: false, timestamp: 1, images });

test('缩略图与原图不同时仅上传原图缓存，且不泄露原图路径和 URI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-cached-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
  const uploads: Buffer[] = [];
  const files = new Attachments(config, (async (_url, init) => {
    uploads.push(Buffer.from(init!.body as Uint8Array));
    return Response.json({ file_id: 'a'.repeat(32) });
  }) as typeof fetch);
  const driver = new FakeKK9Driver();
  driver.downloadImage = async () => { throw new Error('命中缓存不应下载'); };
  try {
    await mkdir(join(root, 'image'));
    await writeFile(join(root, 'image', 'thumb.png'), 'thumbnail');
    await writeFile(join(root, 'image', 'original.png'), 'original bytes');
    for (const original of [{ originalFilePath: join(root, 'image', 'original.png'), originalUri: 'server/original' }, { originalUri: 'server/original' }]) {
      const result = await files.normalize(inboundImage([{ filePath: join(root, 'image', 'thumb.png'), uri: 'server/thumb', ...original, width: 580 }]), driver);
      assert.deepEqual(result.images, [{ width: 580, file_id: 'a'.repeat(32), name: 'original.png', size: 14 }]);
    }
    assert.deepEqual(uploads, [Buffer.from('original bytes'), Buffer.from('original bytes')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const stalePath of [false, true]) {
  test(`原图缓存未命中原生下载并上传实际字节，过期本地路径=${stalePath}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-original-download-'));
    const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
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
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
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

test('缓存歧义、目录越界、非文件及仅原图路径不能靠下载或缩略图掩盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-original-boundaries-'));
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./image'] }, root);
  const driver = new FakeKK9Driver();
  let downloads = 0, uploads = 0;
  driver.downloadImage = async () => { downloads++; throw new Error('不能下载'); };
  const files = new Attachments(config, (async () => { uploads++; return Response.json({ file_id: 'a'.repeat(32) }); }) as typeof fetch);
  try {
    await mkdir(join(root, 'image'));
    await mkdir(join(root, 'image', 'not-file'));
    await writeFile(join(root, 'image', 'ambiguous.png'), 'one');
    await writeFile(join(root, 'image', 'ambiguous.jpg'), 'two');
    await writeFile(join(root, 'image', 'thumb.png'), 'thumbnail');
    const cases = [
      { image: { originalUri: 'server/ambiguous' }, error: /多个/ },
      { image: { originalFilePath: join(root, 'outside.png'), originalUri: 'server/original' }, error: /attachmentRoots/ },
      { image: { originalFilePath: join(root, 'image', 'not-file'), originalUri: 'server/original' }, error: /附件为空或超过|文件/ },
      { image: { originalFilePath: join(root, 'image', 'thumb.png', 'child'), originalUri: 'server/original' }, error: /ENOTDIR|目录|directory/i },
      { image: { originalFilePath: join(root, 'image', 'missing.png'), uri: 'server/thumb', filePath: join(root, 'image', 'thumb.png') }, error: /原图.*URI|尚未缓存/ },
      { image: { originalUri: '', uri: 'server/thumb', filePath: join(root, 'image', 'thumb.png') }, error: /原图.*URI/ },
      { image: { originalFilePath: '', uri: 'server/thumb', filePath: join(root, 'image', 'thumb.png') }, error: /原图.*URI/ },
    ];
    for (const { image, error } of cases) {
      const result = await files.normalize(inboundImage([image]), driver);
      assert.match(String((result.images as Array<{attachment_error:string}>)[0]!.attachment_error), error);
    }
    assert.equal(downloads, 0);
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
  const config = parseConfig({ serverUrl: 'http://127.0.0.1:6190', token: 'x'.repeat(32), expectedUserId: '1', attachmentRoots: ['./not-created'] }, root);
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
