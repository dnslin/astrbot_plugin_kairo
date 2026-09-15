// 跨语言测试专用：运行真实桥接代码，唯一替身为 Driver 自带的 FakeKK9Driver。
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Bridge } from '../bridge/src/bridge.ts';
import { parseConfig } from '../bridge/src/config.ts';
import { SqliteSendOperationStore } from '../bridge/src/operation-store.ts';

const require = createRequire(new URL('../bridge/package.json', import.meta.url));
const { FakeKK9Driver, setDriverLogSink } = await import(require.resolve('@kairo/driver'));
setDriverLogSink(() => {});
const config = parseConfig(JSON.parse(process.argv[2]), process.cwd());
await mkdir(config.dataDir, { recursive: true });
const store = new SqliteSendOperationStore(join(config.dataDir, 'operations.sqlite'));
const drivers = [];
let driver;
const bridge = new Bridge(config, () => {
  driver = new FakeKK9Driver(store);
  driver.setCurrentUserId(config.expectedUserId);
  drivers.push(driver);
  return driver;
}, (level, message) => console.error(`[${level}] ${message}`));
const running = bridge.run();
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    const command = JSON.parse(line);
    let result;
    if (command.cmd === 'emit') {
      driver.emit('message', command.message);
      result = true;
    } else if (command.cmd === 'behavior') {
      driver.setSendBehavior(command.behavior);
      result = true;
    } else if (command.cmd === 'calls') {
      result = await Promise.all(drivers.flatMap((item) => item.recordedCalls).map(async (call) => ({
        ...call,
        bytes_base64: ['file', 'image'].includes(call.type) ? (await readFile(call.payload)).toString('base64') : undefined,
      })));
    } else if (command.cmd === 'health') {
      driver.emit('health', { kind: 'cdp_invalidated', cause: new Error('模拟 CDP 断线') });
      result = true;
    } else if (command.cmd === 'generations') {
      result = drivers.length;
    } else if (command.cmd === 'stop') {
      console.log(JSON.stringify({ id: command.id, result: true }));
      break;
    } else throw new Error('未知测试命令');
    console.log(JSON.stringify({ id: command.id, result }));
  }
} finally {
  bridge.stop();
  await running;
  store.close();
  input.close();
}
