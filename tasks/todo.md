# Kairo 重构实施清单

状态：**代码与离线交付已完成；真实 KK9 验收由用户手动执行，尚未验证。** 范围、行为、来源与边界以 [plan.md](plan.md) 为准；本文件记录任务依赖和验收结果。

## 检查点 A：新版 Driver 下文字私聊/群聊闭环

### T01：切换准确 Driver 源码来源

- [x] 将依赖来源固定到已调查的新版提交；不依赖仍为 2.0.0 的包版本号判断接口。
- [x] 移除旧原生发送补丁及其准备逻辑；保留实际仍需的两条音频依赖补丁。
- [x] 准备过程可重复运行，不 checkout/reset 相邻开发仓库，不无提示覆盖使用者修改。
- 文件：`bridge/scripts/prepare-driver.mjs`、`bridge/package.json`、`bridge/pnpm-lock.yaml`、`bridge/patches/driver-native-send.patch`；音频工作区配置仅在消费约定确需变化时调整。
- 验证：在隔离源码/依赖目录准备两次，核对实际消费入口和源码提交；首次无依赖也能得到构建后的 ESM。不要在 T02–T05 尚未完成时用新版半升级桥接替换现有运行安装。
- 依赖：方案获批、模块边界明确。

### T02：统一发送状态与持久记录

- [x] wire 结果删除 success/delivered，使用 sent/failed/unknown，保留正式会话、原生错误和回执。
- [x] Store 比较 targetLoginName；任何已声明意图都不再次 claim，包括前置失败。
- [x] 原子更新保留 sent/failed，不被迟到 unknown 清除；关闭重开库后行为一致。
- 文件：`bridge/src/protocol.ts`、`bridge/src/operation-store.ts`、`bridge/tests/protocol.test.ts`、`bridge/tests/store.test.ts`。
- 验证：同 ID 换工号冲突；同 ID 重复前置失败无再次提交；终态遇迟到 unknown 保留真实字段；数据库重开后仍可查询原意图。拒绝仅用“没有抛错”作为断言。
- 依赖：T01 的接口基线。

### T03：接通原生目标与名单所需查询

- [x] 桥接按原生 ID 发送，不接受旧界面 ID 作为另一条发送路径。
- [x] 加入准确会话/员工档案只读请求，保留 nativeType、receiverId、loginName；不暴露任意 IPC 或全量组织同步。
- [x] 入站、错误、断线与结果保留实际上下文；不把异常替换成无诊断的成功/空结果。
- 文件：`bridge/src/bridge.ts`、`bridge/src/protocol.ts`、`bridge/tests/bridge.test.ts`、`tests/node_fixture.mts`。
- 验证：双原生目标不串聊；本人回显不进入入站；身份切换不会沿用旧发送目标；查询失败原样传播。
- 依赖：T02。

### T04：重建 AstrBot 消息与上下文路由

- [x] 删除 `0-UID` 私聊目标纠正；区分发送目标和群成员上下文。
- [x] 私聊/群聊组件、Group、作者、时间戳与真实引用作者完整映射。
- [x] 隔离开/关及保存后解析的主动群目标均正确；坏身份保留诊断，不猜目标。
- 文件：`mapping.py`、`event.py`、`tests/test_mapping.py`。
- 验证：两群同员工、同群两员工、私聊与群聊互不串上下文；改写 event.session_id 后回复仍投原生目标；共享模式按群聚合。
- 依赖：T03 的载荷契约。

### T05：建立统一发送客户端

- [x] event.send、send_by_session、get_client 共用实际发送服务，不由外部直接调用 BridgeServer.request 发消息。
- [x] Python 识别 sent；未知只查询原 operationId；失败、未连接、原生错误区分明确。
- [x] 非流式声明与误用 streaming 的完整聚合都能工作，避免可变 delta、推理片段或最终全文导致重复发送。
- 文件：新增 `client.py`，修改 `adapter.py`、`transport.py`、`tests/test_adapter.py`、`tests/test_integration.py`。
- 验证：真实 AstrBot 类 + 实际 Node/Python WebSocket 双进程完成双目标文字收发；独立运行临时 smoke，观察事件队列与发送结果，而不只依赖测试。冻结安装后的 `pnpm check` 和 Python 对应测试须通过。
- 依赖：T02–T04。

- [x] 检查点 A：新版依赖、协议、Store、Python 一并交付；文字闭环可运行后再扩展能力。同步此阶段涉及的协议和开发说明，不发布半升级组合。

## 检查点 B：收发名单与群 @ 行为

### T06：实现共用员工/群黑白名单

- [x] 每个平台实例分别配置员工和群规则；黑名单优先、白名单启用为空时全部拒绝，界面提示清楚。
- [x] 入站提交、事件回复、主动会话发送和公共客户端统一检查；管理员不绕过目标规则。
- [x] 工号/UID/原生群目标使用统一身份语义；群广播不能按个别成员隐藏这一限制明确可见。
- 文件：新增 `policy.py`、`tests/test_policy.py`，修改 `client.py`、`adapter.py`、`tests/test_integration.py`。
- 验证：私聊、群、群成员；黑白重叠、空白名单、不同平台实例、修改名单后的再次发送；拒绝时没有事件进入模型或消息发出。姓名相同但工号不同不能误放行；档案失败不静默代用昵称。
- 依赖：T05。

### T07：贯穿群提及与宿主唤醒

- [x] message 单入口处理 @；all/-1 转为 AtAll；引用作者正确。
- [x] 单条消息仅提交一次，@ 他人不伪装 @ 本人；普通群消息不强制唤醒。
- [x] 覆盖 Kairo 自有隔离与宿主 unique_session、群会话命令权限的真实边界，不修改 AstrBot 核心注册表。
- 文件：`mapping.py`、`event.py`、`tests/test_mapping.py`、`tests/test_integration.py`。
- 验证：用真实宿主 WakingCheck 观察 @ 本人、@ 他人、@ 全体开/关、引用机器人、普通群消息；重放同一身份没有二次入队。
- 依赖：T06。

- [x] 检查点 B：名单贯穿全部已实现收发入口；宿主唤醒行为有运行证据。同步配置说明，不宣称员工黑名单能向群内特定成员隐藏群消息。

## 检查点 C：媒体与卡片

### T08：贯穿图片和文件跨机器收发

- [x] 公共客户端解析 AstrBot 媒体引用，桥接落地后再交 Driver；不混淆两台机器的路径。
- [x] 适配器消息链中的连续文字与媒体按原序发送；大小、缺失文件和不可读取原因准确传播。
- [x] 保持已缓存附件接收，不把远程资源地址冒充已取得文件。
- 文件：`client.py`、`bridge/src/attachments.ts`、`bridge/src/bridge.ts`、`bridge/src/protocol.ts`、`tests/test_integration.py`。
- 验证：使用真实 PNG 和有已知内容的文件，经实际 HTTP 双向传输后验证内容、发送目标及前后文字顺序；超限、过期、不支持引用组合有明确失败。真实 KK9 私聊和群聊图片可打开、文件可读取，授权后执行。
- 依赖：T07。

### T09：接通语音发送

- [x] Record 转实际音频文件，经现有文件通道传到 Driver，调用 sendVoice({filePath})。
- [x] WAV/MP3 输入有效；其他输入使用现有转换能力或明确报告限制；不增加第二套文字转语音服务。
- [x] 语音不支持提及/引用的组合在发送前明确拒绝，避免丢字段。
- 文件：`client.py`、`bridge/src/protocol.ts`、`bridge/src/bridge.ts`、`bridge/src/attachments.ts`、`tests/test_integration.py`。
- 验证：真实音频字节传输和正确原生目标；无效音频不能仅改后缀通过。授权后在私聊、群聊各检查接收端播放与结尾，无观察则仍标未验证。
- 依赖：T08。

### T10：接通私聊和群聊卡片回复

- [x] 固定 Kairo Json 卡片结构，分别分派应用、链接、业务卡片，不接受任意平台 Json 作为 Kairo 卡片。
- [x] reply_format 可选文字/卡片，普通文字转卡片时保留换行并转义 HTML；媒体混合链不被吞掉。
- [x] 使用真实卡片必填字段，失败保留原生原因；引用卡片、交互按钮不冒充支持。
- 文件：`client.py`、`adapter.py`、`bridge/src/protocol.ts`、`bridge/src/bridge.ts`、`tests/test_integration.py`。
- 验证：两类原生会话中的三种卡片载荷、名单拒绝、无效业务路径、混合文字/媒体顺序。授权后分别观察私聊/群聊实际卡片呈现，不能只查返回 sent。
- 依赖：T09。

- [x] 检查点 C：媒体和卡片的测试、独立 smoke 及可执行的真机项目均有记录。逐项更新支持矩阵，区分发送、缓存接收、自动下载和真实呈现。

## 检查点 D：工号首次通知与整体交付

### T11：建立受名单约束的工号通知客户端

- [x] Python 公共 notify_employee 与桥接 send_to_user 调用 Driver.sendTextToUser，保持准确工号及稳定 operationId。
- [x] 提交前执行同一员工名单；首次文本成功返回正式私聊 sessionId；不先发送额外“建会话”消息。
- [x] 找不到、歧义、权限失败、unknown 和断线结果区分清楚，不重新提交原意图。
- 文件：`client.py`、`bridge/src/protocol.ts`、`bridge/src/bridge.ts`、`tests/node_fixture.mts`、`tests/test_integration.py`。
- 验证：没有已有会话的注入员工首次通知、正式会话后续路由、同 ID 换工号、重复原意图、黑白名单拒绝、重开 Store；独立调用 Python 接口观察实际桥接输出。
- 依赖：T06、T10。

### T12：增加管理员通知指令

- [x] `/kairo notify <平台实例ID> <准确工号> <正文>` 复用 ADMIN 权限，完整保留含空格正文。
- [x] 明确多实例目标，拒绝非 Kairo/未启用实例；不把 sent 提示为已送达或已读。
- [x] 管理员与 Python 调用走同一客户端，无 HTTP 和模型工具额外入口。
- 文件：`main.py`、新增 `tests/test_plugin.py`、`tests/test_adapter.py`。
- 验证：管理员成功、普通用户无权、多实例不串发、目标名单拒绝、正文含空格及原生错误反馈。用真实 AstrBot 事件过滤和指令执行路径，不只直接调用 handler。
- 依赖：T11。

### T13：验证生命周期与不确定结果

- [x] start/terminate、平台重建、WebSocket 重连、Driver 新实例均正确释放自身资源。
- [x] 断线重放不重复处理；SQLite 跨实例状态不降级；unknown 不被自动重发。
- [x] 独立运行双进程 smoke，再运行相关完整检查；更新说明中明确插件更新后重启 AstrBot，不虚称热重载会更新平台实例。
- 文件：`adapter.py`、`transport.py`、`tests/test_transport.py`、`tests/test_integration.py`、`bridge/tests/bridge.test.ts`；仅修改发现的本次重构缺陷。
- 验证：临时端口反复启动停止，模拟断线、重连和已提交后失去回执；无悬空服务/重复回复，保留原操作 ID。随后运行 plan.md 所列 Node/Python 检查，报告实际命令和结果。
- 依赖：T12。

### T14：执行授权范围内的真实 KK9 验收

- [ ] 先取得本轮机器人、一个私聊、一个群、一个尚无会话的测试工号的明确授权；不引用历史文档里的目标作为授权。
- [ ] 观察群 @、私聊/群文字、名单拒绝、图片/语音/文件、卡片、首次工号通知与重连后的新消息。
- [ ] 记录原生回执和接收端观察的区别；未能执行的项目明确保留未验证，不能称全面可用。
- 验证：实际启动构建后的 bridge 与 AstrBot 插件，逐项操作指定目标；没有批量群发、无界历史扫描或自动重发。
- 依赖：T13、本轮真机授权和接收端观察条件。

- [x] 检查点 D（代码与离线交付）：所有已确认能力的实现、调用方、测试、配置说明、协议与用户可见变更记录同步；临时验证文件/进程清理；没有旧协议兼容路径或未实现入口。真实 KK9 呈现与收发仍保留 T14 未验收状态。

## 验证结果

- `pnpm check`：TypeScript 构建及 18 个 Node 测试通过。
- `python.exe -m pytest -q --tb=short`：114 个测试通过，无跳过；宿主 audioop 弃用警告 1 条。
- Python Ruff 静态检查、16 个文件格式检查通过。
- 编译产物双进程 smoke：实际 WebSocket/HTTP；群原生路由、媒体字节、卡片、首次通知、名单拒绝、意图防重和 unknown 查询通过；进程与服务正常关闭。
- 隔离安装 smoke：存在中断遗留临时检出的全新目录，准备两次均成功。
- T14：用户已选择自行手动测试，本轮不自动向真实员工或群发送消息。接收端呈现、语音播放及真实客户端恢复未验证；操作步骤见 [README](../README.md#5-手动验收)。
- 详细命令、范围及限制见 [开发说明](../docs/DEVELOPMENT.md)。

## 原图接收修复与用户验收

- [x] Driver 保留独立原图字段并提供原生下载；桥接原图缓存优先，未缓存则下载并上传，不以缩略图冒充原图。
- [x] 原图/缩略图区分、实际字节、失败诊断、未创建及过期缓存、缓存复用/清理、Windows 非目录及大小边界回归通过。
- [x] 真实 KK9 原图经隔离 HTTP 生成 AstrBot Image，580×180 PNG、138182 字节一致；用户随后手动确认图片识别测试通过。
- [x] 准备脚本、目录依赖和锁文件固定到 Driver `97729bc61e131592b9b850ad9ed922ca170188c8`；标准冻结安装、桥接 30 项/Python 119 项检查与固定依赖编译产物 HTTP 冒烟通过，不再依赖本机链接。
- 仅记录图片识别这项验收，T14 中群提及、其他媒体、工号通知和恢复等剩余项目不因此勾选；代理未重复发送图片或调用模型。
