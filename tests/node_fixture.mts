// 跨语言测试专用：运行真实桥接代码，唯一替身为 Driver 自带的 FakeKK9Driver。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Bridge } from '../bridge/src/bridge.ts';
import { parseConfig } from '../bridge/src/config.ts';
import { SqliteSendOperationStore } from '../bridge/src/operation-store.ts';

const require = createRequire(new URL('../bridge/package.json', import.meta.url));
const { FakeKK9Driver, setDriverLogSink } = await import(pathToFileURL(require.resolve('@kairo/driver')).href);
setDriverLogSink((entry) => console.error(JSON.stringify(entry)));
const config = parseConfig(JSON.parse(process.argv[2]), process.cwd());
await mkdir(config.dataDir, { recursive: true });
const store = new SqliteSendOperationStore(join(config.dataDir, 'operations.sqlite'));
const drivers = [];
let driver;
let sessions = [];
let employees = [];
let searchEmployees = [];
let messages = [];
const imageResources = new Map();
const fileResources = new Map();
const cachedFiles = new Map();
const groupMembers = new Map();
const bridge = new Bridge(config, () => {
  driver = new FakeKK9Driver(store);
  driver.setCurrentUserId(config.expectedUserId);
  driver.setSessions(structuredClone(sessions));
  driver.setEmployees(structuredClone(employees));
  driver.setSearchEmployees(structuredClone(searchEmployees));
  driver.setMessages(structuredClone(messages));
  for (const [sessionId, members] of groupMembers) driver.setGroupMembers(sessionId, structuredClone(members));
  for (const [uri, bytes] of imageResources) driver.setImageResource(uri, bytes);
  for (const [uri, bytes] of fileResources) driver.setFileResource(uri, bytes);
  for (const [path, bytes] of cachedFiles) driver.setCachedFile(path, bytes);
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
      messages.push(command.message);
      driver.setMessages(structuredClone(messages));
      driver.emit('message', command.message);
      result = true;
    } else if (command.cmd === 'behavior') {
      driver.setSendBehavior(command.behavior);
      result = true;
    } else if (command.cmd === 'image_resource') {
      const bytes = Buffer.from(command.bytes_base64, 'base64');
      imageResources.set(command.uri, bytes);
      driver.setImageResource(command.uri, bytes);
      result = true;
    } else if (command.cmd === 'file_resource') {
      const bytes = Buffer.from(command.bytes_base64, 'base64');
      fileResources.set(command.uri, bytes);
      driver.setFileResource(command.uri, bytes);
      result = true;
    } else if (command.cmd === 'cached_file') {
      const bytes = Buffer.from(command.bytes_base64, 'base64');
      cachedFiles.set(command.file_path, bytes);
      driver.setCachedFile(command.file_path, bytes);
      result = true;
    } else if (command.cmd === 'sessions') {
      sessions = command.sessions;
      driver.setSessions(structuredClone(sessions));
      result = true;
    } else if (command.cmd === 'group_members') {
      groupMembers.set(command.session_id, structuredClone(command.members));
      driver.setGroupMembers(command.session_id, structuredClone(command.members));
      result = true;
    } else if (command.cmd === 'employees') {
      employees = command.employees;
      driver.setEmployees(structuredClone(employees));
      result = true;
    } else if (command.cmd === 'search_employees') {
      searchEmployees = command.employees;
      driver.setSearchEmployees(structuredClone(searchEmployees));
      result = true;
    } else if (command.cmd === 'calls') {
      result = await Promise.all(drivers.flatMap((item) => item.recordedCalls).map(async (call) => ({
        ...call,
        bytes_base64: ['file', 'image'].includes(call.type) ? (await readFile(call.payload)).toString('base64') : call.type === 'voice' && call.payload.filePath ? (await readFile(call.payload.filePath)).toString('base64') : undefined,
      })));
    } else if (command.cmd === 'health') {
      driver.emit('health', { kind: 'cdp_invalidated', startupGenerationId: driver.getStartupGenerationId(), connectionIdentity: null, observedAt: Date.now(), cause: new Error('模拟 CDP 断线') });
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
