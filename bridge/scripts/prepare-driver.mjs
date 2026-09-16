import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'vendor', 'kairo-driver-source');
const revision = '1da7e8e67ee597624eb47a090276a7957316a258';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, cwd = root, failureMessage) {
  // pnpm 在 Windows 是 .cmd；shell 命令仅由固定参数组成，目录通过 cwd 传入。
  const useShell = process.platform === 'win32' && command === pnpm;
  if (useShell && args.some((arg) => !/^[a-zA-Z0-9._/-]+$/.test(arg))) throw new Error('拒绝包含 shell 元字符的 pnpm 参数');
  const result = useShell
    ? spawnSync([command, ...args].join(' '), { cwd, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(failureMessage ?? `${command} 执行失败 (${result.status})`);
}

mkdirSync(resolve(root, 'vendor'), { recursive: true });
if (!existsSync(source)) {
  run('git', ['clone', '-c', 'core.autocrlf=false', 'https://github.com/dnslin/kairo-driver.git', source]);
}
run('git', ['config', 'core.autocrlf', 'false'], source);
const dirtyMessage = 'Driver 工作目录存在跟踪文件修改，请先保存或恢复修改后再运行准备脚本';
run('git', ['diff', '--quiet', '--', ':!start-kk9-cdp.bat'], source, dirtyMessage);
run('git', ['diff', '--cached', '--quiet', '--', ':!start-kk9-cdp.bat'], source, dirtyMessage);
run('git', ['checkout', '--force', '--detach', revision], source);
const batPath = resolve(source, 'start-kk9-cdp.bat');
if (existsSync(batPath)) {
  let batContent = readFileSync(batPath, 'utf8');
  if (!batContent.includes('chcp 65001')) {
    batContent = batContent.replace(/^@echo off\r?\n/, '@echo off\r\nchcp 65001 >nul\r\n');
  }
  writeFileSync(batPath, batContent.replace(/\r?\n/g, '\r\n'), 'utf8');
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
if (head.status !== 0 || head.stdout.trim() !== revision) throw new Error('Driver 提交身份核对失败');
for (const name of ['@audio__decode-wav@1.5.0.patch', 'node-edge-tts@1.2.10.patch']) {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest(resolve(root, 'patches', name)) !== digest(resolve(source, 'patches', name))) {
    throw new Error(`Driver 补丁不一致：${name}`);
  }
}
run(pnpm, ['install', '--frozen-lockfile'], source);
run(pnpm, ['build'], source);
console.log(`Driver ${revision} 已准备完成；继续运行 pnpm install --frozen-lockfile。`);
