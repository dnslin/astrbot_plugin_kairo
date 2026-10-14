# Kairo 桥接协议 v2

Node 主动连接 Python 的 `/ws`，HTTP/WebSocket 都使用 `Authorization: Bearer <token>`，URL 不携带 Token。`serverUrl` 是服务器 origin（协议、主机、端口），不支持路径前缀。每个平台实例只接受一个桥接连接；10 秒内完成握手，版本或实际机器人 UID 不符时拒绝。v1 不兼容，不保留旧路由。

```json
{"type":"hello","version":2,"self_id":"100"}
```

```json
{"type":"ready","version":2}
```

## 入站消息与 ACK

```json
{
  "type": "event",
  "event_id": "原生会话ID和消息ID的稳定摘要",
  "message": {
    "id": "123", "messageId": "123", "sessionId": "793803",
    "sessionType": "group", "senderId": "42", "sender": "员工",
    "direction": "inbound", "content": "你好", "atMe": true
  }
}
```

消息主体沿用 `KK9Message`，移除 `raw`。附件保留元数据，去除 Windows `filePath/url/uri/originalFilePath/originalUri`；上传完成后增加 `file_id`，不可读取或原图下载失败时增加 `attachment_error`，其余文字继续提交。只消费 `message` 中的入站消息，忽略本人回显及 `at` 快捷事件，不进行第二次提交。

Python 完成事件提交或名单拒绝后返回 `{"type":"ack","event_id":"..."}`；重复事件只确认、不再次提交。暂时性处理错误保留未确认状态并关闭连接，供桥接重放。ACK 不表示模型处理完成、回复成功或接收端已读。去重缓存和未确认队列仅保存在内存中。

## 请求

`id` 匹配一次请求/响应；`operation_id` 标识一个固定发送意图及持久化结果，二者不能混用。

```json
{
  "type": "request", "id": "一次通信请求ID", "action": "send",
  "params": {
    "operation_id": "固定发送意图ID", "target_session_id": "793803",
    "kind": "text", "text": "完整回复",
    "mentions": [{"uid":"42","name":"员工"}], "reply_to": "123"
  }
}
```

`target_session_id` 必须是可表示为 JavaScript 安全整数的正整数字符串，不接受 UID、昵称、`0-UID`、`1-群ID` 或编码后的 AstrBot 上下文。Python 在发送前负责从上下文还原原生目标。

| `action` | `params` | 返回结果 |
| --- | --- | --- |
| `send` | `operation_id`, `target_session_id` 和下表消息字段 | 原生发送结果 |
| `send_to_user` | `operation_id`, `login_name`, `text` | 首次或已有私聊文本结果；成功包含正式 `sessionId` |
| `get_send_status` | `operation_id` | 原意图状态，不触发发送 |
| `get_sessions` | `{}` | `{sessions:[...]}`，保留 `id/type/nativeType/receiverId` |
| `get_user_profile` | `user_id` | `{profile:员工档案或null}`；工号必须来自原生 `login_name`，不能用 UID 回退值代替 |

`login_name` 仅去首尾空白，区分大小写。查询不要求 `operation_id`，不开放任意 IPC 或全组织同步。所有请求先核对实际登录 UID。

| `kind` | 消息字段 | Driver 调用 |
| --- | --- | --- |
| `text` | `text`；可选 `mentions`, `reply_to` | `sendText` |
| `image` | `file_id`；可选 `name` | `sendImage` |
| `file` | `file_id`；可选 `name` | `sendFile` |
| `voice` | `file_id`；可选 `name` | `sendVoice({filePath})` |
| `voice_text` | 非空 `text`，最长 128000 UTF-16 单位 | `sendVoice({text})`，不传附件 |
| `app_card` | `card:{title,content,linkUrl?,pcAppCode?}` | `sendAppMessage` |
| `url_card` | `card:{title,summary,linkUrl,picUrl?}` | `sendUrlCard` |
| `biz_card` | `card:{title,content,bizType,bizUrl,summary?}` | `sendBizMessage` |

非文本消息不接受引用/提及。文件字段不接受本地路径或任意 URL；先通过附件接口传输实际字节。`mentions` 中 `uid="all"` 表示全体；正文仅在包含提及时可以为空。卡片文字字段非空、最长 128000 UTF-16 单位；额外字段被拒绝。业务卡片 `bizType=1|2`，`bizUrl` 是以 `/` 开头且非 `//` 开头的相对路径，`summary` 为字符串数组。

`voice_text` 只接受 `operation_id/target_session_id/kind/text`，不接受音色、文件、路径、引用或提及；现有 `voice + file_id` 继续用于发送实际音频文件，二者不是兼容回退。Python 仅对文字语音使用 90 秒请求时限，不改变其他请求的默认 30 秒；排队时间包含在请求等待内。

## 响应与发送意图

```json
{"type":"response","id":"请求ID","ok":true,"result":{"status":"sent","operationId":"意图ID","messageId":"456","sessionId":"793803"}}
```

```json
{"type":"response","id":"请求ID","ok":false,"error":{"code":"INVALID_REQUEST","message":"请求格式无效"}}
```

`ok=true` 只表示调用返回，必须继续检查 `status=sent|failed|unknown`。`sent` 是原生业务确认，不是送达/已读证明。保留 Driver 的 `operationId/status/messageId/sessionId/error/nativeCode/receipt/isPreTrigger/verifyLatencyMs`，未提供的字段省略；不返回 `success/delivered/recall`。

SQLite 在触发发送前声明意图。同一 ID 的目标、工号、内容、类型、引用或提及不同会冲突；相同意图重复调用不会再次触发，前置失败也不重新提交。发送记录保留正式会话和原生回执，迟到 `unknown` 不覆盖 `sent/failed`。

Python 请求超时或断线后不重新发送，只查询一次原 `operation_id`。仍未知则保留操作 ID 和原因；`notify_employee`、`send_voice_text`、单卡片 `send_card` 返回结果供调用方处理，`send_chain` 抛出含 `result` 的 `BridgeError`。四类按需工具在提交前保存操作 ID，等待取消后仍能核查原意图。协议不保证进程重启后的入站补偿或端到端恰好一次处理。

员工和群黑白名单由 Python 公共客户端统一执行；Bridge RPC 是内部传输，不是另一个面向插件的无名单发送 API。管理员指令、事件回复和主动发送都经过该客户端。

模型工具只使用真实 `KairoMessageEvent` 的原始会话与发送者，不从模型参数接收目标；非 Kairo 请求仅移除本插件工具，不修改全局启停或补回人格移除的工具。每事件、每能力的一次尝试记录只防止本事件重复调用，不替代 Driver 的持久发送记录。

## 附件与健康接口

- `POST /files?name=<URL编码文件名>`：请求体为原始字节，响应 `{file_id,name,size}`。
- `GET /files/{file_id}`：下载原始字节。
- `GET /health`：返回 `{"version":2,"connected":true}`，`connected` 为当前桥接状态。

所有接口需鉴权。`file_id` 为 32 位小写十六进制随机 ID；文件名去除路径和特殊字符，按 UTF-8 字节限制长度。Python 单文件上限 100 MiB，总缓存 1 GiB，保留 24 小时；Node 额外限制图片 20 MiB，发送及接收附件的桥接自管缓存默认保留 24 小时。仅从桥接本地 `dataDir/attachments/<32hex>/<安全文件名>` 上传；消息中的 KK9 缓存路径属于 KK9 机器，桥接不解析或直接读取，不再配置 `attachmentRoots`。

入站图片的独立原图判定与 URI 选择共用 Driver 的 `hasOriginalImageSource/getOriginalImageUri`；原图字段显式为空也不回退缩略图。所有图片都经当前 Driver 的 `downloadImage(image, localTarget)` 保存到桥接本机：Driver 优先读取 KK9 机器上的准确原图缓存，缓存不存在时才原生下载准确原图；仅有准确原图路径、没有 URI 也可保存。普通文件经 `saveFile(fileInfo, localTarget)` 保存已有 KK9 缓存，未缓存时仍不自动下载。图片按准确原图 URI 或缓存路径、文件按 KK9 缓存路径构造各自缓存键；每次保存使用独立随机 `.part` 文件，完整传输并检查大小后重命名发布，失败半文件不参与缓存命中。相同来源复用本地完整缓存并刷新保留期，上传失败不触发再次传输；失败逐项保留 `attachment_error` 和正文，不上传缩略图。`normalize(message, driver)` 必须传入具有 `downloadImage` 和 `saveFile` 的当前 Driver。此切换不改变 WS/HTTP 协议，不新增 Windows 文件服务；语音发送不等于完整语音接收。

当前配套 Driver 固定到合并远程附件支持后的 main 提交 [`1c4223fee51296ff68aa8f18b98d406bcdd800c8`](https://github.com/dnslin/kairo-driver/commit/1c4223fee51296ff68aa8f18b98d406bcdd800c8)，包版本仍为 2.0.1，不能用版本号代替提交身份。发送侧 `sendImage`、`sendFile`、`sendVoice({filePath})` 仍接收桥接所在机器的文件路径，Windows 传输及临时文件由 Driver 管理；既有原生目标、发送防重与 unknown 不重发语义不变。`cdp.url` 接受可达的 HTTP/HTTPS 发现基址及路径前缀，不含凭据、查询、片段或末尾 `/json`；发现返回的 WebSocket 地址必须从桥接机器可达，Driver 不自动改写。
