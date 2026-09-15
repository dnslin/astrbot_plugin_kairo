import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface BridgeConfig {
  serverUrl: string;
  token: string;
  expectedUserId: string;
  cdp: { url: string; pageMatch: string };
  attachmentRoots: string[];
  dataDir: string;
  reconnectDelayMs: number;
  pendingEventLimit: number;
  fileRetentionHours: number;
}

export function parseConfig(value: unknown, baseDir: string): BridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
  const raw = value as Record<string, unknown>;
  const string = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`);
    return value.trim();
  };
  const server = new URL(string(raw.serverUrl, 'serverUrl'));
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== '/') {
    throw new Error('serverUrl 必须是 http(s)://主机:端口，不含路径、凭据或查询参数');
  }
  const token = string(process.env.KAIRO_BRIDGE_TOKEN || raw.token, 'token');
  if (token.length < 32 || !/^[\x21-\x7e]+$/.test(token) || token.startsWith('REPLACE_')) throw new Error('token 请配置至少 32 个 ASCII 字符的随机值，不含空白');
  const expectedUserId = string(raw.expectedUserId, 'expectedUserId');
  if (expectedUserId.startsWith('REPLACE_')) throw new Error('expectedUserId 必须填写实际 KK9 机器人 UID');
  const cdp = (raw.cdp ?? {}) as Record<string, unknown>;
  const cdpUrl = new URL(string(cdp.url ?? 'http://127.0.0.1:9222', 'cdp.url'));
  if (!['http:', 'https:'].includes(cdpUrl.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(cdpUrl.hostname) || cdpUrl.username || cdpUrl.password) {
    throw new Error('cdp.url 只允许 KK9 所在电脑的回环地址');
  }
  const roots = raw.attachmentRoots ?? [];
  if (!Array.isArray(roots) || roots.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('attachmentRoots 必须为目录路径数组');
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = raw[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
    return value;
  };
  return {
    serverUrl: server.origin,
    token,
    expectedUserId,
    cdp: { url: cdpUrl.toString(), pageMatch: string(cdp.pageMatch ?? 'renderer.html', 'cdp.pageMatch') },
    attachmentRoots: roots.map((item) => resolve(baseDir, item)),
    dataDir: resolve(baseDir, string(raw.dataDir ?? './data', 'dataDir')),
    reconnectDelayMs: integer('reconnectDelayMs', 3000, 100, 60_000),
    pendingEventLimit: integer('pendingEventLimit', 256, 1, 10_000),
    fileRetentionHours: integer('fileRetentionHours', 24, 1, 168),
  };
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const absolute = resolve(path);
  return parseConfig(JSON.parse(await readFile(absolute, 'utf8')), dirname(absolute));
}
