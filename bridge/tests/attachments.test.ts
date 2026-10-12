import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { KK9Message } from '@kairo/driver';
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
  const result = await files.normalize({ id: '101', sessionId: '2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '请看附件', time: '', isMe: false, timestamp: 1, raw: { private: true }, images: [{ url: 'https://private/image', uri: 'private-uri' }], fileInfo: { fileName: 'doc.pdf' } } as KK9Message);
  assert.equal(result.content, '请看附件');
  assert.equal(result.raw, undefined);
  const picture = (result.images as Record<string, unknown>[])[0]!;
  assert.equal(picture.url, undefined);
  assert.match(String(picture.attachment_error), /尚未缓存/);
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
    const normalized = await files.normalize(input);
    assert.deepEqual(uploads, [Buffer.from([137, 80, 78, 71]), Buffer.from('真实附件')]);
    assert.deepEqual(normalized.images, [{ width: 2, file_id: 'c'.repeat(32), name: 'picture.png', size: 4 }]);
    assert.deepEqual(normalized.fileInfo, { fileName: 'document.txt', file_id: 'c'.repeat(32), name: 'document.txt', size: Buffer.byteLength('真实附件') });
    const denied = await files.normalize({ ...input, images: [], fileInfo: { fileName: 'outside.txt', filePath: join(root, 'outside.txt') } });
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
