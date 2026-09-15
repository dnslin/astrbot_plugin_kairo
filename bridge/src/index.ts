import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KK9Driver, setDriverLogSink } from '@kairo/driver';
import { Bridge } from './bridge.js';
import { loadConfig } from './config.js';
import { SqliteSendOperationStore } from './operation-store.js';

const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  console[level](`${new Date().toISOString()} [${level}] ${message}`);
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('用法：pnpm start --config config.json');
  const config = await loadConfig(args[1] ?? 'config.json');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new SqliteSendOperationStore(join(config.dataDir, 'send-operations.sqlite'));
  // Driver 日志可能包含内部消息字段；桥接只输出自身的连接/错误状态。
  setDriverLogSink(() => {});
  const bridge = new Bridge(config, () => new KK9Driver({ cdp: config.cdp, rejectExistingBridge: true }, store), log);
  process.once('SIGINT', () => bridge.stop());
  process.once('SIGTERM', () => bridge.stop());
  try { await bridge.run(); } finally { store.close(); }
}

main().catch((error: unknown) => {
  log('error', error instanceof Error ? error.message : '桥接启动失败');
  process.exitCode = 1;
});
