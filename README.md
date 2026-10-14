# Kairo for AstrBot

通过 [kairo-driver](https://github.com/dnslin/kairo-driver) 把 KK9 接入 AstrBot，无需修改 AstrBot 源码。

根目录是 AstrBot 平台插件，`bridge/` 是运行在 Linux 或 Windows 上的 Node.js 桥接程序。桥接主动连接 AstrBot，并通过本机或远程 CDP（客户端调试接口）访问仍运行在 Windows 上的 KK9；不要求桥接与 KK9 同机，也不需要共享磁盘或另建 Windows 文件服务。

**当前源码支持 Linux 桥接连接远程 Windows KK9、跨机器附件，以及仅管理员可用的按姓名通知。** 本轮桥接构建及 44 项 Node、286 项 Python 检查通过；姓名通知已通过真实 WS/SQLite 的替身联调，真实模型选择与接收端呈现仍需人工验收。历史 Windows → Windows 真实附件验证不替代 Linux 真机验收。KK9 不支持流式输出，本插件等完整回复生成后发送。

## 能力范围

| 功能 | 实现范围 |
| --- | --- |
| 私聊、群聊文本收发 | 按原生会话 ID 路由，不依赖当前聊天窗口 |
| 群聊 @ 机器人、@ 成员、@ 全体 | 映射为 AstrBot 提及组件；唤醒服从宿主配置，同一消息只提交一次 |
| 文本引用回复 | 保留真实引用作者；媒体和卡片不能附带原生引用或提及 |
| 收发共用黑白名单 | 每个平台实例分别配置准确工号、原生群会话 ID；主动发送和管理员通知同样受限 |
| 图片、语音、文件发送 | 跨机器传输实际文件；图片 20 MiB，文件/语音通道 100 MiB；语音输入为有效 WAV/MP3 |
| 按需文字转语音 | 专用模型工具调用桥接端 Driver 合成并发送；不依赖 AstrBot TTS 或 FFmpeg |
| 图片、文件接收 | 图片由 Driver 读取 KK9 准确原图缓存或原生下载；普通文件由 Driver 传输 KK9 已有缓存 |
| 私聊、群聊卡片回复 | 原生应用、链接、业务卡片；普通文字可选择自动转应用卡片 |
| 员工首次私聊通知 | 文本、三类卡片、图片和文件；不要求已有会话，管理员命令仍只发文本 |
| 按姓名私聊通知 | 仅当前 Kairo 管理员；文本、卡片和附件共用查人、重名列表及下一条消息选择，发送前复查 UID 与真实工号 |
| 已有会话主动发送 | 统一客户端发送文字、媒体和卡片 |
| 群内员工上下文隔离 | 默认开启；关闭后整群共享上下文 |
| 连接恢复 | WebSocket 重连、未确认事件重放、失效 Driver 重建；不自动补发未知结果 |

模型、知识库和文件解析继续由 AstrBot 负责；按需文字转语音使用桥接端 Driver 的 Edge 服务。完整语音接收、卡片按钮、撤回、组织架构同步和历史消息补偿不在本轮范围。

## 1. 安装 AstrBot 插件

要求 Python 3.12+、AstrBot `>=4.29.0b1,<5`。本轮验证基线是 **4.29.0-beta.1**，不将该版本描述为稳定版。

在 AstrBot 插件管理页面通过以下仓库安装，然后重启 AstrBot：

```text
https://github.com/dnslin/astrbot_plugin_kairo
```

在消息平台新增 **Kairo（KK9）**：

| 配置项 | 用法 |
| --- | --- |
| 平台 ID | 如 `kairo`，多实例需不同 ID；使用后保持稳定 |
| `host` / `port` | 默认 `0.0.0.0:6190`；接受 Linux 或 Windows 桥接连接 |
| `token` | 两端一致，至少 32 个无空白 ASCII 字符 |
| `bot_uid` | Windows 实际登录的机器人 UID，与桥接 `expectedUserId` 一致 |
| `isolate_group_users` | 默认 `true`；关闭后整群共享上下文 |
| `reply_format` | 默认 `text`；`card` 把普通文字回复包装为应用卡片 |
| `user_blacklist` / `user_whitelist` | 准确工号字符串列表，区分大小写，不填昵称或 UID |
| `enable_user_whitelist` | 默认关闭；开启且列表为空时拒绝所有员工 |
| `group_blacklist` / `group_whitelist` | 原生群会话 ID 字符串列表，不填群名、群成员 UID 或 `1-xxx` |
| `enable_group_whitelist` | 默认关闭；开启且列表为空时拒绝所有群 |

黑名单优先。群入站同时检查群和发送员工，事件回复再次检查当前名单；主动群发送检查群目标。**员工黑名单不能向群内个别人隐藏群消息**，要禁止某群接收消息应限制该群。管理员不绕过目标名单。启用员工规则后，无法取得准确工号的入站会被拒绝并记录原因，不用昵称代替。

AstrBot 原生白名单仍可进一步限制入站，但不替代本插件的收发规则。群聊是否唤醒由 AstrBot 的 @、唤醒词、引用和其他配置决定，插件不会强制普通群消息唤醒。Kairo 的群隔离独立于宿主 `unique_session`；部分群会话管理命令仍需要 AstrBot 管理员权限。

Docker 部署在原有 AstrBot 服务中追加 `6190:6190` 端口映射。桥接机器必须能访问此端口；公网连接使用 HTTPS/WSS，不要公开 KK9 CDP 端口。

## 2. 启动 KK9 与桥接

### Windows：启动 KK9

完全退出 KK9，再按实际安装路径启动并登录机器人账号：

```powershell
& "C:\Path\To\KK9.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

也可用 `bridge/start-kk9-cdp.bat`。KK9 默认只监听 Windows 回环地址。本机部署可以直接使用 `http://127.0.0.1:9222`；Linux 桥接通过 SSH 隧道或限定来源的 Windows 端口转发访问，例如受限网络中的 `http://172.16.0.18:9222`。不要把无认证 CDP 裸露到公网。

`cdp.url` 填 HTTP/HTTPS **发现基址**，不填 WebSocket 地址、URL 凭据、查询参数、片段或末尾 `/json`。合法反向代理路径前缀会保留，例如 `https://kk9.example.com/cdp/kk9`；Driver 去掉尾斜杠后追加 `/json`。发现返回的 `webSocketDebuggerUrl` 必须从桥接机器可达，Driver 按原值连接，**不自动改写主机、端口或 ws/wss**；隧道/代理也必须满足这一条件。HTTPS/WSS 使用 Node 的正常证书校验。

### Linux 或 Windows：安装桥接

在桥接机器安装 Node.js 24（最低 22.13）、Git、pnpm 11.19.0。当前固定上游 [main 提交 `db186e05a7df6b94de041a9e8f9f8787e1d9d3a6`](https://github.com/dnslin/kairo-driver/commit/db186e05a7df6b94de041a9e8f9f8787e1d9d3a6)，原生包含三类卡片、图片及文件的准确工号定向发送，并保留 Edge TTS 新端点及资源清理、完整人员搜索、远程 CDP 与跨机器附件传输。上游包版本仍为 2.0.1，不能仅靠版本号区分源码；准备脚本从固定源码生成归档包，不需要本插件再给 Driver 打发送补丁，不依赖本机开发链接。两份音频依赖补丁仍保留。

Linux 执行：

```bash
git clone https://github.com/dnslin/astrbot_plugin_kairo.git
cd astrbot_plugin_kairo/bridge
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm build
cp config.example.json config.json
```

Windows 本机部署执行同样的准备、安装和构建命令，复制配置改用 PowerShell：

```powershell
Copy-Item config.example.json config.json
```

准备脚本获取固定 Driver 源码并构建，无需手动复制或修改相邻 Driver 仓库。升级时先停止桥接，Python 插件和桥接一起更新；协议 v2 不兼容旧桥接，旧会话标识和数据不做迁移。保留现有运行目录，不要删除发送数据库来解决 `unknown`。旧的本机缓存根目录配置已移除，升级配置时删除该项；同机部署也统一使用 Driver 传输附件。

停止已运行的桥接后，先在 `bridge/config.json` 填写 `cdp.url`，再在桥接目录只读获取 UID（无需先填机器人 UID）：

```bash
pnpm run whoami
```

Linux 和 Windows 均默认读取当前目录 `config.json` 的 `cdp.url`、`cdp.pageMatch`；其他配置可用 `pnpm run whoami --config /srv/kairo/config.json` 指定。临时覆盖地址使用 `KAIRO_CDP_URL`，覆盖页面片段使用 `KAIRO_PAGE_MATCH`，环境变量优先于文件。首次还没有默认配置时，可用环境变量直接查询；显式配置不存在或 JSON 损坏会明确报错，不切回本机。把 UID 填入 AstrBot 的 `bot_uid` 和桥接 `expectedUserId`。这里不能省略 `run`：`pnpm whoami` 是包仓库账号查询。

Linux 桥接 + Windows KK9 的配置示例：

```json
{
  "serverUrl": "http://你的AstrBot服务器IP:6190",
  "token": "与AstrBot中相同的随机Token",
  "expectedUserId": "机器人UID",
  "cdp": { "url": "http://172.16.0.18:9222", "pageMatch": "renderer.html" },
  "dataDir": "./data"
}
```

本机部署把 `cdp.url` 改为 `http://127.0.0.1:9222` 即可。`dataDir` 始终属于桥接机器；上述 Linux 部署会将数据库和附件保存到 Linux 本地，相对路径以配置文件目录为准，不填写 Windows KK9 缓存路径。

生成 Token（Linux/Windows 均可）：

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

接收图片统一调用 `driver.downloadImage(image, bridgeLocalTarget)`，优先准确原图缓存、缺失才由 KK9 原生下载；接收普通文件统一调用 `driver.saveFile(fileInfo, bridgeLocalTarget)`，**只支持 KK9 已缓存文件**，未缓存明确失败，不提供普通文件下载协议。消息中的 Windows 路径只交给 Driver，不在桥接机器解析、检查或读取。无需配置本机附件扫描目录。

发送图片、普通文件和语音分别继续调用 `sendImage(file)`、`sendFile(file)`、`sendVoice({filePath: file})`；输入均为桥接机器的本地文件。Driver 经 CDP 传输图片和普通文件，语音在桥接端读取有效 WAV/MP3 后交给 Windows 编码，不把 Linux 路径当作 Windows 原生路径。

启用 AstrBot 平台，再在桥接机器运行 `pnpm start`。看到“**AstrBot 桥接已连接，使用完整消息收发**”后按下文手动验收。更多参数见 [桥接说明](bridge/README.md)。

## 3. 按姓名、工号通知和其他插件调用

### 按姓名通知（仅管理员）

在 Kairo 私聊或群聊中说“给张三发一条消息：明天上午九点开会”。需要支持工具调用的模型，并在当前人格中启用 `kairo_notify_employee` 和 `kairo_select_employee`。身份以 AstrBot 管理员角色为准；普通用户不获得这两个工具，即使绕过模型筛选直接调用也会被拒绝。

- 搜索读完当前账号可见结果。只有一个候选且姓名完全一致时才直接发送；不能将本次可见结果称为“全公司唯一”。
- 重名或仅模糊匹配时，列出编号、姓名、真实工号和所有可见部门路径，尚不发送。管理员在**下一条消息**回复 `2`、`选第2个` 或 `选择第二个`；群聊仍须满足宿主唤醒规则，例如 @ 机器人后选择。模型不能代选，也不能在原消息内立即确认。
- 保存首次工具调用的正文、完整卡片或附件字节快照和“编号 → UID”映射，不按姓名重新绑定；发送前重查所选 UID 的真实工号，身份变化或工号缺失时不发送。没有匹配结果不猜人。
- 候选按平台实例、原生会话和发起人隔离；同范围新通知替换旧通知，选择后消耗，插件重载或重启后清空。选择工具不能修改正文或指定其他平台、工号、UID、会话。
- 发起员工、原群及接收员工继续受当前名单约束。重复/并发调用共享首次结果，失败、取消或 `unknown` 不重发；`sent` 仍不表示送达或已读。

自然语言工具选择及正文提取由聊天模型完成，不保证每种口语或否定表达都判断正确。仅更新 Driver 不够，Python 插件和 Node 桥接须一起更新并重启。

### 准确工号与其他插件调用


AstrBot 管理员使用：

```text
/kairo notify kairo E042 这是一条包含空格的通知
```

`kairo` 是平台实例 ID，`E042` 是准确工号。命令保留正文空格和换行。首次通知只发送这段文字，不额外发送“建立会话”消息。`sent` 只表示原生发送已确认，不代表对方已收到或已读。

其他插件通过已有 `context` 获取同一客户端：

```python
from astrbot.api.event import MessageChain
from astrbot.api.message_components import Plain

platform = context.get_platform_inst("kairo")
if platform is None or platform.meta().name != "kairo":
    raise RuntimeError("Kairo 平台实例未启用")
client = platform.get_client()
result = await client.notify_employee("E042", "通知正文", operation_id="job-20261012-E042")
if result["status"] == "sent":
    await client.send_chain(result["sessionId"], MessageChain([Plain("后续消息")]))
elif result["status"] == "unknown":
    result = await client.get_send_status(result["operationId"])  # 只查询，不重发
```

每个 `operation_id` 代表一个固定发送意图，不能给另一条消息复用。`notify_employee`、`send_voice_text` 和单卡片 `send_card` 返回 `sent/failed/unknown` 结果；名单拒绝、桥接不可用等调用错误会抛出 `BridgeError`。`send_chain` 成功返回 `None`，发送失败/未知会抛出带 `result` 的 `BridgeError`。通过 `await client.get_sessions()` 获取原生会话 ID 及会话类型，用于主动发送和配置群名单。

## 4. 卡片和媒体

`reply_format=card` 自动把普通文字转为应用卡片，转义 HTML 并保留换行。该模式不支持附带引用/@，请关闭宿主或插件的相关回复装饰，或改回 `text`。

显式卡片用 AstrBot `Json` 组件，经 `event.send()` 或 `client.send_chain()` 发送：

```python
from astrbot.api.event import MessageChain
from astrbot.api.message_components import Json

await event.send(MessageChain([Json({
    "type": "kairo.app", "title": "通知", "content": "<p>正文</p>"
})]))
```

| `type` | 必填字段 | 可选字段 |
| --- | --- | --- |
| `kairo.app` | `title`, `content` | `linkUrl`, `pcAppCode` |
| `kairo.url` | `title`, `summary`, `linkUrl` | `picUrl` |
| `kairo.biz` | `title`, `content`, `bizType`, `bizUrl` | `summary`（字符串数组） |

业务卡片的 `bizType` 只能是 1 或 2，`bizUrl` 必须是以 `/` 开头且非 `//` 开头的相对路径；卡片不创建真实任务或日程。显式应用卡片 `content` 是调用方提供的 HTML，不是模型正文自动包装接口。不支持其他平台的任意 Json 卡片。

媒体使用 AstrBot `Image`、`Record`、`File`。按适配器收到的消息链顺序发送，只有相邻文字合并；不纠正宿主在交给适配器前已做的重排。语音输入需有效 WAV/MP3，由 Driver 转换为 KK9 语音，其他格式明确报错，不靠改后缀转换。可以先发送引用/提及的文字，再独立发送媒体；媒体、语音和卡片本身不支持引用/@。

### 按需语音、卡片与附件（方案 B）

插件注册以下六个发送工具。需要支持工具调用的聊天模型，且当前人格允许使用对应工具；插件不会补回已停用的工具。工具须从真实 Kairo 私聊或群聊调用。语音只发当前会话；卡片、图片和文件不传 `name` 时发当前会话，管理员传员工姓名 `name` 时推送到该员工私聊，包括从未联系过的员工。模型不能指定平台实例、会话 ID、工号或 UID。图片、文件工具允许管理员指定已存在的宿主本地路径，普通用户只能转发当前消息的附件。

| 工具 | 输入 | 发送内容 |
| --- | --- | --- |
| `kairo_send_voice` | `text` | 由 Driver 合成指定文字并发送语音 |
| `kairo_send_app_card` | `title`, `text`；可选 `linkUrl`, `name` | 应用/公告卡片，正文自动转义 HTML 并保留换行 |
| `kairo_send_url_card` | `title`, `summary`, `linkUrl`；可选 `picUrl`, `name` | 链接卡片 |
| `kairo_send_biz_card` | `title`, `text`, `bizType`, `bizUrl`；可选字符串数组 `summary` 和 `name` | 已有业务的任务（1）或日程（2）样式通知，不创建业务对象 |
| `kairo_send_image` | 可选 `name`, `attachment_index` 或 `path` | 发送当前消息的图片，或管理员指定的已有本地图片 |
| `kairo_send_file` | 可选 `name`, `attachment_index` 或 `path` | 发送当前消息的文件，或管理员指定的已有本地文件，保留文件名 |

例如可以说“用语音说：明天上午九点开会”“给张三发公告卡片，标题是会议通知，正文是明天上午九点开会”，或附上附件后说“把这张图片发给张三”“把这个文件发给张三”。跨会话卡片和附件沿用上面的姓名通知规则：唯一且完全同名才直接发送，重名或模糊匹配须等待下一条用户消息选择；在人格中同时启用相应发送工具与 `kairo_select_employee`。普通用户仍可发当前会话卡片或转发当前附件，不能跨会话查人或推送。业务卡片需要真实、已知的业务路径；没有路径时不应编造。

附件默认使用当前消息中对应类型的第一个附件；`attachment_index` 从 1 开始，只统计图片或只统计文件。管理员可改用 `path` 指定 AstrBot 所在机器已有的本地文件，不能填 URL，不能与 `attachment_index` 同时使用。工具不会生成图片或文件，也不会猜测路径。展示姓名候选前先保存附件字节，选择时仍发送这份快照，不读取选择消息的附件或后来被修改的源文件。

要按需选择输出，保持 `reply_format=text`，并关闭 AstrBot 自动语音回复；这两个配置不会被插件自动修改。`reply_format=card` 仍表示所有普通文字自动转卡片，不是按需开关。自然语言是否调用工具由模型判断，不是严格指令触发，不能保证每种口语或否定表达都判断正确。

语音链路为工具 → `KairoClient.send_voice_text()` → `voice_text` 请求 → `Driver.sendVoice({text})`。不调用 AstrBot TTS、Python/Shell 工具或宿主 FFmpeg；使用 Driver 默认音色 `zh-CN-XiaoxiaoNeural`，不继承 AstrBot 的音色、语速或代理配置。运行桥接的 Node 进程必须能访问 Edge 服务。需要代理时，在桥接机器设置实际地址；Windows PowerShell 示例：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
pnpm start
```

Linux 示例：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 pnpm start
```

Driver 优先使用非空 `HTTPS_PROXY`，其次非空 `HTTP_PROXY`；均未设置时保持直连。不会自动读取 Windows 系统代理，指定代理失败也不会再尝试直连。文字语音请求单独等待最多 90 秒，其他请求默认 30 秒；工具执行超时建议保留 120 秒或以上。排队、断线或超时仍可能返回未知结果，只按原操作 ID 查询，不重发。

发送前仍核对当前员工/群名单及原始目标。同一事件的每个能力工具最多尝试一次发送，重复调用共享首次结果；只有原生确认成功才直接结束默认聊天 Agent 的下一轮续答，不另补“已发送”文字。不能撤回模型调用工具前已说出的前言；第三方 Agent 和子 Agent 不在本轮结束语义验证范围内。

其他插件也可显式调用：

```python
result = await client.send_voice_text("793803", "需要朗读的正文", operation_id="voice-job-42")
if result["status"] == "unknown":
    result = await client.get_send_status(result["operationId"])  # 只查询，不重新提交
```

## 5. 手动验收

升级后的真实 KK9 验收由使用者手动完成；Linux + Windows 远程部署还应核对 CDP 发现及返回 WebSocket 的可达性、图片原图和已缓存普通文件的实际字节。先指定一个测试私聊、一个测试群和一个尚无会话的准确测试工号，避免误发到业务会话：

1. 私聊和群聊分别发送文字；群里测试 @ 本人、@ 他人、@ 全体和引用机器人，核对宿主唤醒设置及是否重复回复。
2. 开关群隔离，同群两位员工分别交谈；确认发送目标不随当前聊天窗口改变。
3. 配置员工/群黑名单、白名单及空白名单，检查入站、回复、主动发送、管理员通知均受规则约束。
4. 私聊和群聊分别发送图片、WAV/MP3 语音和文件，在接收端打开图片、播放到结尾、读取文件内容。
5. 分别观察三类卡片以及 `reply_format=card` 的换行和特殊字符；检查不支持的引用/@组合报错。
6. 向尚无会话的测试工号通知，核对正确员工和正式 `sessionId`；未知结果只按原 `operationId` 查询。
7. 保持普通文字模式和自动语音关闭，分别请求语音、应用卡片和链接卡片；私聊/群聊检查语音播放到结尾、卡片特殊字符及链接。业务卡片使用确实存在的路径，不把样式通知当作创建任务或日程。普通聊天及否定要求不应调用这些工具，但自然语言模型误判仍需实际观察。
8. 重启桥接/KK9 后发送新消息，观察恢复和去重；不要求补回进程退出或 KK9 断线期间的历史消息。
9. 以管理员分别向已有私聊和从未联系过的员工推送三类卡片，检查接收人私聊中的卡片内容及链接，来源群不应出现该卡片。重名时先展示完整候选，下一条消息选择后再发送；普通用户跨会话推送应被拒绝。
10. 以管理员向已有私聊和首次联系员工推送图片、文件，检查原图可打开、文件名和字节正确，来源群无额外发送；重名选择使用原附件，普通用户指定员工或宿主路径应被拒绝。

## 运行边界

发送记录保存在桥接机器的 `dataDir/send-operations.sqlite`，Driver 重建继续使用。同一意图不会因为前置失败或进程重启而再次触发发送。入站 ACK 表示已交给 AstrBot（或已按名单拒绝），不代表模型处理或回复完成；未确认事件和去重状态仅在内存中。服务端附件默认保留 24 小时，总缓存 1 GiB；桥接本地下载的发送附件及接收附件默认保留 24 小时，由 `fileRetentionHours` 控制，Linux 部署不写 Windows 数据目录。

原生发送确认与 Windows KK9 气泡刷新是两步；页面暂未显示时，可切换会话后查看历史，不要仅凭页面没刷新重发。插件不强制切换聊天窗口。入站图片由 Driver 保留原生 `filepath_h/uri_h` 对应的原图语义：存在原图字段时不回退缩略图，原图未缓存则由 KK9 原生下载；下载或上传失败会保留具体说明，文本继续处理。没有原图字段的旧单一资源仍按原始资源处理。普通文件只能由 `saveFile` 传输 Windows KK9 已缓存内容，不能下载未缓存文件；完整语音接收不在本次范围内。

历史原图缓存审计已通过真实原图下载、HTTP 上传及 AstrBot Image 文件字节核对，用户也已手动确认图片识别测试通过。代理没有为复核结果重复调用模型或主动发送消息；该历史结果不扩展为此次远程适配、所有模型、其他媒体或客户端组合的验收。上游远程附件验收只证明上游记录的环境和范围，不替代本插件端到端验收。

新安装或升级插件后**重启 AstrBot 和桥接**。插件热重载不保证替换正在运行的平台实例。

## 0.6.0 变更记录

- 三个卡片工具新增可选员工姓名 `name`，支持管理员跨会话推送及首次私聊；不传姓名仍发当前会话。文本、卡片与附件共用重名候选、下一条消息编号选择、身份及动态名单复查，不预发文本建立会话。
- 新增 `kairo_send_image`、`kairo_send_file`，支持当前消息对应类型的附件及 `attachment_index`；管理员可指定已有宿主文件 `path`。附件在查人前保存字节快照，后续选择不替换内容，保留文件名；结果未知时不重发。
- 修复按姓名通知将数字 UID 误判为身份缺失的问题；真实工号缺失或身份变化仍拒绝发送。
- Driver 固定到已合入定向发送的上游 main `db186e05a7df6b94de041a9e8f9f8787e1d9d3a6`。准备脚本从固定源码生成标准归档，删除插件维护的 Driver 发送补丁及配置；保留 WAV 和 Edge TTS 两份音频依赖补丁。桥接协议 v2 和现有数据不变。
- 修复 Driver 归档的 gzip 系统标记随 Windows/Linux 变化而导致冻结安装校验失败的问题；统一该标记，不改源码或编译内容，保留归档完整性校验。
- 升级时在桥接目录依次执行 `node scripts/prepare-driver.mjs`、`pnpm install --frozen-lockfile`、`pnpm build`，然后重启 AstrBot 与桥接；保留配置、数据目录和发送记录。在人格中启用需要的卡片/附件工具及 `kairo_select_employee`，跨会话发起账号须为 AstrBot 管理员。
- 实现阶段已完成固定源码远端准备、冻结安装、桥接构建及 86 项 Node、357 项 Python 回归。编译产物 HTTP/WS/SQLite 烟测验证五类定向输出、原始附件字节和 unknown 防重；仅 KK9 使用 Fake，真实接收端呈现和模型选择仍需人工验收，未重启生产服务或发送真实消息。

## 0.5.1 变更记录

- 同步 Driver `c4c9c677fa8fe3bfa5c4d2ab94505f1b5918efaf`，将桥接实际使用的 `node-edge-tts` 从 1.2.10 升级并锁定为 1.2.11，采用新的合成服务端点。
- 同步上游 1.2.11 补丁，更新准备脚本、pnpm 补丁配置、强制版本及锁文件，删除旧补丁；保留超时、代理 CONNECT 取消、音频流和 WebSocket 清理行为。不改 Python 工具、语音接口或桥接协议。
- 固定源码从远端准备、冻结安装、构建及 44 项 Node、286 项 Python 测试通过；桥接实际安装的 SDK 经既有代理真实合成并解码为 3.216 秒有声 MP3。未发送消息，接收端播放及本版 KK 编码未重新验收。
- 升级须重新准备 Driver、冻结安装并构建桥接，再重启 AstrBot 与桥接；仅更新相邻 Driver 源码不会替换固定依赖。现有代理配置、数据目录及发送记录保持不变。

## 0.5.0 变更记录

- 新增管理员专用姓名通知和编号选择工具；保留原准确工号命令及共用名单策略。
- Driver 固定到 `29e95f622a3aef1e5fbe266381431041803ef8b9`，桥接新增只读 `search_employees`，不新增任意 IPC 或组织同步。
- 修复 Windows 宿主事件时间可能相同而拒绝下一条选择消息的问题；使用高精度原生事件接收顺序，保留旧消息与同消息拒绝。
- 实现阶段构建、44 项 Node 和 286 项 Python 检查及编译产物姓名通知烟测通过；本次发布按用户要求不重复测试。未重启生产服务或发送真实消息。本次不修改 Edge TTS 协议，不表示已修复语音 403。
- Python 插件与桥接版本同步为 `0.5.0`，发布 tag 为 `v0.5.0`。升级后重启 AstrBot 与桥接，并在人格中启用 `kairo_notify_employee`、`kairo_select_employee`；发起账号须被 AstrBot 识别为管理员。


## 0.4.0 变更记录

- 固定到上游 main 提交 `1c4223fee51296ff68aa8f18b98d406bcdd800c8`，允许现有 `cdp.url` 和 UID 命令连接远程 HTTP/HTTPS 发现基址，同时明确拒绝凭据、查询、片段和末尾 `/json`。
- 桥接可在 Linux 运行、KK9 保留在 Windows；接收图片和已缓存普通文件统一通过 Driver 传输，移除桥接扫描 KK9 本机缓存根目录的配置和实现。发送接口不变，输入文件路径属于桥接机器。
- 修复 UID 查询仍连接默认本机地址的问题：`pnpm run whoami` 默认读取桥接 `config.json`，支持 `--config`；环境变量可临时覆盖，失败时显示实际连接地址。
- 图片与文件保留独占临时路径、大小检查、完整缓存复用和保留期清理；普通文件未缓存时明确失败，不新增普通文件下载协议。
- 升级时先停止旧桥接，删除已移除的 `attachmentRoots` 配置，保留 `dataDir` 和发送数据库，重新准备 Driver、冻结安装并构建，再重启 AstrBot 与桥接。
- 历史本机验收事实继续保留；此次远程部署须独立验收，不把上游通过记录当成本插件通过。

## 0.3.0 变更记录

- 入站图片改为原图缓存优先；缓存缺失时通过配套 Driver 的 KK9 原生接口下载实际原图，桥接自管缓存沿用附件保留期。原图失败不会把缩略图当成功，不新增用户配置；同步更新 Driver 固定提交、准备脚本、目录依赖和锁文件。
- 早期版本曾保留 URI-only 图片的精确缓存文件名匹配及歧义/越界检查；当前远程适配已用 Driver 统一附件传输替代桥接本机扫描。
- 更正 UID 查询命令为 `pnpm run whoami`，避免误调用 pnpm 的包仓库账号查询。
- 新增仅当前 Kairo 会话的按需语音、应用/链接/业务卡片工具；保留人格停用选择、名单和原生目标，重复尝试及未知结果不重发，等待取消后保留原操作 ID 供查询。
- 新增明确的 `voice_text` 桥接类型和独立请求时限；文字合成由 Driver 完成，网络代理使用 Node 进程标准环境变量，不增加宿主 TTS 或兼容路径。
- 历史发布曾配套 Driver 2.0.1；当前源码身份以以上远程适配的 main 固定提交为准。
- 已知验证边界：真实接收端播放/卡片呈现及模型选择仍待人工验收；一次图片往返缺图未定位根因，后续完整检查和连续往返通过，不宣称已修复该偶发问题。

## 0.2.0 变更记录

- 切换固定新版 Driver 和桥接协议 v2，移除旧发送补丁、旧界面会话标识和 `delivered/success` 发送结果。
- 统一事件回复、主动发送和公共客户端；加入共用员工/群黑白名单与完整群提及映射。
- 接通语音、三类原生卡片、卡片式普通回复和准确工号首次通知。
- 保留原生结果、正式会话 ID 和持久化发送记录；不通过重发掩盖未知结果。

开发命令、验证证据和接口细节见 [开发说明](docs/DEVELOPMENT.md)、[桥接协议](docs/PROTOCOL.md) 和 [实施清单](tasks/todo.md)。
