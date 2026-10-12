# Kairo Windows 桥接程序

在运行 KK9 的 Windows 电脑上启动此程序。它连接本机 CDP，并主动通过 WebSocket 连接 AstrBot 的 Kairo 平台。KK9 使用完整消息收发，不提供流式输出。

要求 Node.js **22.13 或更新版本**、Git、pnpm **11.19.0**。建议使用 Node.js 24。无需安装 Windows 服务。

## 安装与启动

在本目录的 PowerShell 中执行：

```powershell
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm build
Copy-Item config.example.json config.json
```

编辑 `config.json` 后执行：

```powershell
pnpm start
```

也可以运行 `./start.ps1`，或指定另一份配置：

```powershell
pnpm start --config C:\kairo\config.json
```

启动前完全退出 KK9，再用实际安装路径启动并登录机器人账号：

```powershell
& "C:\Path\To\KK9.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

也可以直接运行 `./start-kk9-cdp.bat` 自动查找默认安装路径并带调试参数启动。

`http://127.0.0.1:9222/json` 应能列出 KK9 页面。如果页面地址不包含 `renderer.html`，请把 `cdp.pageMatch` 改成实际 URL 的稳定片段。

首次配置可读取当前机器人 UID（只读取身份，不发送消息）：

```powershell
pnpm whoami
```

先停止已运行的桥接程序，再执行此命令，避免两个 Driver 争用 KK9 Hook。命令通过公开 Driver 接口读取 UID。若 CDP 参数不同，可先设置 `$env:KAIRO_CDP_URL` 和 `$env:KAIRO_PAGE_MATCH`；默认仍为本机 9222 端口及 `renderer.html`。把输出 UID 填入本端 `expectedUserId` 和 AstrBot 端 `bot_uid`。

| 配置 | 用途 |
| --- | --- |
| `serverUrl` | AstrBot Kairo 平台监听地址，如 `http://192.168.1.20:6190`；仅主机和端口，不含路径 |
| `token` | 与 AstrBot 端完全一致的随机 token，至少 32 个 ASCII 字符、不含空白；可用环境变量 `KAIRO_BRIDGE_TOKEN` 覆盖 |
| `expectedUserId` | KK9 机器人实际登录 UID，使用字符串 |
| `cdp.url` | 本机 KK9 CDP 地址，只允许回环地址 |
| `cdp.pageMatch` | KK9 主页面 URL 匹配片段 |
| `attachmentRoots` | 允许读取的 KK9 缓存目录；默认空数组，不读取任何本地附件 |
| `dataDir` | 发送操作数据库和临时附件目录，相对路径以配置文件目录为准 |
| `reconnectDelayMs` | 连接恢复间隔，默认 3000 毫秒 |
| `pendingEventLimit` | 未收到 ACK 的入站消息数量上限，默认 256 |
| `fileRetentionHours` | 已下载发送附件的保留时间，默认 24 小时 |

生成随机 token：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

跨机器部署时，`serverUrl` 使用 AstrBot 机器的可达地址；服务端监听端口需要可达。通过公网连接时使用 HTTPS/WSS。两个进程要设置相同 token 和机器人 UID。

## 附件

只读取 `attachmentRoots` 内已经存在的真实文件；会解析真实路径并阻止符号链接越界。Windows JSON 路径需要双反斜杠，例如：

```json
"attachmentRoots": ["C:\\Users\\your-name\\实际的KK9缓存目录"]
```

这里应填写真实缓存目录，不要使用整个用户目录或磁盘根目录。未缓存的图片/文件会带不可读取说明转交 AstrBot，其他文字正常处理。当前 Driver 没有公开远程附件下载接口，因此桥接不会主动下载未缓存的 KK9 附件。

AstrBot 发来的附件按 `file_id` 从配置好的服务下载到 `dataDir`，然后交给 Driver。图片限制 20 MiB，普通文件和语音通道限制 100 MiB。语音通过 `sendVoice({filePath})` 发送有效 WAV/MP3，不新增文字转语音服务。文本支持 `@` 和引用；图片、文件、语音及三类卡片不支持附带原生引用或提及。

## 连接与发送记录

- 每次连接和发送前核对实际登录 UID，账号不符时停止该连接的收发。
- WebSocket 断线后重连并重放当前进程内未收到 ACK 的入站消息。Driver 失效时先清理旧实例，再新建实例。
- 只消费 `message` 事件中的 `inbound` 消息，避免自身回显和 `at` 快捷事件造成重复。
- `dataDir/send-operations.sqlite` 持久保存 `operation_id`、目标工号、内容摘要和发送结果。`sent` 是原生发送确认，不是已读或送达证明；`failed` 保留原因；`unknown` 表示结果不确定，只查询同一个 ID，不自动重发。同一 ID 的前置失败也不会重新提交，迟到的 unknown 不覆盖已确认终态。
- 入站未确认队列保存在内存中，进程退出会丢失；连接中断期间 KK9 未发出的历史事件也不自动补偿。队列满时程序报错停止，需要人工检查未处理消息。
- 附件文件定期过期清理；发送操作记录保留用于防重，不要在有未确认发送时删除数据库。

## 依赖与验证

Driver 固定到 `dnslin/kairo-driver` 提交 `15eb384f38c96fbfa9f5f6064713d5740f4bc45f`。新旧 Driver 的包版本同为 2.0.0，不能凭包版本判断接口。准备脚本在 `vendor/kairo-driver-15eb384f38c9` 检出固定源码并构建，通过同名 `file:` 目录依赖消费；不再应用旧 `driver-native-send.patch`，仅保留上游两份音频依赖补丁。

准备脚本使用独立临时检出目录，检出完成才放入最终目录；中断遗留的临时目录不阻止下次准备。已有最终目录若提交不符或跟踪文件被修改，报告路径和原因，不 reset 或覆盖使用者修改。可用 `KAIRO_DRIVER_SOURCE` 指定源码仓库来源，固定提交要求不变。

本版使用协议 v2；Python 插件与桥接必须一起更新，旧协议、旧界面会话 ID 和旧数据不提供兼容或迁移。停止已有桥接，更新源码后执行：

```powershell
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

同时重启 AstrBot。无需删除现存运行目录或发送数据库；不会自动重发历史未知操作。首次安装及 CI 也必须先准备 Driver，再冻结安装。

```powershell
pnpm check
```

自动检查覆盖协议 v2、原生会话路由、三类卡片和媒体分派、工号首次通知、方向筛选、ACK 重放、发送防重、账号校验和附件路径限制。已完成实际 WebSocket/HTTP 双进程离线 smoke；真实 KK9 收发、语音编码及播放、卡片呈现、缓存格式与 CDP 恢复仍需手动验收，步骤见[主说明](../README.md#5-手动验收)。
