# Kairo for AstrBot

通过 [kairo-driver](https://github.com/dnslin/kairo-driver) 把 KK9 接入 AstrBot，无需修改 AstrBot 源码。

根目录是 AstrBot 平台插件，`bridge/` 是运行在 KK9 电脑上的 Node.js 桥接程序。Windows 主动连接 AstrBot；KK9 的 CDP（客户端调试接口）只保留在本机。

**0.2.0 已完成离线验证，真实 KK9 收发及接收端呈现待手动验收。** 下表描述已接通的实现，不等于真机测试通过。KK9 不支持流式输出，本插件等完整回复生成后发送。

## 能力范围

| 功能 | 实现范围 |
| --- | --- |
| 私聊、群聊文本收发 | 按原生会话 ID 路由，不依赖当前聊天窗口 |
| 群聊 @ 机器人、@ 成员、@ 全体 | 映射为 AstrBot 提及组件；唤醒服从宿主配置，同一消息只提交一次 |
| 文本引用回复 | 保留真实引用作者；媒体和卡片不能附带原生引用或提及 |
| 收发共用黑白名单 | 每个平台实例分别配置准确工号、原生群会话 ID；主动发送和管理员通知同样受限 |
| 图片、语音、文件发送 | 跨机器传输实际文件；图片 20 MiB，文件/语音通道 100 MiB；语音输入为有效 WAV/MP3 |
| 图片、文件接收 | 图片优先读取允许目录内的原图，缺失时通过 KK9 原生接口下载原图后上传；文件仍仅读取已有缓存 |
| 私聊、群聊卡片回复 | 原生应用、链接、业务卡片；普通文字可选择自动转应用卡片 |
| 工号首次私聊通知 | 管理员指令和 Python 接口；仅文本，不要求已有会话 |
| 已有会话主动发送 | 统一客户端发送文字、媒体和卡片 |
| 群内员工上下文隔离 | 默认开启；关闭后整群共享上下文 |
| 连接恢复 | WebSocket 重连、未确认事件重放、失效 Driver 重建；不自动补发未知结果 |

模型、知识库、文件解析和语音生成继续由 AstrBot 负责。完整语音接收、卡片按钮、撤回、组织架构同步和历史消息补偿不在本轮范围。

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
| `host` / `port` | 默认 `0.0.0.0:6190`；接受 Windows 桥接连接 |
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

Docker 部署在原有 AstrBot 服务中追加 `6190:6190` 端口映射。Windows 必须能访问此端口；公网连接使用 HTTPS/WSS，不要公开 KK9 CDP 端口。

## 2. 启动 Windows 桥接

在 KK9 电脑安装 Node.js 24（最低 22.13）、Git、pnpm 11.19.0：

本次原图修复配套固定 Driver 提交 `f12d4e39d6d92224132148722f0646aafda8a8d6`，准备脚本、目录依赖及锁文件使用同一提交。无需本机开发仓库链接；按下列常规命令安装即可获得原图字段、下载接口及共用来源规则。

```powershell
git clone https://github.com/dnslin/astrbot_plugin_kairo.git
cd astrbot_plugin_kairo/bridge
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm build
Copy-Item config.example.json config.json
```

准备脚本获取固定新版 Driver 源码并构建，无需手动复制或修改相邻 Driver 仓库。更新时 Python 插件和桥接必须一起更新；协议 v2 不兼容旧桥接，旧会话标识和数据不做迁移。保留现有运行目录，不要删除发送数据库来解决 `unknown`。

完全退出 KK9，再按实际安装路径启动并登录机器人账号：

```powershell
& "C:\Path\To\KK9.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

也可用 `bridge/start-kk9-cdp.bat`。停止已运行的桥接后，通过 `pnpm run whoami` 只读获取 UID，填入 AstrBot 的 `bot_uid` 和以下配置的 `expectedUserId`：

```json
{
  "serverUrl": "http://你的AstrBot服务器IP:6190",
  "token": "与AstrBot中相同的随机Token",
  "expectedUserId": "机器人UID",
  "cdp": { "url": "http://127.0.0.1:9222", "pageMatch": "renderer.html" },
  "attachmentRoots": [],
  "dataDir": "./data"
}
```

生成 Token：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`attachmentRoots` 为空不影响发送附件，也不影响只有远端 URI 的图片通过原生接口下载到桥接自管目录；但不会允许读取 KK9 的任意本地路径。需要复用已有本地原图或接收文件时填写 KK9 实际缓存目录，例如 `"C:\\Users\\你的用户名\\实际缓存目录"`，不要填整个磁盘。已给出的本地路径越界、缓存歧义或读取错误不会靠下载掩盖。

启用 AstrBot 平台，再运行 `pnpm start`。看到“**AstrBot 桥接已连接，使用完整消息收发**”后按下文手动验收。更多参数见 [Windows 桥接说明](bridge/README.md)。

## 3. 工号通知和其他插件调用

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

每个 `operation_id` 代表一个固定发送意图，不能给另一条通知复用。`notify_employee` 返回 `sent/failed/unknown` 结果；名单拒绝、桥接不可用等调用错误会抛出 `BridgeError`。`send_chain` 成功返回 `None`，发送失败/未知会抛出带 `result` 的 `BridgeError`。通过 `await client.get_sessions()` 获取原生会话 ID 及会话类型，用于主动发送和配置群名单。

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

## 5. 手动验收

本轮真实 KK9 验收由使用者手动完成。先指定一个测试私聊、一个测试群和一个尚无会话的准确测试工号，避免误发到业务会话：

1. 私聊和群聊分别发送文字；群里测试 @ 本人、@ 他人、@ 全体和引用机器人，核对宿主唤醒设置及是否重复回复。
2. 开关群隔离，同群两位员工分别交谈；确认发送目标不随当前聊天窗口改变。
3. 配置员工/群黑名单、白名单及空白名单，检查入站、回复、主动发送、管理员通知均受规则约束。
4. 私聊和群聊分别发送图片、WAV/MP3 语音和文件，在接收端打开图片、播放到结尾、读取文件内容。
5. 分别观察三类卡片以及 `reply_format=card` 的换行和特殊字符；检查不支持的引用/@组合报错。
6. 向尚无会话的测试工号通知，核对正确员工和正式 `sessionId`；未知结果只按原 `operationId` 查询。
7. 重启桥接/KK9 后发送新消息，观察恢复和去重；不要求补回进程退出或 KK9 断线期间的历史消息。

## 运行边界

发送记录保存在 Windows `data/send-operations.sqlite`，Driver 重建继续使用。同一意图不会因为前置失败或进程重启而再次触发发送。入站 ACK 表示已交给 AstrBot（或已按名单拒绝），不代表模型处理或回复完成；未确认事件和去重状态仅在内存中。服务端附件默认保留 24 小时，总缓存 1 GiB；Windows 下载的发送附件及收到的原图缓存默认保留 24 小时，由 `fileRetentionHours` 控制。

原生发送确认与本机 KK9 气泡刷新是两步；本机页面暂未显示时，可切换会话后查看历史，不要仅凭页面没刷新重发。插件不强制切换聊天窗口。入站图片保留原生 `filepath_h/uri_h` 对应的原图信息：存在原图字段时不回退缩略图，原图未缓存则由 KK9 原生下载；下载或上传失败会保留具体说明，文本继续处理。没有原图字段的旧单一资源仍按原始资源处理。普通文件远程下载及完整语音接收不在本次范围内。

本次已通过真实原图下载、HTTP 上传及 AstrBot Image 文件字节核对，用户也已手动确认图片识别测试通过。代理没有为复核结果重复调用模型或主动发送消息；该结果不扩展为所有模型、其他媒体或客户端组合的验收。

新安装或升级插件后**重启 AstrBot 和桥接**。插件热重载不保证替换正在运行的平台实例。

## 待发布修复

- 入站图片改为原图缓存优先；缓存缺失时通过配套 Driver 的 KK9 原生接口下载实际原图，桥接自管缓存沿用附件保留期。原图失败不会把缩略图当成功，不新增用户配置；同步更新 Driver 固定提交、准备脚本、目录依赖和锁文件。
- 保留 URI-only 图片的精确缓存文件名匹配，缓存歧义及路径越界明确报错。
- 更正 UID 查询命令为 `pnpm run whoami`，避免误调用 pnpm 的包仓库账号查询。

## 0.2.0 变更记录

- 切换固定新版 Driver 和桥接协议 v2，移除旧发送补丁、旧界面会话标识和 `delivered/success` 发送结果。
- 统一事件回复、主动发送和公共客户端；加入共用员工/群黑白名单与完整群提及映射。
- 接通语音、三类原生卡片、卡片式普通回复和准确工号首次通知。
- 保留原生结果、正式会话 ID 和持久化发送记录；不通过重发掩盖未知结果。

开发命令、验证证据和接口细节见 [开发说明](docs/DEVELOPMENT.md)、[桥接协议](docs/PROTOCOL.md) 和 [实施清单](tasks/todo.md)。
