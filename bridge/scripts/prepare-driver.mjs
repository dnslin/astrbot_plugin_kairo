import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const revision = '97729bc61e131592b9b850ad9ed922ca170188c8';
// 新目录避免覆盖旧版本 vendor 中已经应用的补丁或用户修改。
const source = resolve(root, 'vendor', 'kairo-driver-97729bc61e13');
const repository = process.env.KAIRO_DRIVER_SOURCE || 'https://github.com/dnslin/kairo-driver.git';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, cwd = root, failureMessage, capture = false) {
  // Windows pnpm 是 .cmd；只有固定、无 shell 元字符的 pnpm 参数进入 shell。
  const useShell = process.platform === 'win32' && command === pnpm;
  if (useShell && args.some((arg) => !/^[a-zA-Z0-9._/-]+$/.test(arg))) throw new Error('拒绝包含 shell 元字符的 pnpm 参数');
  const options = { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' };
  const result = useShell
    ? spawnSync([command, ...args].join(' '), { ...options, shell: true })
    : spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(failureMessage ?? `${command} ${args.join(' ')} 执行失败 (${result.status})`);
  return result.stdout?.trim();
}

mkdirSync(resolve(root, 'vendor'), { recursive: true });
if (!existsSync(source)) {
  // Publish a complete checkout; interrupted clones never occupy the final path.
  const staging = mkdtempSync(resolve(root, 'vendor', '.kairo-prepare-'));
  try {
    run('git', ['clone', '--no-checkout', '-c', 'core.autocrlf=false', '--', repository, staging]);
    run('git', ['checkout', '--detach', revision], staging);
    if (run('git', ['rev-parse', 'HEAD'], staging, 'Driver 提交身份核对失败', true) !== revision) throw new Error('Driver 提交身份核对失败');
    renameSync(staging, source);
  } finally {
    // Only this invocation's unique staging directory belongs to this cleanup.
    rmSync(staging, { recursive: true, force: true });
  }
}
const head = run('git', ['rev-parse', 'HEAD'], source, 'Driver 提交身份核对失败', true);
if (head !== revision) throw new Error(`Driver 提交身份核对失败：需要 ${revision}，实际 ${head}；请保留该目录并另行处理，不会覆盖源码`);
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], source, '无法读取 Driver 工作目录状态', true);
if (dirty) throw new Error(`Driver 工作目录存在跟踪文件修改，不会覆盖：\n${dirty}`);
for (const name of ['@audio__decode-wav@1.5.0.patch', 'node-edge-tts@1.2.10.patch']) {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest(resolve(root, 'patches', name)) !== digest(resolve(source, 'patches', name))) throw new Error(`Driver 音频补丁不一致：${name}`);
}
run(pnpm, ['install', '--frozen-lockfile'], source);
run(pnpm, ['build'], source);
console.log(`Driver ${revision} 已准备完成（${source}）；继续运行 pnpm install --frozen-lockfile。`);
