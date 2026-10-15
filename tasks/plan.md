# Kairo 插件全面重构方案（已批准）

状态：用户已回复“按方案开始”，批准能力划分、默认行为和实施顺序。代码实现与离线验证已完成，结果见 [todo.md](todo.md)。用户随后选择自行手动测试真实 KK9；本轮未自动向真实员工或群发送测试消息，真机验收尚未完成，步骤见 [README](../README.md#5-手动验收)。

本文件第8节为后续提出的“按需语音与原生卡片工具”补充方案，尚未批准实施，不属于上文已批准范围；原有T14人工验收保留，不因新方案自动完成。

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

## 8. 按需语音与 KK 原生卡片工具（方案 B 已确认）

### 8.1 已确认的选择

用户选择 Driver 文本 TTS 的方案 B：插件工具 → 公共客户端 → 明确桥接请求 → Driver 合成及原生发送。模型按自然语言要求选择能力，不另加关键词判断、第二个意图模型或严格指令门禁；这不是零误触承诺。不使用方案 A，不调用 AstrBot TTS，不安装宿主 FFmpeg，不建立双引擎或自动回退。

普通聊天继续文字。按需卡片复用已存在的三类原生消息；合并转发、按钮回调、审批流程及真实业务对象创建仍不在本轮范围。插件不会自动修改 `reply_format`、自动语音总开关、人格工具集合或生产进程。

### 8.2 模块与依赖

| 模块 | 职责 | 依赖及位置 |
| --- | --- | --- |
| 按需工具 | 四个显式 schema 工具、当前 Kairo 请求筛选、当前事件的一次尝试 | `main.py`、`tools.py`，AstrBot FunctionTool/ToolSet/默认聊天 Agent |
| 文本语音客户端 | 复查名单、固定原生目标、原生结果及独立等待预算 | `client.py`、`transport.py` |
| 明确语音分派 | `voice_text + text` 直接进入已有 `sendVoice({text})` | `bridge/src/protocol.ts`、`bridge/src/bridge.ts`，不经过附件通道 |
| 三类卡片 | 普通文字构造固定 Json 字段，复用完整卡片预检和发送 | `tools.py` → `event.send()` → 既有 `KairoClient.send_chain()` |
| Driver 网络前提 | 把非空标准进程代理显式传入已有 Edge SDK | Driver `voice-ops.ts`，不新增语音引擎、依赖或 KK 配置字段 |

### 8.3 工具契约

| 工具 | 模型输入 |
| --- | --- |
| `kairo_send_voice` | `text` |
| `kairo_send_app_card` | `title`, `text`, 可选 `linkUrl` |
| `kairo_send_url_card` | `title`, `summary`, `linkUrl`, 可选 `picUrl` |
| `kairo_send_biz_card` | `title`, `text`, `bizType`, 真实 `bizUrl`, 可选字符串数组 `summary` |

- 必须是真实 `KairoMessageEvent` 且平台名为 `kairo`；模型参数不接受目标会话、工号、文件路径、任意 Json 或 HTML。使用事件保留的原生目标和群发送者，不能由改写后的上下文标识重定向。
- 初始化注册一次，工具归属于主插件，启停及重载由宿主管理。`on_llm_request` 只从非 Kairo 的本次集合移除本插件工具，不修改全局 active、不补回人格或用户停用的工具；`func_tool=None` 保持不变。
- 本地参数无效时不提交，允许纠正参数；首次实际尝试在 await 前记录于当前事件，同能力的重复/并发调用共享首次结果，失败或 unknown 不重新提交。不同事件与不同能力状态独立，不新增持久状态机、锁或第二份发送数据库。
- 只有原生确认成功才返回 `None`，让默认主聊天 Agent 不再调用下一轮模型补“已发送”。同批剩余工具仍由宿主执行；前述一次尝试记录防重复。不能撤回工具前已输出的前言，不以 `stop_event` 作为成功协议。
- 失败保留原生原因，unknown 保留操作 ID，只查询原意图。执行等待被取消不重新提交；不将异常或超时冒充成功。
- 当前验证范围为默认 internal/tool-loop 主聊天 Agent，不宣称覆盖第三方 Agent 或子 Agent。

### 8.4 文本语音与网络

新增 `KairoClient.send_voice_text(target_session_id, text, sender_id=None, operation_id=None) -> dict`，沿用收发名单和 `sent/failed/unknown`。桥接新增 `kind=voice_text`，只接受意图 ID、原生目标和非空正文；不传音色、引用、提及或附件。原 `voice + file_id` 仍用于用户提供的有效 WAV/MP3，二者不是兼容回退。

固定 Driver 使用 Edge 及 KK 内置 AMR-NB 编码器，默认音色 `zh-CN-XiaoxiaoNeural`；不继承 AstrBot 的 TTS 提供商、音色、语速或代理。文字语音单请求等待 90 秒：合成总体 deadline 30 秒、编码最多 30 秒、提交及回执最多 20 秒并留余量。普通请求默认 30 秒不变，默认工具执行时限 120 秒建议保留；排队或断线仍可能产生 unknown，不重试发送。

实际合成发现现有网络直连 Edge 返回 403；仅向 SDK 显式传入本机已有代理后，实际合成及 KK 原生 AMR 编码/回解通过。为使正常生产入口获得同一网络路径，Driver 读取 Node 进程非空 `HTTPS_PROXY`，其次 `HTTP_PROXY`，trim 后传入 SDK 已有 `proxy` 选项。未设置保持直连；指定代理失败不换路线。不读取 Windows 注册表、AstrBot 配置或 `ALL_PROXY`，不加 KK 专用代理参数。配套源码、准备脚本、目录依赖和锁文件一起固定，不能只留诊断进程里的临时注入。

### 8.5 卡片语义

应用正文由插件转义 HTML、归一化换行并转为 `<br>`；链接摘要和业务正文遵守既有普通文字契约。三类消息全部复用原 `KairoClient._card_params` 的完整预检，不新增协议或编写客户端内部载荷。

`bizType=1` 为任务样式、`2` 为日程样式。业务卡片不创建对象；缺少真实路径时不得编造。卡片单独发送，不附带 Reply/At。保持 `reply_format=text` 才是按需卡片；现有 `card` 模式仍把所有普通文字包装为应用卡片。

### 8.6 验证与交付边界

自动验证覆盖：真实框架工具注册及请求级集合、跨平台拒绝、人格停用保持、原始目标、动态名单、同批重复/并发、跨事件独立、特殊字符/换行、schema 与 UTF-16 边界、失败及 unknown、取消后不重发；真实默认 Agent 验证 sent 后只有一轮模型，失败/未知继续解释。Node 与 Python 双进程通过真实 WebSocket 和持久 SQLite 验证明确语音类型及意图冲突；编译产物独立运行仅用 Driver Fake 替代 KK9。

Driver 代理回归使用本地真实 CONNECT 拒绝服务器，不访问外网；真实合成与 KK 编码另行通过独立 CDP 连接观察，不调用 Driver.connect 接管生产 Hook，也不发送消息。命令为两个仓库的 `pnpm check`、插件 Python 全套 pytest 及相关 Ruff 检查；最终结果记录在开发说明与实施清单，不以规划描述替代证据。

私聊/群接收端实际播放、卡片呈现/跳转、普通或否定表达的真实模型选择仍需用户指定测试目标并人工观察。未授权不自动发送，不把生成 AMR、原生 sent 或替身测试当作播放/送达验收；不勾选原 T14 的其余人工项目。

### 8.7 API 依据

- [AstrBot 工具定义、注册与 schema](https://docs.astrbot.app/dev/star/guides/ai.html)
- [消息发送与 Json/Record](https://docs.astrbot.app/dev/star/guides/send-message.html)
- [LLM 请求钩子](https://docs.astrbot.app/dev/star/plugin.html#llm-请求时)
- [Edge SDK 已有代理选项](https://github.com/SchneeHertz/node-edge-tts)

实现以本地 AstrBot `4.29.0-beta.1` 源码的 FunctionTool、Context.add_llm_tools、FunctionToolExecutor 和 ToolLoopAgentRunner 为验证基线；不修改宿主枚举、核心执行器或内置 send_message_to_user。

## 9. 管理员按姓名通知（已确认并实施）

用户确认自然语言主动通知仅管理员可用，并要求继续实现插件侧。依赖固定为 Driver `29e95f622a3aef1e5fbe266381431041803ef8b9`；上游负责全分页可见人员搜索、UID 去重及真实姓名/工号/部门路径，插件不重做分页、不将结果称为全公司唯一。

桥接只新增 `search_employees(keyword)` 只读动作。Python `search_employees` 校验完整结果并等待 35 秒；`notify_employee_uid` 发送前重查 UID/工号快照，再走原 `notify_employee` 名单与意图路径，不新增发送协议或兼容层。

`kairo_notify_employee(name,text)` 仅在单个完全匹配姓名时直接发文本，否则保存完整正文及候选序号到 UID 的映射，展示姓名/真实工号/全部部门路径。`kairo_select_employee(choice)` 只接受下一条原生用户消息中一致的明确数字选择，不接受模型给出的目标或正文；同消息、旧消息和跨范围选择不执行。缺工号、无匹配、身份变化、名单拒绝均不猜人。

候选及最新意图按平台实例、原生会话、发起人隔离；新通知覆盖旧意图，旧在途搜索不能恢复状态，选择先消耗再等待。高精度原生事件接收时间避免 Windows 宿主墙钟相同误拒绝下一条消息。权限在请求集合及实际执行两处检查，发起员工/群与接收员工动态名单均沿用公共客户端；重复、并发、取消及未知结果不重新提交。

已执行 TypeScript 构建、44 项 Node、286 项 Python、Ruff 静态/20 文件格式检查；独立编译产物真实 WS/SQLite 烟测验证完整流程，仅 KK9 使用 Fake。真实模型自然语言提取、候选展示与选择、真实接收端通知仍需授权人工验收，不自动向生产联系人发消息、不重启服务、不扩大原 T14 范围。命令与失败诊断见开发说明。

## 10. 卡片及图片文件跨会话扩展（已实施）

三个卡片工具和新增 `kairo_send_image`、`kairo_send_file` 通过可选员工姓名 `name` 复用管理员查询与下一条消息编号选择；不传姓名保持当前会话。附件默认使用当前消息中对应类型的第一个附件，支持从 1 开始的 `attachment_index`；仅管理员可改用已存在的宿主 `path`，不接受 URL。先缓存附件字节，再查询姓名，后续选择不重读源文件或选择消息的附件。

新增 `send_card_to_user`、`send_media_to_user`，Driver 使用准确工号原生上下文直接首次发送，不预发文本建立会话。三类内容共用 UID/工号复查、动态名单、候选隔离和持久发送意图，不增加兼容路径或第二套审批状态。发送实现已合入上游 `db186e05a7df`，固定源码通过标准归档依赖安装，不再保留 Driver 自身补丁；两份音频依赖补丁保留，原始 checkout 不修改。

已完成冻结安装、构建、86 项 Node、357 项 Python、Ruff 及独立编译产物 HTTP/WS/SQLite 烟测。真实模型的工具选择和接收端呈现仍待授权人工验收，未发送生产消息、重启服务或关闭原 T14 项目。完整证据见开发说明。

## 11. 当前群全员资料查询（已实施，0.7.0）

新增无参数 `kairo_get_group_members`，仅读取当前真实Kairo群事件保存的原生会话，普通成员和管理员沿用既有群及发起人工号名单；私聊、其他平台及任意目标参数拒绝。返回完整 `{session_id,total,members}`，成员含UID、真实工号、姓名、全部可见部门路径和岗位，缺失字段为null；不截断或返回部分成功，不保证服务器实时最新。

复用固定Driver `db186e05a7df` 的只读能力，新增桥接 `get_group_members` 及公共客户端，Python单次等待35秒并在返回前复查当前规则。只读路径不进入发送状态、重试或候选确认，不新建缓存、依赖和兼容层。构建、88项Node/376项Python及独立编译产物烟测通过，真机名单与模型选择仍需人工验收。

