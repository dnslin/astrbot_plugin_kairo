import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'vendor', 'kairo-driver-source');
const revision = '1da7e8e67ee597624eb47a090276a7957316a258';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, cwd = root) {
  // pnpm 在 Windows 是 .cmd；shell 命令仅由固定参数组成，目录通过 cwd 传入。
  const useShell = process.platform === 'win32' && command === pnpm;
  if (useShell && args.some((arg) => !/^[a-zA-Z0-9._/-]+$/.test(arg))) throw new Error('拒绝包含 shell 元字符的 pnpm 参数');
  const result = useShell
    ? spawnSync([command, ...args].join(' '), { cwd, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败 (${result.status})`);
}

mkdirSync(resolve(root, 'vendor'), { recursive: true });
if (!existsSync(source)) {
  run('git', ['clone', '-c', 'core.autocrlf=false', '--no-checkout', 'https://github.com/dnslin/kairo-driver.git', source]);
}
run('git', ['config', 'core.autocrlf', 'false'], source);
run('git', ['checkout', '--detach', revision], source);
for (const name of ['@audio__decode-wav@1.5.0.patch', 'node-edge-tts@1.2.10.patch']) {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest(resolve(root, 'patches', name)) !== digest(resolve(source, 'patches', name))) {
    throw new Error(`Driver 补丁不一致：${name}`);
  }
}
run(pnpm, ['install', '--frozen-lockfile'], source);
run(pnpm, ['pack', '--pack-destination', '..'], source);
console.log(`Driver ${revision} 已准备完成；继续运行 pnpm install --frozen-lockfile。`);
