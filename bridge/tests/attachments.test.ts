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
  const result = await files.normalize({ id: 'm1', sessionId: '0-2', sessionName: '', sessionType: 'private', direction: 'inbound', sender: '员工', senderId: '2', content: '请看附件', time: '', isMe: false, timestamp: 1, raw: { private: true }, images: [{ url: 'https://private/image', uri: 'private-uri' }], fileInfo: { fileName: 'doc.pdf' } } as KK9Message);
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
