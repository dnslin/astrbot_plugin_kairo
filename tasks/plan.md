# Kairo 插件全面重构方案（已批准）

状态：用户已回复“按方案开始”，批准能力划分、默认行为和实施顺序。代码实现与离线验证已完成，结果见 [todo.md](todo.md)。用户随后选择自行手动测试真实 KK9；本轮未自动向真实员工或群发送测试消息，真机验收尚未完成，步骤见 [README](../README.md#5-手动验收)。

## 1. 已确认范围

用户明确要求：群聊、黑白名单、图片/语音/文件发送、群聊 @ 监听、私聊与群聊卡片回复、通过工号主动发起单独私聊通知。

本轮选择已确认：

- “卡片恢复”指 **卡片回复**，不是断线恢复卡片状态。
- **收发共用同一套黑白名单**，主动通知也受限制。
- **没有需要保留的旧数据**；不增加旧协议兼容、旧会话映射或数据迁移，不主动删除现存运行目录。
- 工号通知提供 **管理员指令 + Python 接口**，供其他插件或定时任务使用；不新增模型工具和外部 HTTP 接口。
- “等等”暂不推导为建群、审批按钮、批量群发、组织架构同步、撤回或无界历史补偿。

整体审批同时确认本方案默认行为：保留群成员上下文隔离开关；普通回复可选文字或应用卡片；员工名单按准确工号、群名单按原生群会话 ID 配置。

## 2. 规划阶段调查依据与结论

### 版本基线

- AstrBot 本地源码与运行导入均为 `4.29.0-beta.1`；GitHub `/releases/latest` 本轮查询返回同名版本。发布正文称预发布，虽然 API 的 `prerelease` 字段为 false，不将它宣称为稳定版。
- 重构后的 Driver 本地 main 与 origin/main 引用均为 `15eb384f38c96fbfa9f5f6064713d5740f4bc45f`。尚未发布 npm；新旧包版本均为 `2.0.0`，不能凭包版本判断兼容性。本轮没有确认 Driver 工作区是否干净或已有 dist 是否同步。
- 插件当前绑定旧 Driver 提交 `b23829d6e65ddd99ab9ab019395ddba205b12b4a`，另施加 `driver-native-send.patch`；不能直接用旧准备脚本获取新版。
- 开发环境实测：Node `v24.14.0`、AstrBot 虚拟环境 Python `3.12.13`。

### 已定位的不兼容

| 位置 | 当前问题 | 重构决策 |
| --- | --- | --- |
| `bridge/src/protocol.ts:39-41` | 只接受 `0-用户` / `1-群`；仅允许 text/image/file | 使用原生会话 ID；按实际能力增加独立消息类型和工号入口 |
| `mapping.py:74-77` | 私聊目标会被重新拼成 `0-发送者` | 删除旧界面标识纠正逻辑，不由 UID 猜原生会话 |
| `adapter.py:160`、`protocol.ts:65-68` | 成功只认 delivered；序列化已删除的 success | 全链路统一 sent/failed/unknown，保留 operationId、正式 ID、原生错误与回执 |
| `bridge/src/operation-store.ts:13-50` | 前置失败允许重提交；不比较工号；unknown 可覆盖终态 | 遵守新 Store 契约，原子更新并保留已确认结果 |
| `adapter.py:175-180`、`mapping.py:167-170` | Record 发送被拒绝，收到语音只剩说明文字 | 本轮完整接通语音发送；不把说明文字声称为音频接收支持 |
| `transport.py:250-252` | 仅允许 send / get_send_status | 增加工号发送和名单所需的只读会话/档案查询，不暴露任意 IPC |
| `bridge/src/attachments.ts:122-147` | 只上传已缓存图片/文件，剥除 raw | 复用跨机器文件通道；自动下载未缓存 KK9 附件不是现成能力 |
| `main.py` | 仅导入适配器 | 增加管理员通知入口；平台连接仍由 AstrBot 管理 |

旧 README 的“支持”与用户反馈不一致。用户反馈作为实际缺陷处理；旧 Fake/Mock 测试及文档不能证明真实 KK9 可用。

### AstrBot 文档需要对照源码

官方平台教程仍有旧式 `Platform.__init__(event_queue)`、缺平台实例 ID 的 `PlatformMetadata`、只调用父类的主动发送示例，不能照抄。当前正确构造为 `Platform(config, event_queue)`；平台管理器向适配器传 `(platform_config, platform_settings, event_queue)`。

原生白名单只在入站流水线执行，不约束主动发送，也没有通用用户黑名单。`Context.send_message()` 返回值仅表示找到并调用了平台，不代表 KK9 送达。`Json` 只是自定义消息容器，不是通用卡片发送 API。

## 3. 能力划分与依赖

这是职责划分，不要求每个职责新建包、基类或服务进程。

| 模块 ID | 职责 | 依赖 | 主要位置 |
| --- | --- | --- | --- |
| driver-bridge | 新 Driver 消费、连接、发送记录、RPC 与附件传输 | 新 Driver | `bridge/src/*`、`transport.py` |
| message-codec | 原生身份、会话、提及、引用与消息组件转换 | driver-bridge 的明确载荷 | `mapping.py` |
| access-policy | 共用员工/群黑白名单，入站与出站判定 | 明确工号/原生群目标 | 新增 `policy.py` |
| message-client | 所有发送入口共用的名单检查、消息链分派与结果处理 | driver-bridge、access-policy | 新增 `client.py` |
| astrbot-platform | 事件提交、回复、主动会话路由、生命周期 | message-codec、message-client | `adapter.py`、`event.py` |
| native-cards | 应用/链接/业务卡片及可选卡片式文字回复 | message-client | 复用 `client.py` 与桥接分派，不建独立卡片框架 |
| employee-notify | 准确工号首次文本通知、管理员入口 | message-client、astrbot-platform | `main.py`、客户端公共方法 |

顺序：先完成新版 Driver 下私聊/群聊文字的闭环，再增加共用名单与 @ 行为，随后接通媒体、卡片、工号通知。真实 KK9 验收贯穿关键检查点；不把半升级的 Python/Node 组合投入使用。

## 4. 关键行为契约

### 4.1 原生身份与群聊

- 严格区分原生会话 ID、员工 UID、准确工号、上下文会话标识。所有按会话发送都使用原生 ID，不取当前窗口，不按名称猜目标。
- 私聊和群聊分别生成 FRIEND_MESSAGE / GROUP_MESSAGE；群信息、发送者和机器人身份独立保存。
- 回复目标固定在入站原生消息上；模型上下文被其他插件改写，不改变发送目标。
- 沿用 Kairo 独立的 `isolate_group_users` 开关，默认开启；编码中保存真实群会话 ID，主动发送能还原。关闭时全群共享上下文。
- AstrBot 的 `unique_session` 当前只支持列举的内置平台，不包含 Kairo。不得宣称两个开关等价，不修改宿主内部注册表去冒充支持；宿主 `/reset`、`/new` 的共享群管理员权限语义保持原样并写入说明。
- Driver 的 converter 仍有旧界面 ID 回退残留。插件不建立双路由兼容；出现非原生目标时保留原始标识并给出明确诊断，不静默改投其他会话。

### 4.2 群聊 @ 监听与唤醒

- 只把 Driver `message` 作为消息入口；同一原生消息不从 `message`、`at` 各提交一次。
- 处理真实入站身份，过滤本人回显、撤回和系统消息；消息身份使用原生会话 ID + 消息 ID。
- 将机器人/成员提及转为 `At`，将 all/-1 转为 `AtAll`；引用填充真实作者 UID，避免引用机器人无法唤醒。
- 群普通消息可以进入 AstrBot 既有处理流程，但适配器不强行将它标为唤醒。@ 本人、@ 全体、唤醒词、引用机器人和概率主动回复遵守宿主配置。
- “只在 @ 时回复”不是本方案默认承诺；需要这种严格模式时应单独确认，不能暗中覆盖宿主其他功能。

### 4.3 收发共用黑白名单

建议两组独立配置：员工黑/白名单、群黑/白名单。员工使用准确 `loginName`，群使用原生群会话 ID；私聊用户与群成员共用员工规则。不另外同步全量组织架构。

- 黑名单优先；白名单启用后，仅列出的对象通过，空列表表示无人/无群获准；关闭白名单则不施加该项限制。界面明确提示空列表含义。
- 私聊同时限制收到的员工和向该员工发送的内容；工号通知在提交前直接按准确工号判断。
- 群入站同时检查群和发送员工；对该消息的回复保留员工上下文，并再次检查当前规则。
- 主动群发送检查群目标；群消息对所有成员可见，不能通过员工黑名单向群内个别人隐藏内容。要阻止某群接收消息，必须限制该群。
- 管理员身份只决定能否调用通知指令，不绕过收发名单。被拒绝的入站不提交给模型，不自动回复；出站拒绝向调用方报告原因。
- UID 入站与已有私聊会话通过 `getUserProfile` / 原生会话查询得到准确工号；不以显示名匹配。仅在员工规则需要判断时查询，避免无规则时增加人员查询成本；查询失败保留错误，不用昵称或空身份继续发送。
- 事件回复、`send_by_session`、客户端公共方法和管理员通知全部经过同一 `message-client`；`get_client()` 不再直接向调用者暴露可绕过规则的 BridgeServer.request。
- AstrBot 原生白名单如果也被启用，仍可进一步限制入站；它不替代这里的规则，也不会自动同步到出站。

### 4.4 图片、语音、文件

本轮必验收的是私聊/群聊 **发送**：`Image`、`Record`、`File`。复用 AstrBot 媒体组件解析本地路径、URL、file URI 等，再通过现有鉴权文件通道传到运行 Driver 的机器。

- 图片调用 `sendImage`，文件调用 `sendFile`；不把 AstrBot 机器路径直接交给 Windows Driver。沿用 Driver 现行图片 20 MiB、文件 100 MiB 限制。
- 语音使用 `Record.convert_to_file_path()`；发送输入统一准备为 Driver 支持的 WAV/MP3。其他格式使用宿主已有音频转换能力或明确报错，不靠改后缀伪装格式。Driver 负责转为 KK9 所需 AMR。
- 复用 AstrBot 已有语音生成，不因接通语音而新增 EdgeTTS 文本合成入口或额外外部服务。
- 在适配器拿到的消息链内保留顺序，连续文字才合并，遇媒体先发送前面的文字。不使用跨附件合并文字的 `squash_plain()`。
- 宿主普通回复路径可能先发送语音；不修改 AstrBot 核心，也不声称平台能纠正上游已经发生的重排。
- 对 Driver 未实现的媒体提及/引用组合明确报告限制，不静默丢字段。类型复用不等于原生支持。
- 维持现有已缓存图片/文件接收能力，并真实暴露不可读取原因。本轮不把“自动下载未缓存 KK9 附件”或“完整语音接收”混入发送任务：上游无公共附件下载封装，语音完整数据仅在 raw 中；若追加这些要求，先明确 Driver 资源读取边界，不能复制真机示例的任意 IPC 成为第二套 Driver。

### 4.5 私聊和群聊卡片回复

- 通过明确的 Kairo `Json` 载荷区分应用、链接和业务卡片，分别调用 `sendAppMessage`、`sendUrlCard`、`sendBizMessage`，不虚构通用 `driver.sendCard()`。
- 提供平台级 `reply_format=text|card`，默认文字；选择 card 时，将普通文字回复变成应用卡片。自动包装只转义文字并保留换行，不把模型正文直接当可信 HTML。
- 主动发送和事件回复使用同一分派路径；私聊/群聊均验收卡片可见呈现，而不仅是函数返回成功。
- 链接卡片使用真实 URL；业务卡片要求真实 `bizType=1|2` 和相对 `bizUrl`。不伪造应用编号，不声称卡片展示创建了真实任务/日程。
- “卡片回复”指以卡片回应，不等于给卡片附加原生引用。卡片/语音的 replyTo、mentions 当前不受支持；不得吞掉这些字段。
- 合并转发、卡片按钮、编辑卡片、撤回卡片恢复不属于已确认范围。

### 4.6 工号首次通知

- 管理员命令建议：`/kairo notify <平台实例ID> <准确工号> <正文>`。正文允许空格；权限复用 AstrBot ADMIN 过滤器；实例 ID 必须明确，避免多机器人串发。
- Python 入口建议：从 `context.get_platform_inst(platform_id).get_client()` 获取客户端，再调用 `notify_employee(login_name, text, operation_id=...)`。名称与返回类型在批准后的模块契约中固定。
- 内部使用 `sendTextToUser()`，不要求对方已经发过消息或已有会话；工号仅去首尾空白，保留大小写，不模糊匹配昵称。
- 返回真实 `status`、`operationId`，成功时包含正式 `messageId` 和 `sessionId`；Python 调用方可保存后续原生路由。管理员界面不得把 sent 表述为对方已收到/已读。
- 找不到、工号歧义、无私聊权限和名单拒绝分别报告原因，不改投相似员工。
- 首次工号通知仅文本。没有媒体首次联系接口，不会擅自先发“建会话”文字；已有正式会话可走普通媒体/卡片发送。

### 4.7 结果、重连和生命周期

- sent 只代表本次原生业务确认；failed 保留实际错误；unknown 是正常的不确定结果，不通过重发掩盖。
- 同一 operationId 只代表一个发送意图；内容、类型、目标、工号、引用或提及改变必须是新意图。前置失败也不复用 ID 再提交。
- SQLite Store 保留工号指纹、正式会话 ID、原生错误及回执；原子更新不能让迟到 unknown 清除 sent/failed。
- 保留桥接短断线重连、ACK 和入站重放；ACK 不代表模型已处理完，内存事件不保证进程重启后恢复。不增加无界历史轮询或自动补发。
- Driver 失效后新建实例并复用发送记录；关闭仅释放本实例资源。不静默吞掉关键 Driver 错误，也不默认打印聊天正文。
- 平台 `run/terminate` 服从 AstrBot 管理。宿主插件热重载不会自动重建运行中的平台实例，本次明确要求适配器更新后重启 AstrBot，不引入另一套热更新监督器。

## 5. 实施与验收方式

详细任务及依赖记录在 [todo.md](todo.md)，本文件不复制第二份任务清单。

每个能力都必须有用户可见行为测试。重点覆盖：原生 ID 不串聊、同一群两员工上下文、@ 去重及宿主唤醒、共用名单的全部入口、媒体真实字节跨机器通道、卡片原生载荷、工号首次通知、同意图重复提交、迟到 unknown 与重启后的发送记录。

验证分两层：

1. 使用真实 AstrBot 类、真实 WebSocket/HTTP、新版 Driver Fake 和临时目录完成离线闭环；Fake 用于确定分支和错误，不宣称真机可用。
2. 使用用户授权的机器人、一个私聊、一个群及一个尚无会话的测试工号进行真实 KK9 验收；验收范围届时明确，不复用历史文档中的账号作为本轮授权。检查接收端图片可打开、语音可播放、文件可读取、卡片可呈现。没有授权或接收端观察时标记未验证，不将发送回执当呈现证明。

当前项目命令（实施后按修改范围执行，不是本轮通过声明）：

```powershell
# bridge 目录：依赖准备脚本已重构后才可执行，旧脚本会回退 Driver。
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm check

# 插件根目录；验证须隔离 AstrBot 运行数据。
$env:ASTRBOT_SOURCE = "D:/Person/AstrBot"
$env:ASTRBOT_ROOT = Join-Path $env:TEMP ("kairo-check-" + [guid]::NewGuid())
D:/Person/AstrBot/.venv/Scripts/python.exe -m pytest -q
D:/Person/AstrBot/.venv/Scripts/python.exe -m ruff check .
D:/Person/AstrBot/.venv/Scripts/python.exe -m ruff format --check .
```

`pytest` 的框架导入路径须由 conftest 设置，运行前确认虚拟环境含测试工具。临时数据目录由本轮验证创建并在结束后清理，不修改宿主实际 data。

完成每项 smoke 后同步相关 README/PROTOCOL/DEVELOPMENT 和用户可见变更记录，移除该能力已取代的旧路径；不先写“已支持”再等待实现。

## 6. 规划阶段已执行核对及副作用

- 已读取当前插件、测试、桥接、Driver 公共类型和实现，以及 AstrBot 最新在线文档、本地实现和发布元数据。
- 已实际运行 `node --version` 和 AstrBot 虚拟环境 `python.exe --version`。
- 已实际用 AstrBot 虚拟环境运行导入核对：确认版本、Group 模型、数字会话 ID 的 MessageSession 往返、Image/Record/File 媒体解析方法和 Json 组件。未启动桥接、未运行测试/构建、未连接或发送真实 KK9 消息。
- 这次导入触发 AstrBot 的配置规范化保存：日志报告移除 `provider_settings.image_compress_enabled`、`provider_settings.image_compress_options.quality` 并调整键顺序。配置类在 has_new 时调用 save_config；此副作用已向用户说明。没有手动编辑或还原该配置，后续导入/运行改用隔离的 ASTRBOT_ROOT。
- 本轮只新增规划文档，未修改插件、桥接或 Driver 实现，也没有执行旧 prepare 脚本。

## 7. 依据索引

官方在线资料：

- [AstrBot 平台适配器](https://docs.astrbot.app/dev/plugin-platform-adapter.html)
- [新版插件开发指南](https://docs.astrbot.app/dev/star/plugin-new.html)
- [处理消息事件](https://docs.astrbot.app/dev/star/guides/listen-message-event.html)
- [消息发送与主动发送](https://docs.astrbot.app/dev/star/guides/send-message.html)
- [本轮查询的 AstrBot 最新发布](https://github.com/AstrBotDevs/AstrBot/releases/tag/v4.29.0-beta.1)
- [Driver 工号通知已合并变更](https://github.com/dnslin/kairo-driver/pull/13)

本地源码证据：

- `D:/Person/AstrBot/astrbot/core/platform/{platform.py,register.py,message_session.py}`：平台构造、实例 ID、生命周期与会话协议。
- `D:/Person/AstrBot/astrbot/core/pipeline/waking_check/stage.py:18-33,86-92,115-159`：隔离白名单与真实 @/引用/私聊唤醒。
- `D:/Person/AstrBot/astrbot/core/pipeline/whitelist_check/stage.py:15-71`：宿主入站名单边界。
- `D:/Person/AstrBot/astrbot/core/star/context.py:645-708,792-806`：主动路由与按实例获取平台。
- `D:/Person/AstrBot/astrbot/core/message/components.py`、`preprocess_stage/stage.py`、`pipeline/respond/stage.py:280-340`：组件媒体解析、语音预处理及核心重排。
- `D:/Person/kairo-driver/src/types/index.ts:148-250,323-453`：媒体/卡片/工号/结果公开契约。
- `D:/Person/kairo-driver/src/send-operation.ts:20-61,139-205`：工号指纹与原子发送记录规则。
- `D:/Person/kairo-driver/src/bridge/{converter.ts,event-bridge.ts,voice-ops.ts,card-ops.ts,renderer-script.ts}`：消息身份、@ 去重、音频准备、卡片和工号原生实现。

## 审批点

本方案已获整体审批，代码与离线验收已按清单完成。真实 KK9 收发、媒体播放和卡片呈现由用户手动验收，不以离线 Fake 或 sent 回执代替接收端观察。
