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
| `app_card` | `card:{title,content,linkUrl?,pcAppCode?}` | `sendAppMessage` |
| `url_card` | `card:{title,summary,linkUrl,picUrl?}` | `sendUrlCard` |
| `biz_card` | `card:{title,content,bizType,bizUrl,summary?}` | `sendBizMessage` |

非文本消息不接受引用/提及。文件字段不接受本地路径或任意 URL；先通过附件接口传输实际字节。`mentions` 中 `uid="all"` 表示全体；正文仅在包含提及时可以为空。卡片文字字段非空、最长 128000 UTF-16 单位；额外字段被拒绝。业务卡片 `bizType=1|2`，`bizUrl` 是以 `/` 开头且非 `//` 开头的相对路径，`summary` 为字符串数组。

## 响应与发送意图

```json
{"type":"response","id":"请求ID","ok":true,"result":{"status":"sent","operationId":"意图ID","messageId":"456","sessionId":"793803"}}
```

```json
{"type":"response","id":"请求ID","ok":false,"error":{"code":"INVALID_REQUEST","message":"请求格式无效"}}
```

`ok=true` 只表示调用返回，必须继续检查 `status=sent|failed|unknown`。`sent` 是原生业务确认，不是送达/已读证明。保留 Driver 的 `operationId/status/messageId/sessionId/error/nativeCode/receipt/isPreTrigger/verifyLatencyMs`，未提供的字段省略；不返回 `success/delivered/recall`。

SQLite 在触发发送前声明意图。同一 ID 的目标、工号、内容、类型、引用或提及不同会冲突；相同意图重复调用不会再次触发，前置失败也不重新提交。发送记录保留正式会话和原生回执，迟到 `unknown` 不覆盖 `sent/failed`。

Python 请求超时或断线后不重新发送，只查询一次原 `operation_id`。仍未知则保留操作 ID 和原因；`notify_employee` 返回结果供调用方处理，`send_chain` 抛出含 `result` 的 `BridgeError`。协议不保证进程重启后的入站补偿或端到端恰好一次处理。

员工和群黑白名单由 Python 公共客户端统一执行；Bridge RPC 是内部传输，不是另一个面向插件的无名单发送 API。管理员指令、事件回复和主动发送都经过该客户端。

## 附件与健康接口

- `POST /files?name=<URL编码文件名>`：请求体为原始字节，响应 `{file_id,name,size}`。
- `GET /files/{file_id}`：下载原始字节。
- `GET /health`：返回 `{"version":2,"connected":true}`，`connected` 为当前桥接状态。

所有接口需鉴权。`file_id` 为 32 位小写十六进制随机 ID；文件名去除路径和特殊字符，按 UTF-8 字节限制长度。Python 单文件上限 100 MiB，总缓存 1 GiB，保留 24 小时；Node 额外限制图片 20 MiB，发送附件及入站原图自管缓存默认保留 24 小时。KK9 已有本地文件仅从 `attachmentRoots` 允许的实际目录读取；原生下载图片仅写入桥接自管 `dataDir/attachments/<32hex>/<安全文件名>` 并可从该目录上传。

入站图片存在 `originalFilePath/originalUri` 时只读取原图候选，不回退 `filePath/uri` 缩略图。允许目录内原图不存在或仅有原图远端 URI 时，通过当前 Driver 的 `downloadImage` 调用 KK9 原生接口下载；没有原图字段的旧单一资源可使用 `uri`。本地路径越界、候选歧义、非 ENOENT 读取错误及上传失败不触发下载。下载成功后按同一 URI 复用缓存并刷新保留期，下载失败不上传缩略图。此内部流程不增加 WS/HTTP 接口或用户配置；普通文件未缓存时仍不自动下载，语音发送不等于完整语音接收。

原图接口由固定 Driver 提交 `97729bc61e131592b9b850ad9ed922ca170188c8` 提供，准备脚本、目录依赖和锁文件同步更新，不依赖本机开发链接。用户已手动确认图片识别测试通过；代理未重复调用生产模型。
