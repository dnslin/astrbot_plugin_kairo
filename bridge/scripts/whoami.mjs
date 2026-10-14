import { readFile } from 'node:fs/promises';
import { KK9Driver, setDriverLogSink } from '@kairo/driver';

setDriverLogSink(() => {});
let driver;
let cdpAddress;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('用法：pnpm run whoami [--config config.json]');
  let config = {};
  try {
    config = JSON.parse(await readFile(args[1] ?? 'config.json', 'utf8'));
  } catch (error) {
    // 首次初始化可尚无默认配置；显式文件缺失和损坏的配置必须报错。
    if (args.length || error.code !== 'ENOENT') throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象');
  const cdp = config.cdp ?? {};
  if (typeof cdp !== 'object' || Array.isArray(cdp)) throw new Error('cdp 必须是配置对象');
  const address = process.env.KAIRO_CDP_URL || (cdp.url ?? 'http://127.0.0.1:9222');
  const pageMatch = process.env.KAIRO_PAGE_MATCH || (cdp.pageMatch ?? 'renderer.html');
  if (typeof address !== 'string' || !address.trim()) throw new Error('cdp.url 必须是非空字符串');
  if (typeof pageMatch !== 'string' || !pageMatch.trim()) throw new Error('cdp.pageMatch 必须是非空字符串');
  const url = new URL(address.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#') || /\/json\/*$/.test(url.pathname)) {
    throw new Error('CDP 地址必须是 HTTP/HTTPS 发现基址，不含凭据、查询参数、片段或末尾 /json；允许路径前缀');
  }
  cdpAddress = url.toString();
  driver = new KK9Driver({ cdp: { url: cdpAddress, pageMatch: pageMatch.trim() }, rejectExistingBridge: true });
  driver.on('error', () => {});
  await driver.connect();
  const uid = await driver.getCurrentUserId();
  if (!uid) throw new Error('没有读取到 UID，请先登录 KK9 并等待主界面加载');
  console.log(uid);
} catch (error) {
  const reason = error instanceof Error ? error.message : '读取 KK9 UID 失败';
  console.error(cdpAddress ? `${reason}（CDP: ${cdpAddress}）` : reason);
  process.exitCode = 1;
} finally {
  await driver?.disconnect().catch(() => {});
}
