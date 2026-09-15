import { KK9Driver, setDriverLogSink } from '@kairo/driver';

setDriverLogSink(() => {});
let driver;
try {
  const url = new URL(process.env.KAIRO_CDP_URL || 'http://127.0.0.1:9222');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('KAIRO_CDP_URL 只允许本机回环地址');
  }
  driver = new KK9Driver({ cdp: { url: url.toString(), pageMatch: process.env.KAIRO_PAGE_MATCH || 'renderer.html' }, rejectExistingBridge: true });
  driver.on('error', () => {});
  await driver.connect();
  const uid = await driver.getCurrentUserId();
  if (!uid) throw new Error('没有读取到 UID，请先登录 KK9 并等待主界面加载');
  console.log(uid);
} catch (error) {
  console.error(error instanceof Error ? error.message : '读取 KK9 UID 失败');
  process.exitCode = 1;
} finally {
  await driver?.disconnect().catch(() => {});
}
