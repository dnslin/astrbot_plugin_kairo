import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IKK9Driver, KK9ImageInfo, KK9Message } from '@kairo/driver';
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

export function localAttachmentPath(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('file:')) {
    try { return fileURLToPath(value); } catch { return null; }
  }
  return isAbsolute(value) ? value : null;
}

export class Attachments {
  private readonly imageDownloads = new Map<string, Promise<string>>();
  constructor(private readonly config: BridgeConfig, private readonly fetcher: typeof fetch = fetch) {}

  private inside(root: string, path: string): boolean {
    const inside = relative(root, path);
    return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  }

  private async attachmentPath(path: string): Promise<string> {
    const roots = [...this.config.attachmentRoots, join(this.config.dataDir, 'attachments')];
    const actualRoots = await Promise.all(roots.map(async (root) => {
      try { return await realpath(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    let actual: string;
    try { actual = await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!roots.some(root => this.inside(root, path))) throw new Error('附件缓存路径不在 attachmentRoots 或桥接附件缓存目录内');
      // Windows 对 file/child 也可能返回 ENOENT；区分父目录缺失与父路径实际为文件。
      let parent = dirname(path);
      while (true) {
        try {
          if (!(await stat(parent)).isDirectory()) throw new Error('附件缓存祖先路径不是目录');
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw parentError;
          parent = dirname(parent);
        }
      }
      throw error;
    }
    if (!actualRoots.some(root => root && this.inside(root, actual))) throw new Error('附件缓存路径不在 attachmentRoots 或桥接附件缓存目录内');
    return actual;
  }

  private async imagePath(image: KK9ImageInfo): Promise<string | null> {
    const hasOriginal = image.originalFilePath !== undefined || image.originalUri !== undefined;
    const local = (hasOriginal ? [image.originalFilePath, image.originalUri] : [image.filePath, image.url, image.uri]).map(localAttachmentPath).find(Boolean);
    if (local) {
      try { return await this.attachmentPath(local); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // 原图字段存在时，缩略图路径和 URI 都不是可用候选。
    const resource = (hasOriginal ? image.originalUri ?? '' : image.uri || image.url || '').split(/[?#]/, 1)[0]!.replace(/\\/g, '/').split('/').pop();
    if (!resource || resource === '.' || resource === '..') return null;
    for (const root of this.config.attachmentRoots) {
      let entries: string[];
      try { entries = await readdir(root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (entries.includes(resource)) return join(root, resource);
      const prefix = `${resource}.`;
      const matches = entries.filter(name => name.startsWith(prefix));
      if (matches.length > 1) throw new Error(`图片资源 ${resource} 对应多个缓存文件，无法确定要读取的图片`);
      if (matches.length === 1) return join(root, matches[0]!);
    }
    return null;
  }

  private async downloadImage(image: KK9ImageInfo, driver?: Pick<IKK9Driver, 'downloadImage'>): Promise<string> {
    const hasOriginal = image.originalFilePath !== undefined || image.originalUri !== undefined;
    const uri = hasOriginal ? image.originalUri : image.uri;
    if (!uri) throw new Error('图片尚未缓存，且缺少原图下载 URI');
    const pending = this.imageDownloads.get(uri);
    if (pending) return pending;
    const download = this.cacheImage(image, uri, driver);
    this.imageDownloads.set(uri, download);
    try { return await download; }
    finally { this.imageDownloads.delete(uri); }
  }

  private async cacheImage(image: KK9ImageInfo, uri: string, driver?: Pick<IKK9Driver, 'downloadImage'>): Promise<string> {
    const id = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    const directory = join(this.config.dataDir, 'attachments', id);
    const name = safeFilename((uri.split(/[?#]/, 1)[0] || '').replace(/\\/g, '/').split('/').pop() || 'image');
    const target = join(directory, name);
    if (driver) await mkdir(directory, { recursive: true });
    else {
      try { await stat(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('图片尚未缓存，当前调用未提供原图下载 Driver');
        throw error;
      }
    }
    try {
      await this.attachmentPath(target);
      const cached = await stat(target);
      if (!cached.isFile() || cached.size < 1 || cached.size > IMAGE_LIMIT) throw new Error('附件为空或超过 20 MiB 限制');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!driver) throw new Error('图片尚未缓存，当前调用未提供原图下载 Driver');
      try {
        const downloaded = await driver.downloadImage(image, target);
        if (downloaded !== target) throw new Error('原图下载返回的路径与请求的缓存路径不一致');
        await this.attachmentPath(target);
        const info = await stat(target);
        if (!info.isFile() || info.size < 1 || info.size > IMAGE_LIMIT) throw new Error('附件为空或超过 20 MiB 限制');
      } catch (downloadError) {
        await rm(target, { force: true }).catch(() => {});
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

  async normalize(message: KK9Message, driver?: Pick<IKK9Driver, 'downloadImage'>): Promise<WireMessage> {
    const { raw: _raw, images: _images, fileInfo: _fileInfo, ...core } = message;
    const result: WireMessage = { ...core };
    if (message.images?.length) {
      result.images = await Promise.all(message.images.map(async (item) => {
        const { filePath, url, uri, originalFilePath, originalUri, ...metadata } = item;
        try {
          const path = await this.imagePath(item) ?? await this.downloadImage(item, driver);
          return { ...metadata, ...await this.upload(path, 'image') };
        } catch (error) {
          return { ...metadata, attachment_error: error instanceof Error ? error.message : '图片不可读取' };
        }
      }));
    }
    if (message.fileInfo) {
      const { filePath, ...metadata } = message.fileInfo;
      const path = localAttachmentPath(filePath);
      try {
        if (!path) throw new Error('文件尚未缓存；当前版本无法自动下载 KK9 远程附件');
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
