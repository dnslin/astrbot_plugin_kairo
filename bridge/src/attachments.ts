import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { getOriginalImageUri, hasOriginalImageSource, type IKK9Driver, type KK9Message } from '@kairo/driver';
import type { BridgeConfig } from './config.js';
import { RequestError } from './protocol.js';

export const FILE_LIMIT = 100 * 1024 * 1024;
export const IMAGE_LIMIT = 20 * 1024 * 1024;
export type WireMessage = Record<string, unknown>;

export function safeFilename(value: string | undefined): string {
  const base = (value ?? 'attachment').replace(/\\/g, '/').split('/').pop() ?? 'attachment';
  let result = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (!result || result === '.' || result === '..') result = 'attachment';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  if (Buffer.byteLength(result, 'utf8') > 180) {
    const extension = Buffer.byteLength(extname(result), 'utf8') <= 40 ? extname(result) : '';
    let stem = extension ? result.slice(0, -extension.length) : result;
    while (Buffer.byteLength(stem + extension, 'utf8') > 180) stem = [...stem].slice(0, -1).join('');
    result = stem + extension;
  }
  return result;
}

type AttachmentDriver = Pick<IKK9Driver, 'downloadImage' | 'saveFile'>;

export class Attachments {
  private readonly attachmentDownloads = new Map<string, Promise<string>>();
  constructor(private readonly config: BridgeConfig, private readonly fetcher: typeof fetch = fetch) {}

  private inside(root: string, path: string): boolean {
    const inside = relative(root, path);
    return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  }

  private async attachmentPath(path: string): Promise<string> {
    const root = await realpath(join(this.config.dataDir, 'attachments'));
    const actual = await realpath(path);
    if (!this.inside(root, actual)) throw new Error('附件缓存路径不在桥接附件缓存目录内');
    return actual;
  }

  private async cacheAttachment(kind: 'image' | 'file', source: string, name: string, save: (target: string) => Promise<string>): Promise<string> {
    const key = `${kind}:${source}`;
    const pending = this.attachmentDownloads.get(key);
    if (pending) return pending;
    const download = this.saveAttachment(kind, key, name, save);
    this.attachmentDownloads.set(key, download);
    try { return await download; }
    finally { this.attachmentDownloads.delete(key); }
  }

  private async saveAttachment(kind: 'image' | 'file', key: string, name: string, save: (target: string) => Promise<string>): Promise<string> {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 32);
    const directory = join(this.config.dataDir, 'attachments', id);
    const target = join(directory, safeFilename(name));
    const limit = kind === 'image' ? IMAGE_LIMIT : FILE_LIMIT;
    const validate = async (path: string): Promise<void> => {
      const info = await stat(await this.attachmentPath(path));
      if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error(`附件为空或超过 ${limit / 1024 / 1024} MiB 限制`);
    };
    await mkdir(directory, { recursive: true });
    try {
      await validate(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // 每次保存使用独占临时路径；完整传输并检查后才发布桥接缓存。
      const partial = join(directory, `${randomUUID()}.part`);
      try {
        const downloaded = await save(partial);
        if (downloaded !== partial) throw new Error('附件保存返回的路径与请求的临时路径不一致');
        await validate(partial);
        await rename(partial, target);
      } catch (downloadError) {
        try { await rm(partial, { force: true }); }
        catch (cleanupError) { throw new AggregateError([downloadError, cleanupError], `附件保存与临时文件清理失败：${String(downloadError)}；${String(cleanupError)}`); }
        throw downloadError;
      }
    }
    await utimes(directory, new Date(), new Date());
    return target;
  }

  async upload(path: string, kind: 'image' | 'file', name?: string): Promise<{ file_id: string; name: string; size: number }> {
    const actual = await this.attachmentPath(path);
    const limit = kind === 'image' ? IMAGE_LIMIT : FILE_LIMIT;
    const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error(`附件为空或超过 ${limit / 1024 / 1024} MiB 限制`);
      // 多读一个字节，确保读取期间增长的文件也不能超过上限。
      const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let size = 0;
      while (size < bytes.length) {
        const part = await file.read(bytes, size, bytes.length - size, null);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size !== info.size) throw new Error('附件读取期间发生变化，请稍后重试');
      const filename = safeFilename(name ?? basename(actual));
      const url = new URL('/files', this.config.serverUrl);
      url.searchParams.set('name', filename);
      const response = await this.fetcher(url, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/octet-stream' },
        body: bytes.subarray(0, size), redirect: 'error', signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`附件上传失败 (HTTP ${response.status})`);
      const result = await response.json() as Record<string, unknown>;
      if (typeof result.file_id !== 'string' || !/^[a-f0-9]{32}$/.test(result.file_id)) throw new Error('附件服务返回的 file_id 无效');
      return { file_id: result.file_id, name: filename, size };
    } finally { await file.close(); }
  }

  async download(fileId: string, kind: 'image' | 'file' | 'voice', name?: string): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(fileId)) throw new RequestError('INVALID_REQUEST', 'file_id 无效');
    const directory = join(this.config.dataDir, 'attachments', fileId);
    const target = join(directory, safeFilename(name ?? (kind === 'image' ? 'image.png' : kind === 'voice' ? 'voice.wav' : 'attachment')));
    const limit = kind === 'image' ? IMAGE_LIMIT : FILE_LIMIT;
    const cached = await stat(target).catch(() => null);
    if (cached?.isFile() && cached.size > 0 && cached.size <= limit) {
      await utimes(directory, new Date(), new Date());
      return target;
    }
    const response = await this.fetcher(new URL(`/files/${fileId}`, this.config.serverUrl), {
      headers: { Authorization: `Bearer ${this.config.token}` }, redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new RequestError('FILE_DOWNLOAD_FAILED', `附件下载失败 (HTTP ${response.status})`);
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > limit) { await response.body.cancel(); throw new RequestError('FILE_TOO_LARGE', '附件超过大小限制'); }
    await mkdir(directory, { recursive: true });
    const partial = `${target}.part`;
    const file = await open(partial, 'w', 0o600);
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new RequestError('FILE_TOO_LARGE', '附件超过大小限制');
        let offset = 0;
        while (offset < value.length) {
          const written = await file.write(value, offset, value.length - offset);
          offset += written.bytesWritten;
        }
      }
      if (size === 0) throw new RequestError('INVALID_FILE', '附件为空');
    } catch (error) {
      await reader.cancel().catch(() => {});
      await file.close();
      await rm(partial, { force: true });
      throw error;
    }
    await file.close();
    await rename(partial, target);
    await utimes(directory, new Date(), new Date());
    return target;
  }

  async normalize(message: KK9Message, driver: AttachmentDriver): Promise<WireMessage> {
    const { raw: _raw, images: _images, fileInfo: _fileInfo, ...core } = message;
    const result: WireMessage = { ...core };
    if (message.images?.length) {
      result.images = await Promise.all(message.images.map(async (item) => {
        const { filePath, url, uri, originalFilePath, originalUri, ...metadata } = item;
        try {
          // 这里只用远端来源构造缓存键和文件名，文件读取始终交给 Driver。
          const source = getOriginalImageUri(item) || (hasOriginalImageSource(item) ? originalFilePath : filePath || (url?.startsWith('file:') ? url : undefined));
          if (!source) throw new Error('图片缺少原图缓存路径或下载 URI');
          const name = source.split(/[?#]/, 1)[0]!;
          const path = await this.cacheAttachment('image', source, name, target => driver.downloadImage(item, target));
          return { ...metadata, ...await this.upload(path, 'image') };
        } catch (error) {
          return { ...metadata, attachment_error: error instanceof Error ? error.message : '图片不可读取' };
        }
      }));
    }
    if (message.fileInfo) {
      const { filePath, ...metadata } = message.fileInfo;
      try {
        if (!filePath) throw new Error('文件尚未缓存；当前版本无法自动下载 KK9 远程附件');
        const path = await this.cacheAttachment('file', filePath, metadata.fileName, target => driver.saveFile(message.fileInfo!, target));
        result.fileInfo = { ...metadata, ...await this.upload(path, 'file', metadata.fileName) };
      } catch (error) {
        result.fileInfo = { ...metadata, attachment_error: error instanceof Error ? error.message : '文件不可读取' };
      }
    }
    return result;
  }

  async cleanup(): Promise<void> {
    const root = join(this.config.dataDir, 'attachments');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - this.config.fileRetentionHours * 3600_000;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    }
  }
}
