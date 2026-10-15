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
| `send_voice_to_user` | `operation_id`, `login_name`, `text` | 合成语音的首次或已有私聊结果；成功包含正式 `sessionId` |
| `send_card_to_user` | `operation_id`, `login_name`, `kind`, `card` | 三类卡片的首次或已有私聊结果；成功包含正式 `sessionId` |
| `send_media_to_user` | `operation_id`, `login_name`, `kind`, `file_id`；可选 `name` | 图片/文件首次或已有私聊结果；成功包含正式 `sessionId` |
| `get_send_status` | `operation_id` | 原意图状态，不触发发送 |
| `get_sessions` | `{}` | `{sessions:[...]}`，保留 `id/type/nativeType/receiverId` |
| `get_group_members` | 规范原生正整数 `session_id`，须可表示为 JavaScript 安全整数；不接受其他字段 | `{members:[{id,name,loginName,departmentPaths,position}]}`，完整群成员资料 |
| `get_recent_messages` | 正安全整数 `session_id`；可选整数 `limit`，默认20、范围1～100；不接受其他字段 | `{messages:[{messageId,msgIdx,senderId,sender,content,timestamp,messageType,isRecalled}]}`，当前群真实历史摘要 |
| `get_user_profile` | `user_id` | `{profile:员工档案或null}`；工号必须来自原生 `login_name`，不能用 UID 回退值代替 |
| `search_employees` | 非空 `keyword`，最多 256 UTF-16 单位 | `{employees:[{id,name,loginName,departmentPaths}],hasMore:false}`，完整的当前账号可见搜索结果 |

`login_name` 仅去首尾空白，区分大小写。查询不要求 `operation_id`，不开放任意 IPC 或全组织同步。所有请求先核对实际登录 UID。

`get_group_members` 使用原生群会话ID，不是群接收对象ID或宿主上下文。Driver默认整轮期限30秒，Python单次等待35秒，不改变全局时限。成员按UID去重，工号、姓名、岗位及全部可见部门路径缺失时保留null；不截断到200人，不保证服务器此刻最新。空群正常返回空列表；非群、未知会话、档案错误或超时返回原生错误，不返回部分成员，也不写入发送意图数据库。

`get_recent_messages` 先定位明确原生群会话，再调用现有 `Driver.getRecentMessages`。未知会话、私聊及原生查询错误分别报错，不把错误伪装为空列表；空列表是正常结果。结果按原生索引升序、缺失索引置后；索引/作者UID/类型缺失保留null。只返回表中字段，不暴露raw、附件本机路径或展开已有聊天记录内层正文，不下载附件、不派发实时事件、不写发送意图或标已读。Python公共客户端读取前后复查群/发起人名单，等待使用默认请求时限。

`send_card_to_user` 的 `kind` 只允许 `app_card`、`url_card`、`biz_card`，`card` 沿用下表字段与完整校验。桥接调用对应 Driver 卡片方法，传入准确 `targetLoginName` 和 `operationId`；不接受会话覆盖、引用或提及，不依赖会话列表，不预发文本。首次发送使用 Driver 已有的准确工号原生上下文，由本次业务回执确认正式私聊会话。

`send_voice_to_user` 只接受 `operation_id/login_name/text`，正文非空且最长 128000 UTF-16 单位；不接收会话覆盖、音色、附件、路径、引用或提及。Python 等待 90 秒，沿用当前 Driver 的 Edge 合成、KK9 编码及语音原生提交，调用 `sendVoice({text}, {targetLoginName, operationId})`。首次私聊由本次语音回执确认正式会话，不预发文字，不切窗口，不创建第二个 Driver/CDP 连接。

语音发送将 Driver 连接时绑定的发送者 UID 保留至原生提交，在合成/编码后及创建草稿前核对实际账号。已观察到的账号变化返回 `failed/isPreTrigger:true`，不创建草稿或提交；绑定 UID 是 Driver 内部信息，不增加协议参数。该核对不是 KK9 提供的原子事务，不承诺覆盖最后一次身份查询与原生调用之间不可观测的变化。

`send_media_to_user` 的 `kind` 只允许 `image` 或 `file`，`file_id` 为 32 位小写十六进制缓存标识，`name` 为可选非空文件名。只通过鉴权 `/files/{file_id}` 下载，不接收本地路径、URL、会话覆盖、引用或提及。下载后再次核对账号，分别调用 Driver `sendImage` / `sendFile`，只传准确 `targetLoginName` 与 `operationId`。首次私聊由本次附件发送确认正式会话，不预发文本。

`search_employees` 由 Driver 读完分页、按 UID 去重后才返回；失败或超时不返回部分成功，桥接不截断列表。`id` 为字符串 UID；`name`、真实 `loginName`、所有可见 `departmentPaths` 均可能为 `null`，不以 UID 或展示字段补工号。没有匹配返回空数组；单个可见结果不代表全公司唯一。该操作不创建会话、不发送、不标已读，不接受分页、发送目标或任意 IPC 参数。Driver 默认整轮期限 30 秒，Python 等待 35 秒以接收上游错误；桥接串行排队仍计入请求等待。


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
| `chat_record` | `record:{sourceSessionId,msgArray:[{messageId,msgIdx}]}`，来源必须等于目标，1～100项唯一消息ID | `sendChatRecord`，原生类型15 |

非文本消息不接受引用/提及。文件字段不接受本地路径或任意 URL；先通过附件接口传输实际字节。`mentions` 中 `uid="all"` 表示全体；正文仅在包含提及时可以为空。卡片文字字段非空、最长 128000 UTF-16 单位；额外字段被拒绝。业务卡片 `bizType=1|2`，`bizUrl` 是以 `/` 开头且非 `//` 开头的相对路径，`summary` 为字符串数组。

`voice_text` 只接受 `operation_id/target_session_id/kind/text`，不接受音色、文件、路径、引用或提及；现有 `voice + file_id` 继续用于发送实际音频文件，二者不是兼容回退。Python 对文字语音使用 90 秒请求时限，对人员搜索使用 35 秒；其他请求默认 30 秒不变，排队时间包含在请求等待内。

`chat_record` 仅接受消息引用，不接受标题、正文、作者、引用或提及。来源/目标与消息ID都为正安全整数字符串，msgIdx为正安全整数；重复消息ID、额外字段和不同来源被拒绝。Driver 重新读取同一来源的原生消息、校对ID/索引/作者/撤回状态并按原索引生成内容，不以调用者提供的正文拼造记录。它不是 `send_card_to_user` 的三类普通卡片，不支持准确工号首次私聊。同操作ID更换引用仍冲突，unknown只查询不重发。

## 响应与发送意图

```json
{"type":"response","id":"请求ID","ok":true,"result":{"status":"sent","operationId":"意图ID","messageId":"456","sessionId":"793803"}}
```

```json
{"type":"response","id":"请求ID","ok":false,"error":{"code":"INVALID_REQUEST","message":"请求格式无效"}}
```

发送请求的 `ok=true` 只表示调用返回，必须继续检查 `status=sent|failed|unknown`；只读查询返回各自的数据结构，不含发送状态。`sent` 是原生业务确认，不是送达/已读证明。保留 Driver 的 `operationId/status/messageId/sessionId/error/nativeCode/receipt/isPreTrigger/verifyLatencyMs`，未提供的字段省略；不返回 `success/delivered/recall`。

SQLite 在触发发送前声明意图。同一 ID 的目标、工号、内容、类型、引用或提及不同会冲突；相同意图重复调用不会再次触发，前置失败也不重新提交。发送记录保留正式会话和原生回执，迟到 `unknown` 不覆盖 `sent/failed`。

Python 请求超时或断线后不重新发送，只查询一次原 `operation_id`。仍未知则保留操作 ID 和原因；`notify_employee`、`notify_employee_voice`、`send_voice_text`、`send_card`、`send_media`、`send_chat_record` 返回结果供调用方处理，`send_chain` 抛出含 `result` 的 `BridgeError`。七类按需发送工具在提交前保存操作 ID，等待取消后仍能核查原意图。协议不保证进程重启后的入站补偿或端到端恰好一次处理。

员工和群黑白名单由 Python 公共客户端统一执行；Bridge RPC 是内部传输，不是另一个面向插件的无名单发送 API。管理员指令、事件回复和主动发送都经过该客户端。

模型工具必须使用真实 `KairoMessageEvent`。语音、卡片、图片和文件工具未传 `name` 时使用事件原始会话与发送者；传 `name` 时，仅真实管理员能按姓名跨会话推送。`kairo_notify_employee(name,text)`、`kairo_select_employee(choice)` 也仅向真实管理员开放，不接受平台、UID、工号、会话参数。非 Kairo 请求移除本插件全部工具，非管理员 Kairo 请求额外移除通知/选择工具；语音、卡片和附件保留当前会话能力，执行时拒绝非管理员传 `name`，图片/文件另拒绝非管理员传宿主 `path`。不修改全局启停或补回人格移除的工具。同一发送工具在同一事件中不能通过增删 `name` 再次尝试另一目标；每事件的一次尝试不替代 Driver 的持久发送记录。

`kairo_get_group_members` 是无参数只读工具，仅真实Kairo群事件可用；私聊和其他平台在请求筛选时移除，执行入口也拒绝。工具从事件保存的原生 `target_session_id` 取得群会话，宿主上下文或群显示字段改写不改变读取目标。普通成员可用，沿用群及发起人名单，等待全员资料后重新检查当前规则；不筛除名单中的个别成员来伪称全员。返回 `{session_id,total,members}` 的JSON工具结果，不设置发送完成标志，不接入发送重试或操作ID。

`kairo_get_chat_history(limit=20)` 与 `kairo_send_chat_record(messages)` 仅真实Kairo群可用，普通成员及管理员均沿用现有名单；私聊和其他平台在筛选及实际执行两处拒绝，不补回人格停用工具。历史是只读JSON结果，不设置发送完成标志；发送从事件保存的原群构造相同来源/目标，仅接受真实messageId/msgIdx，不接收name或任意目标。合并成功仅在sent时返回None结束默认主聊天Agent，失败/unknown继续说明并保留首次操作ID。已有聊天记录卡片的入站仍只提供摘要，本接口不展开该卡片的内层历史。

文本、语音、卡片和附件姓名通知共用候选状态，仅在一个完整搜索候选且姓名完全一致时自动发送。其余结果按序号展示真实身份和部门；下一条原生用户消息的明确数字选择必须与 `choice` 一致，不能由模型代选。候选及原始正文、完整卡片或附件快照按平台实例、原生会话和发起人隔离，并绑定 UID/工号快照；语音保存原始朗读文本，选择消息不能修改。同期同范围新通知替换旧意图，选择后消耗，重载后清空。发送前通过 `get_user_profile` 重查 UID 和真实工号，再走共用名单的 `send_to_user`、`send_voice_to_user`、`send_card_to_user` 或 `send_media_to_user`；缺失、变化或拒绝均不改投，不重新提交未知意图。附件在展示候选前保存字节，不重新读取源路径或选择消息的附件。原生事件高精度接收顺序拒绝同消息及候选产生前的选择，避免 Windows 宿主墙钟时间相同造成误拒绝。

语音通知在唯一姓名直接发送或编号选择完成后，仅当原生结果为 `sent` 才返回 `None` 结束默认主聊天 Agent，避免向来源群补发确认文字；候选、失败及 `unknown` 仍返回说明，未知结果保留原操作 ID 且不重发。其他姓名通知类型的既有成功回执行为不变。

`get_user_profile` 返回的 `profile.id` 由桥接统一为字符串，与 `search_employees` 候选 UID 使用相同格式；Driver 的原始数字 UID 不应被误判为身份缺失。`raw` 保留原始字段，`loginName` 仍只取真实 `raw.login_name`，不以 UID 代替工号。


## 附件与健康接口

- `POST /files?name=<URL编码文件名>`：请求体为原始字节，响应 `{file_id,name,size}`。
- `GET /files/{file_id}`：下载原始字节。
- `GET /health`：返回 `{"version":2,"connected":true}`，`connected` 为当前桥接状态。

所有接口需鉴权。`file_id` 为 32 位小写十六进制随机 ID；文件名去除路径和特殊字符，按 UTF-8 字节限制长度。Python 单文件上限 100 MiB，总缓存 1 GiB，保留 24 小时；Node 额外限制图片 20 MiB，发送及接收附件的桥接自管缓存默认保留 24 小时。仅从桥接本地 `dataDir/attachments/<32hex>/<安全文件名>` 上传；消息中的 KK9 缓存路径属于 KK9 机器，桥接不解析或直接读取，不再配置 `attachmentRoots`。

入站图片的独立原图判定与 URI 选择共用 Driver 的 `hasOriginalImageSource/getOriginalImageUri`；原图字段显式为空也不回退缩略图。所有图片都经当前 Driver 的 `downloadImage(image, localTarget)` 保存到桥接本机：Driver 优先读取 KK9 机器上的准确原图缓存，缓存不存在时才原生下载准确原图；仅有准确原图路径、没有 URI 也可保存。普通文件经 `saveFile(fileInfo, localTarget)` 保存已有 KK9 缓存，未缓存时仍不自动下载。图片按准确原图 URI 或缓存路径、文件按 KK9 缓存路径构造各自缓存键；每次保存使用独立随机 `.part` 文件，完整传输并检查大小后重命名发布，失败半文件不参与缓存命中。相同来源复用本地完整缓存并刷新保留期，上传失败不触发再次传输；失败逐项保留 `attachment_error` 和正文，不上传缩略图。`normalize(message, driver)` 必须传入具有 `downloadImage` 和 `saveFile` 的当前 Driver。此切换不改变 WS/HTTP 协议，不新增 Windows 文件服务；语音发送不等于完整语音接收。

当前配套 Driver 固定到 main 提交 [`8507d4eb8ac458b197e34a52a60e87de6ff0a2be`](https://github.com/dnslin/kairo-driver/commit/8507d4eb8ac458b197e34a52a60e87de6ff0a2be)，原生包含准确工号卡片、图片/文件及语音、连接发送者绑定和对应 Fake 行为；插件不再配置 Driver 自身补丁。包版本仍为 2.0.1，不能用版本号代替提交身份；原始 vendor checkout 不修改。协议保持 v2，当前会话 `voice_text` 调用方式不变，WAV 和 Edge SDK 两份第三方补丁继续保留。发送侧 `sendImage`、`sendFile`、`sendVoice({filePath})` 接收桥接所在机器的文件路径，Windows 传输及临时文件由 Driver 管理；原生目标、防重和 unknown 不重发规则不变。`cdp.url` 接受可达的 HTTP/HTTPS 发现基址及路径前缀，不含凭据、查询、片段或末尾 `/json`；发现返回的 WebSocket 地址必须从桥接机器可达，Driver 不自动改写。
