# Kairo 桥接协议 v1

Node 主动连接 Python 提供的 `/ws`。HTTP 与 WebSocket 都使用 `Authorization: Bearer <token>`，URL 不携带 token。`serverUrl` 是服务器 origin，不支持路径前缀。

一个平台实例只接受一个桥接连接；连接后 10 秒内完成握手，版本或实际机器人 UID 不符时拒绝。

```json
{"type":"hello","version":1,"self_id":"100"}
```

```json
{"type":"ready","version":1}
```

## 入站消息

```json
{
  "type": "event",
  "event_id": "会话ID和原生消息ID的稳定摘要",
  "message": {
    "id": "123",
    "messageId": "123",
    "sessionId": "1-200",
    "sessionType": "group",
    "senderId": "42",
    "sender": "员工",
    "direction": "inbound",
    "content": "你好"
  }
}
```

消息主体沿用 `KK9Message`，移除 `raw`。附件保留元数据，移除 `filePath`、`url`、`uri`，上传完成后增加 `file_id`；无法读取时增加 `attachment_error`。

Python 接收并提交事件后返回 `{"type":"ack","event_id":"..."}`。重复 ID 只确认、不再次提交。ACK 不是模型处理完成或回复成功的回执。去重缓存与未确认队列不持久化。

## 请求与结果

```json
{
  "type": "request",
  "id": "一次通信请求ID",
  "action": "send",
  "params": {
    "operation_id": "一次发送意图的固定ID",
    "target_session_id": "1-200",
    "kind": "text",
    "text": "完整回复",
    "mentions": [{"uid":"42","name":"员工"}],
    "reply_to": "123"
  }
}
```

- `kind` 为 `text`、`image` 或 `file`。
- `text` 使用 `text` 内容，可选 `mentions`、`reply_to`。
- `image`、`file` 使用 `file_id` 和可选 `name`，不接受本地路径、任意 URL、引用或提及。
- `get_send_status` 的参数仅为 `{"operation_id":"..."}`。
- `id` 匹配一次请求和响应，`operation_id` 匹配发送意图及其持久化状态，二者用途不同。

```json
{"type":"response","id":"请求ID","ok":true,"result":{"success":true,"status":"delivered","operationId":"操作ID","messageId":"456"}}
```

`ok: true` 表示 Driver 调用正常返回，必须继续检查 `result.status`，它也可能为 `failed` 或 `unknown`。`SendResult` 保留 Driver 的 camelCase 字段，去掉不能序列化的 `recall` 函数。

```json
{"type":"response","id":"请求ID","ok":false,"error":{"code":"INVALID_REQUEST","message":"请求格式无效"}}
```

Python 等待结果超时或连接丢失时，不重新调用 `send`。对未知结果只查询一次原操作 ID，仍未知则记录操作 ID 并报错。SQLite 在 Driver 触发发送前保存 `unknown` 记录，避免相同发送意图在重启后重新触发。协议不保证端到端恰好一次处理。

## 附件接口

- `POST /files?name=<URL编码文件名>`：请求体为原始文件字节，响应 `{file_id,name,size}`。
- `GET /files/{file_id}`：下载附件字节。
- `GET /health`：返回 `{version:1,connected:boolean}`。

所有接口均需鉴权。`file_id` 为 32 位小写十六进制随机 ID。文件名会移除路径与特殊字符，并按 UTF-8 字节限制长度。Python 服务单文件上限 100 MiB，总缓存 1 GiB，保留 24 小时；Node 额外限制图片为 20 MiB。Windows 的本地缓存只允许从 `attachmentRoots` 指定目录读取。
