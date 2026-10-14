import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/whoami.mjs', import.meta.url));

async function runWhoami(cwd: string, args: string[] = [], overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.KAIRO_CDP_URL;
  delete env.KAIRO_PAGE_MATCH;
  const child = spawn(process.execPath, [script, ...args], {
    cwd, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(code, 1, stderr);
  assert.equal(stdout, '');
  return stderr;
}

async function listenDiscovery(server: Server): Promise<number> {
  // Windows 的随机端口可能落到 fetch 禁止的 6000 等端口；只使用高位端口。
  for (let port = 20000; port <= 65535; port++) {
    server.listen(port, '127.0.0.1');
    try {
      await once(server, 'listening');
      return port;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('无法分配测试 HTTP 端口');
}

test('whoami 默认读取 config.json 的远程地址和页面片段，不要求先填机器人 UID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-whoami-config-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    // 匹配页面后因缺少 WebSocket 明确停止，绝不安装 KK Hook。
    response.end(JSON.stringify([{ id: 'uid', type: 'page', title: 'UID', url: 'http://kk/identity.html' }]));
  });
  const port = await listenDiscovery(server);
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({
      expectedUserId: 'REPLACE_WITH_KK9_BOT_UID',
      cdp: { url: `http://127.0.0.1:${port}/configured`, pageMatch: 'identity.html' },
    }));
    const error = await runWhoami(root);
    assert.deepEqual(requests, ['/configured/json']);
    assert.match(error, /缺少 webSocketDebuggerUrl/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('whoami 支持指定配置文件，环境变量分别覆盖地址和页面片段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-whoami-override-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    const page = request.url === '/override/json' ? 'override.html' : 'custom.html';
    response.end(JSON.stringify([{ id: 'uid', type: 'page', title: 'UID', url: `http://kk/${page}` }]));
  });
  const port = await listenDiscovery(server);
  try {
    await writeFile(join(root, 'custom.json'), JSON.stringify({
      cdp: { url: `http://127.0.0.1:${port}/custom`, pageMatch: 'custom.html' },
    }));
    const configured = await runWhoami(root, ['--config', 'custom.json']);
    assert.match(configured, /缺少 webSocketDebuggerUrl/);
    const overridden = await runWhoami(root, ['--config', 'custom.json'], {
      KAIRO_CDP_URL: `http://127.0.0.1:${port}/override`, KAIRO_PAGE_MATCH: 'override.html',
    });
    assert.match(overridden, /缺少 webSocketDebuggerUrl/);
    assert.deepEqual(requests, ['/custom/json', '/override/json']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('whoami 首次未建配置可用环境变量，但显式文件缺失和配置损坏不得回退', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-whoami-first-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ id: 'uid', type: 'page', title: 'UID', url: 'http://kk/renderer.html' }]));
  });
  const port = await listenDiscovery(server);
  try {
    const env = { KAIRO_CDP_URL: `http://127.0.0.1:${port}` };
    assert.match(await runWhoami(root, [], env), /缺少 webSocketDebuggerUrl/);
    assert.match(await runWhoami(root, ['--config', 'missing.json'], env), /ENOENT.*missing\.json/);
    await writeFile(join(root, 'config.json'), '{');
    assert.match(await runWhoami(root, [], env), /JSON/);
    await writeFile(join(root, 'config.json'), JSON.stringify({ cdp: [] }));
    assert.match(await runWhoami(root, [], env), /cdp.*对象/);
    assert.match(await runWhoami(root, ['--config']), /用法/);
    assert.deepEqual(requests, ['/json']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
