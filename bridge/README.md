# Kairo 桥接程序

此 Node.js 程序可运行在 Linux 或 Windows，通过本机或远程 CDP 连接 Windows KK9，并主动通过 WebSocket 连接 AstrBot 的 Kairo 平台。不要求桥接与 KK9 同机、共享磁盘或另建 Windows 文件服务。KK9 使用完整消息收发，不提供流式输出。

桥接机器要求 Node.js **22.13 或更新版本**、Git、pnpm **11.19.0**，建议 Node.js 24。KK9 仍在 Windows 上启动并登录；本机部署也继续支持，无需安装 Windows 服务。

## 安装与启动

本版固定上游 [main 提交 `8507d4eb8ac458b197e34a52a60e87de6ff0a2be`](https://github.com/dnslin/kairo-driver/commit/8507d4eb8ac458b197e34a52a60e87de6ff0a2be)，原生包含准确工号卡片、图片、文件和语音发送及连接发送者绑定；保留 Edge TTS 清理、人员搜索、远程 CDP 和跨机器附件。包版本仍为 2.0.1，源码身份以提交为准；准备脚本与归档固定同一提交，不再配置或维护 Driver 自身补丁，不修改原始 checkout，不依赖本机开发链接。

### 1. 在 Windows 启动 KK9

完全退出 KK9，再用实际安装路径启动并登录机器人账号：

```powershell
& "C:\Path\To\KK9.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

也可以在 Windows 运行 `./start-kk9-cdp.bat` 自动查找默认安装路径并带调试参数启动。Windows 本地的 `http://127.0.0.1:9222/json` 应能列出 KK9 页面；若页面地址不含 `renderer.html`，把 `cdp.pageMatch` 改为实际 URL 的稳定片段。

### 2. 提供桥接可达的 CDP

同机部署保持 `cdp.url = http://127.0.0.1:9222`。Linux 桥接通过 SSH 隧道或限定来源的 Windows 端口转发访问，例如受限网络中的 `http://172.16.0.18:9222`。不要把无认证 CDP 裸露到公网。

`cdp.url` 是 HTTP/HTTPS 发现基址，支持远程主机、IPv6 和合法反向代理路径前缀，例如 `https://kk9.example.com/proxy/kk9`。禁止 URL 凭据、查询参数、片段、WebSocket 地址和末尾 `/json`。Driver 保留前缀，去掉尾斜杠后追加 `/json` 进行发现。

发现结果中的 `webSocketDebuggerUrl` **必须从桥接机器可达**，Driver 直接使用返回值，不自动改写主机、端口或 `ws/wss`。不要只转发发现 HTTP 请求却遗漏 WebSocket；SSH 隧道与反向代理也须满足这一地址约定。HTTPS/WSS 使用 Node 的正常证书校验。

### 3. 在 Linux 或 Windows 安装桥接

在桥接机器的本目录执行：

```text
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm build
```

首次安装复制配置，Linux：

```bash
cp config.example.json config.json
```

Windows PowerShell：

```powershell
Copy-Item config.example.json config.json
```

更新已有安装时先停止旧桥接，再准备、冻结安装及构建，不覆盖实际配置。旧的本机缓存根目录配置已移除，请从配置中删除该项；不需要清理发送数据库或关闭 pnpm 依赖检查。

### 4. 获取 UID 并配置

先停止已运行的桥接，避免两个 Driver 争用 KK9 Hook。命令只通过公开 Driver 接口读取身份，不发送消息。先填写 `config.json` 的 `cdp.url`，再执行以下命令；不要求提前填好机器人 UID、AstrBot 地址或 token：

```bash
pnpm run whoami
```

Linux 和 Windows 均默认读取当前目录 `config.json` 的 `cdp.url`、`cdp.pageMatch`，也可用 `pnpm run whoami --config /srv/kairo/config.json` 指定文件。优先级为 `KAIRO_CDP_URL` / `KAIRO_PAGE_MATCH` 环境变量、配置文件、默认本机 9222 / `renderer.html`。仅首次未创建默认配置时允许直接使用默认值或环境变量；显式文件缺失、JSON 损坏或字段类型错误均明确失败，不切换地址。失败输出包含实际 CDP 地址。把输出 UID 填入本端 `expectedUserId` 和 AstrBot 端 `bot_uid`。

未创建配置时，也可临时查询远程 KK9：Linux 执行 `KAIRO_CDP_URL=http://172.16.0.18:9222 pnpm run whoami`；Windows PowerShell 先执行 `$env:KAIRO_CDP_URL = "http://172.16.0.18:9222"`，再执行 `pnpm run whoami`。环境变量会覆盖已有文件，排查地址时注意终端中是否遗留旧值。

这里必须写 `pnpm run whoami`；`pnpm whoami` 是 pnpm 自带的包仓库账号查询，会要求登录 npm，与 KK9 无关。

| 配置 | 用途 |
| --- | --- |
| `serverUrl` | AstrBot Kairo 平台监听地址，如 `http://192.168.1.20:6190`；仅主机和端口，不含路径 |
| `token` | 与 AstrBot 端完全一致的随机 token，至少 32 个 ASCII 字符、不含空白；可用环境变量 `KAIRO_BRIDGE_TOKEN` 覆盖 |
| `expectedUserId` | KK9 机器人实际登录 UID，使用字符串 |
| `cdp.url` | 桥接可达的本机或远程 HTTP/HTTPS CDP 发现基址；允许路径前缀，禁止凭据、查询、片段及末尾 `/json` |
| `cdp.pageMatch` | KK9 主页面 URL 匹配片段 |
| `dataDir` | 桥接机器本地的发送操作数据库和附件目录；Linux 部署使用 Linux 路径，相对路径以配置文件目录为准 |
| `reconnectDelayMs` | 连接恢复间隔，默认 3000 毫秒 |
| `pendingEventLimit` | 未收到 ACK 的入站消息数量上限，默认 256 |
| `fileRetentionHours` | 桥接本地发送附件和接收附件缓存的保留时间，默认 24 小时 |

生成随机 token：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Linux 桥接 + Windows KK9 示例（同机部署只需把 `cdp.url` 改为 `http://127.0.0.1:9222`）：

```json
{
  "serverUrl": "http://192.168.1.20:6190",
  "token": "与AstrBot完全一致的至少32字符随机Token",
  "expectedUserId": "机器人UID",
  "cdp": { "url": "http://172.16.0.18:9222", "pageMatch": "renderer.html" },
  "dataDir": "./data"
}
```

`serverUrl` 指向 AstrBot 机器，`cdp.url` 指向 Windows KK9 的可达 CDP，二者不是同一地址。AstrBot 监听端口须从桥接机器可达，公网连接使用 HTTPS/WSS；两端配置相同 token 和机器人 UID。

### 5. 在桥接机器启动

编辑 `config.json`、启用 AstrBot 平台后执行 `pnpm start`。Linux 或 Windows 都可指定另一份本地配置，例如 Linux：

```bash
pnpm start --config /srv/kairo/config.json
```

Windows 也可以运行 `./start.ps1`，或 `pnpm start --config C:\kairo\config.json`。

## 附件

消息中的 `KK9ImageInfo.filePath/originalFilePath` 和 `KK9FileInfo.filePath` 属于 **Windows KK9 机器**。桥接不对它们做本地 `resolve/stat/readFile`，不扫描 KK9 缓存目录；只把完整消息资源信息交给 Driver。桥接本地 `dataDir` 与 Windows KK9 缓存是两个独立目录。

- 图片统一调用 `driver.downloadImage(image, bridgeLocalTarget)`：Driver 优先读取 KK9 准确原图缓存，只有缓存不存在才由原生接口下载，再经 CDP 保存到桥接本地目标。原图字段存在时不回退缩略图；没有原图字段的旧单一资源仍可作为原始资源。
- 普通文件统一调用 `driver.saveFile(fileInfo, bridgeLocalTarget)`：仅支持 **KK9 已缓存的普通附件**，经 CDP 保存到桥接本地目标。未缓存明确失败，不增加普通文件下载协议，不用桥接本地同名文件替代。
- 桥接仅对 Driver 保存出的本地文件检查大小并上传实际字节到 AstrBot；图片最多 20 MiB，普通文件最多 100 MiB。失败逐项带 `attachment_error` 转交，其他文字正常处理；桥接不会直接抓取消息中的 HTTP URL，也不新增下载开关。自管附件缓存沿用 `fileRetentionHours` 清理。

发送侧不变：AstrBot 附件按 `file_id` 从配置好的服务下载到桥接本地 `dataDir`，继续交给 `sendImage(file)`、`sendFile(file)`、`sendVoice({filePath: file})`。三个输入路径都属于 **桥接机器**；Linux 本地文件不需要复制到共享目录，也不能当作 Windows 原生路径传入。Driver 经已有 CDP 传输图片、普通文件；语音在桥接端读取有效 WAV/MP3 后传给 Windows 编码器。图片限制 20 MiB，普通文件和语音通道限制 100 MiB。

文字语音使用下节独立请求，不用文件冒充。文本支持 `@` 和引用；图片、文件、语音及三类卡片不支持附带原生引用或提及。

## 按需文字语音

Python 的专用工具经 `voice_text + text` 请求直接调用已有 `Driver.sendVoice({text})`，不新增服务，不调用 AstrBot TTS 或 FFmpeg。默认音色由 Driver 决定，自动语音开关不会被插件修改；普通对话仍应文字回复，工具选择由模型判断。

运行桥接的 Node 进程必须能访问 Edge。若网络需要代理，在桥接启动终端中设置实际地址。Windows PowerShell 示例：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
pnpm start
```

Linux 示例：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 pnpm start
```

Driver 优先非空 `HTTPS_PROXY`，其次非空 `HTTP_PROXY`，均未设置保持直连；不会自动读取 Windows 系统代理或 AstrBot 配置，也不在代理失败后尝试直连。Python 对文字语音使用 90 秒独立请求预算，排队或断线仍可能产生 unknown，只查原意图不重发。语音播放及卡片呈现需接收端手动验收，合成/编码通过不等于已播放。

## 连接与发送记录

- 每次连接和发送前核对实际登录 UID，账号不符时停止该连接的收发。语音还保留连接绑定的发送者 UID，在准备完成后及创建草稿前核对最新身份；准备或查人期间已观察到的换号返回 `failed`，不创建草稿、不提交消息。
- WebSocket 断线后重连并重放当前进程内未收到 ACK 的入站消息。Driver 失效时先清理旧实例，再新建实例。
- 只消费 `message` 事件中的 `inbound` 消息，避免自身回显和 `at` 快捷事件造成重复。
- `dataDir/send-operations.sqlite` 持久保存 `operation_id`、目标工号、内容摘要和发送结果。`sent` 是原生发送确认，不是已读或送达证明；`failed` 保留原因；`unknown` 表示结果不确定，只查询同一个 ID，不自动重发。同一 ID 的前置失败也不会重新提交，迟到的 unknown 不覆盖已确认终态。
- 入站未确认队列保存在内存中，进程退出会丢失；连接中断期间 KK9 未发出的历史事件也不自动补偿。队列满时程序报错停止，需要人工检查未处理消息。
- 附件文件定期过期清理；发送操作记录保留用于防重，不要在有未确认发送时删除数据库。

## 依赖与验证

Driver 固定到 `dnslin/kairo-driver` 的 main 提交 `8507d4eb8ac458b197e34a52a60e87de6ff0a2be`，不是以仍为 2.0.1 的包版本号或旧发布提交识别。准备脚本在 `vendor/kairo-driver-8507d4eb8ac4` 检出固定源码，再用标准 `pnpm pack` 的 prepack 构建并生成 `vendor/kairo-driver-8507d4eb8ac4.tgz`；桥接从该相对归档依赖安装，直接消费上游原生定向语音及账号核对。Driver 的 `patchedDependencies` 条目与补丁文件已删除；仅保留上游 WAV 解码及 `node-edge-tts@1.2.11.patch` 两份第三方音频依赖补丁。

桥接工作区同时将 `node-edge-tts` override 锁定为 1.2.11，并应用同一补丁；只改 Driver 提交而保留 1.2.10 的强制版本会继续安装旧 SDK。准备脚本核对新版补丁文件名及内容，冻结安装使用对应新锁文件。既有 `sendVoice({text})` 调用链、默认音色、标准代理优先级、KK 编码及未知不重发规则不变。


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

自动测试覆盖协议 v2、CDP 地址规则、原生会话路由、三类卡片和媒体分派、工号首次通知、方向筛选、ACK 重放、发送防重、账号校验及附件传输。Linux + Windows 真实部署仍须单独验收发现/WebSocket 可达性、图片原图与已缓存普通文件字节、语音播放、卡片呈现及 CDP 恢复，步骤见[主说明](../README.md#5-手动验收)。**上游 Driver 远程验收及以下历史本机结果不代表本插件此次远程适配已经通过。**

历史离线验证已完成实际 WebSocket/HTTP 双进程 smoke。历史原图缓存审计的桥接构建和32项Node回归、Python全套119项通过；独立编译产物烟测验证真实原图下载到独占临时文件、完成后发布、鉴权HTTP上传及重开缓存复用，580×180 PNG、138182字节一致。用户此前已手动确认图片识别测试通过，该轮代理未重复发送或调用模型。具体命令、边界及历史结果见[开发说明](../docs/DEVELOPMENT.md#原图缓存审计修复)。

历史按需工具实施阶段验证：配套 Driver 完整检查 409 项、桥接构建及 35 项 Node 测试、Python 最终全套 186 项通过；编译产物真实 WS/SQLite 闭环验证四类输出及防重，仅 KK9 使用 Fake。正常固定 Driver 通过标准进程代理完成真实 Edge 合成及 KK AMR 编码/回解，没有发送消息；接收端播放和卡片呈现仍需人工验收。历史发布曾配套 Driver 2.0.1 并补充代理 CONNECT 超时释放修复；当前依赖使用上述 main 固定提交。具体历史检查、失败记录及验证边界见[开发说明](../docs/DEVELOPMENT.md#按需语音与原生卡片工具方案-b)。

姓名通知接入：`search_employees` 只读调用 Driver 全分页搜索，保留 UID、可空真实姓名/工号/部门路径和 `hasMore:false`；不在桥接端截断候选或处理用户编号。管理员权限、候选状态和发送前 UID/工号核对由 Python 插件负责，再通过 `send_to_user` 发送文本、`send_card_to_user` 发送三类卡片或 `send_media_to_user` 发送图片/文件，均支持首次私聊且不预发其他消息。媒体仅接收缓存 `file_id` 及可选文件名，下载后再次核对账号；定向分派不允许会话覆盖、引用或提及。


0.5.1 同步验证：标准远端准备及冻结安装、`pnpm check` 构建和44项Node测试、Python全套286项通过。独立进程解析到桥接固定Driver及带补丁的SDK1.2.11，经本机既有代理真实合成19296字节MP3，解码为24000Hz、3.216秒、有声；临时音频已清理。未连接CDP或执行聊天操作，不将MP3合成当作KK编码或接收端播放验收。

卡片跨会话验证：标准准备、冻结安装、TypeScript 构建和 62 项 Node 测试、321 项 Python 测试通过；独立编译产物真实 AstrBot/WS/SQLite 烟测验证三类定向卡片、重名选择、首次联系及 unknown 不重发。仅 KK9 使用 Fake，未发送真实消息；客户端呈现仍需人工验收。生成归档两次重建字节一致，原始 vendor checkout 不修改。

图片文件跨会话验证：冻结安装、TypeScript 构建及 86 项 Node、357 项 Python 测试、Ruff 规则及 21 文件格式检查通过。真实生成 renderer 脚本验证定向字节、正式回执及取消清理；独立编译产物真实 AstrBot/HTTP/WS/SQLite 烟测验证首次图片、已有私聊文件及 unknown 不重发。仅 KK9 使用 Fake，未向真实员工发送消息，接收端图片/文件呈现仍待人工验收。

Driver 补丁合入后验证：从 GitHub main 固定提交重新准备归档，生成锁文件并冻结安装成功；桥接构建及 86 项 Node、357 项 Python 回归通过。独立编译产物 HTTP/WS/SQLite 烟测验证三类卡片、图片和文件按准确工号发送，真实附件字节与原名一致，unknown 不重发；共6次Fake原生提交，状态sent/sent/sent/sent/sent/unknown。未连接真实KK9或重启生产服务。

按姓名语音私聊验证：标准 `node scripts/prepare-driver.mjs`、`pnpm install --frozen-lockfile`、`pnpm check` 的构建及 110 项 Node 测试通过；Python 全套 409 项及相关 Ruff 检查通过。真实安装包的 TTS 替身、WAV 准备和原生发送 renderer 回归覆盖准确工号、正式回执、取消及 unknown 防重。独立编译产物烟测使用真实 AstrBot/HTTP/WS/SQLite，KK9 使用 Fake，验证重名选择后的首次语音私聊、原文快照、普通成员拒绝和 unknown 不重发；2 次语音提交、1 个 Driver 代次、持久状态 sent/unknown。未连接真实 KK9、重启生产服务或验证接收端播放。使用方法见[按需语音工具](../README.md#按需语音卡片与附件方案-b)。

