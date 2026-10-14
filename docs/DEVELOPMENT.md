# 开发说明

## 实现边界

根目录为 Python 平台插件；`bridge/src` 为 TypeScript 桥接；`tests` 为 Python 与双进程集成测试，`bridge/tests` 为 Node 测试。

- `mapping.py`：原生身份、提及、引用、附件与上下文编码。原生发送目标与 AstrBot 对话上下文分开。
- `policy.py`：每个平台实例共用员工/群规则，判定时读取当前配置。
- `client.py`：事件回复、主动发送、媒体、卡片和工号通知的共用入口，不向外暴露原始 RPC。
- `adapter.py` / `event.py`：宿主注册、生命周期、事件提交和回复目标。
- `main.py`：插件工具注册、请求级平台/管理员筛选及 ADMIN 工号通知命令；命令正文保留空格和换行。
- `tools.py`：当前真实 Kairo 事件的语音和三类卡片工具、普通文字到固定卡片字段、一次尝试及原生结果处理。
- `notifications.py`：管理员姓名通知、原生消息编号选择、按实例/会话/员工隔离的 UID 候选及原始正文、跨事件确认和一次发送尝试。
- `transport.py` / `bridge/src`：协议 v2、WebSocket、鉴权文件传输、Driver 分派及持久发送记录。

不建立旧协议、旧界面会话 ID 或旧发送补丁兼容层。用户已确认无需旧数据迁移；现存运行目录不由准备脚本自动删除。

## 依赖来源

- AstrBot 验证基线：`v4.29.0-beta.1`，元数据约束 `>=4.29.0b1,<5`。该基线不是稳定版承诺。
- Driver 固定提交：`29e95f622a3aef1e5fbe266381431041803ef8b9`，为合并完整人员搜索及远程附件支持后的 main；包版本仍为 2.0.1，不等同于旧 `v2.0.1` 发布提交。源码获取、目录依赖与音频补丁保持一致。
- Python 3.12+、Node.js 22.13+（推荐 24）、pnpm 11.19.0。

Python 插件只声明 `aiohttp`，AstrBot API 与工具 schema 校验依赖由宿主提供。Driver 尚未发布 npm；准备脚本固定检出、按上游锁文件安装并构建，通过 `file:vendor/kairo-driver-29e95f622a3a` 目录依赖消费。保留并同步上游两份音频依赖补丁，不再应用 `driver-native-send.patch`。更新固定提交时同步准备脚本、依赖目录名、补丁和锁文件；完整搜索来自已合并的 [Driver PR #18](https://github.com/dnslin/kairo-driver/pull/18)，继续包含 PR #17 的远程附件、PR #15 的原图规则和 PR #16 的文字 TTS 代理及 CONNECT 超时释放修复。

准备过程先在独立临时目录检出，完成后才发布最终目录；中断可重试。已有最终目录若提交不符或跟踪文件修改则明确报错，不覆盖修改。不使用本机 tarball 作为跨系统锁文件输入。

尚未推送的新 Driver 提交可在本地验证：在桥接 PowerShell 设置 `$env:KAIRO_DRIVER_SOURCE = "D:/Person/kairo-driver"` 后执行准备脚本；只改变获取源码的仓库，不放宽固定提交校验。对外安装前必须先发布该 Driver 提交，再发布引用它的插件。该变量不是生产运行依赖，不设置本机路径链接。

原图修复最初通过本机 Driver 链接完成联调；pnpm 默认依赖检查曾将链接恢复到旧版，暴露新增接口缺失，相关失败没有被隐藏。准备脚本、目录依赖和锁文件统一固定到配套 Driver 提交，恢复常规安装及 `pnpm check/start`，不再要求关闭依赖检查或保留本机链接。原图下载 PR [#14](https://github.com/dnslin/kairo-driver/pull/14)、共用来源规则 PR [#15](https://github.com/dnslin/kairo-driver/pull/15) 与文字代理 PR [#16](https://github.com/dnslin/kairo-driver/pull/16) 已合并，包含在 Driver 2.0.1 中。

## 本地检查

先准备桥接，再运行 Python 全套，确保跨语言测试没有因缺 Node 依赖而跳过：

```powershell
cd bridge
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm check
cd ..

$env:ASTRBOT_SOURCE = "D:/Person/AstrBot"
D:/Person/AstrBot/.venv/Scripts/python.exe -m pytest -q --tb=short
D:/Person/AstrBot/.venv/Scripts/python.exe -m ruff check *.py tests
D:/Person/AstrBot/.venv/Scripts/python.exe -m ruff format --check *.py tests
```

将路径换成自己的 AstrBot 源码及包含其完整依赖的 Python 环境。独立安装可使用 `uv pip install --python <python路径> -r <AstrBot路径>/pyproject.toml -r requirements.txt pytest pytest-asyncio ruff`。

`tests/conftest.py` 在未指定 `ASTRBOT_ROOT` 时自动创建并清理临时宿主目录，避免框架导入规范化真实运行配置。若自行指定该变量，必须使用隔离目录并自行清理。测试关闭无关宿主 metrics 后台任务，不替换框架 API。`tests/node_fixture.mts` 只用于验证，没有面向用户的模拟模式。

CI 的 Node 检查覆盖 Windows/Linux，集成任务引用 `v4.29.0-beta.1`。0.3.0 功能提交 `df8b71d` 的 [PR 远端检查](https://github.com/dnslin/astrbot_plugin_kairo/actions/runs/38215687275) 已全部通过：Ubuntu/Windows 桥接及真实 AstrBot 集成；对应分支 push 检查也通过。

## 已执行验证

以下为此前 0.2.0/URI 缓存修复已执行的历史结果，不代表本次原图下载改动已运行这些检查：

| 命令或场景 | 结果 |
| --- | --- |
| `pnpm check` | TypeScript 构建通过；21 个 Node 测试通过，包含 URI 图片缓存解析、歧义及路径边界回归 |
| `python.exe -m pytest -q --tb=short`，设置 `ASTRBOT_SOURCE` | 115 个 Python/跨语言测试通过，无跳过；宿主 `audioop` 弃用警告 1 条 |
| `python.exe -m ruff check`，范围为根目录 8 个 Python 模块及 `tests` | 通过 |
| `python.exe -m ruff format --check`，同上 | 16 个文件格式符合要求 |
| 独立编译产物双进程 smoke | Python 平台生命周期 + `bridge/dist/bridge.js`，实际 WebSocket/HTTP，健康检查 v2；群回复固定到原生目标；PNG/WAV/文件字节一致；应用卡片、首次工号通知、名单拒绝、同意图仅提交一次、unknown 不重发；7 次原生 Fake 调用，退出释放进程和服务 |
| 隔离准备 smoke | 留有中断检出临时目录的全新目录，实际执行准备脚本两次均退出 0；使用本地仓库作源码来源，固定提交不变 |
| URI 图片独立 smoke | 构建后的附件模块读取用户报错图片对应的真实 PNG 缓存，通过隔离的实际 HTTP 文件服务交给 AstrBot Image；字节一致，可解码为 300×23 缩略图；未派发聊天事件或调用模型 |

独立 smoke 临时脚本和隔离数据已清理。Fake 只代替 KK9，不代替 AstrBot 类、传输或发送记录。自动测试还覆盖真实宿主 WakingCheck、真实管理员命令过滤/解析、名单各入口、原生查询失败、卡片完整预检、生命周期、数据库重开和迟到未知状态。

此前缓存图片修复以两条失败回归证明已有文件被漏读，再通过完整 Node/Python 检查与上述独立运行；当时 URI 仅用于配置目录中的本地资源名匹配，尚未实现未缓存原图获取。本次改动在此基础上保留原生 `filepath_h/uri_h`，优先读取原图候选；未命中时调用当前 Driver 的 KK9 原生下载 API，而不是直接抓取 HTTP URL。自管原图缓存写入 `dataDir/attachments/<32hex>/<安全文件名>`，复用现有保留期清理，上传失败不重下，原图失败不回退缩略图。

本次新增回归覆盖原图/缩略图不同字节、原生下载实际字节、下载失败保留文本、过期和未创建缓存目录、自管缓存复用和清理、大小限制、歧义及路径边界；跨语言 fixture 支持 `FakeKK9Driver.setImageResource` 注入资源，通过真实 WS/HTTP 检查 AstrBot 得到 Image。最终桥接 `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm check` 的构建和 30 项 Node 测试通过；Python 全套 `python.exe -m pytest -q --tb=short` 为 119 项通过，最终缓存边界调整后又执行 `python.exe -m pytest -q --tb=short tests/test_integration.py`，25 项通过。修改的 Python 文件 `ruff check` 和 `ruff format --check` 通过；宿主仍有已有的 audioop 弃用警告。Windows 将非目录父路径也报告为 ENOENT 的情况先由边界回归捕获，再修正为明确目录错误，没有放宽断言。

实际运行 `python.exe artifacts/tmp/original-image-smoke.py`：复用已有私聊图片 `137677807`，用本次构建的真实 Driver 从服务器原图 URI 下载一次；KK9 `nativeImage` 实际解码为 580×180，PNG 为 138182 字节。编译后的 Attachments 经隔离的真实 Python HTTP 文件服务上传，`convert_message` 生成真实 AstrBot Image，实际文件与下载原图逐字节相同。仅建立独立 CDP 连接，不调用 Driver.connect 接管生产 Hook；未发送 KK9 消息、未派发聊天事件、未调用模型，未重启现有 bridge。临时脚本和隔离目录在验证后删除。本结果证明原图输入链路，不证明生产模型识图质量。

用户随后手动确认图片识别测试通过；这是当前实际使用路径的人工验收，不是代理重复运行模型得出的结论。该确认不扩展到其他模型或其他媒体，也不将 T14 的其余人工项目自动标为完成。

提交前恢复标准依赖流程，实际执行 `node scripts/prepare-driver.mjs` 从远端检出 `97729bc61e131592b9b850ad9ed922ca170188c8`，再执行 `pnpm install --lockfile-only --offline` 生成锁文件和 `pnpm install --frozen-lockfile` 安装。未关闭 pnpm 依赖检查的 `pnpm check` 构建及 30 项测试通过；Python 全套再次 119 项通过，根目录模块及测试的 Ruff 检查和 16 文件格式检查通过。独立 `node artifacts/tmp/pinned-driver-smoke.mjs` 使用实际安装的固定 Driver 与桥接编译产物，经真实 HTTP 上传核对原图字节，确认不再解析到相邻开发仓库；仅 KK9 使用 Fake，未发送消息或调用模型。一次性脚本和临时目录随后清理。

另对用户已发送回复只读核对发送记录、原生历史和当前 KK9 聊天组件，三者均已有对应消息，用户也确认已发送；没有补发消息、切换窗口或修改客户端 UI。页面此前更新延迟的具体触发时序未采集，不把推测写成已修复的客户端缺陷。

**未执行真实 KK9 自动发送。** 用户选择自行手动验收；语音原生编码与播放、接收端图片/文件/卡片呈现、真实群提及、首次通知及客户端重启恢复均仍需手动观察。`sent` 回执不是这些观察的替代品。可执行清单见 [主说明](../README.md#5-手动验收)，状态见 [实施清单](../tasks/todo.md)。

## 公共接口

调用方从 `context.get_platform_inst(platform_id).get_client()` 获取 `KairoClient`：

- `notify_employee(login_name, text, operation_id=None) -> dict`：准确工号首次/已有私聊文本通知，返回原生 `sent/failed/unknown`、`operationId`，成功带正式 `sessionId`；调用错误抛 `BridgeError`。
- `search_employees(keyword) -> dict`：只读返回完整 `{employees,hasMore:false}`；身份字段可空，Driver 负责分页与 UID 去重，Python 拒绝无效或不完整响应，不推断唯一。等待 35 秒，不改变全局默认时限。
- `notify_employee_uid(user_id, login_name, text, operation_id=None) -> dict`：以搜索快照中的 UID/准确工号重查真实档案；缺失或变化抛 `BridgeError`，匹配后复用 `notify_employee` 的名单及发送意图处理。保留工号大小写和前导零；该 API 不代替模型工具的管理员检查。
- `send_voice_text(target_session_id, text, sender_id=None, operation_id=None) -> dict`：当前准确原生目标的文字语音，复查名单后交给 Driver 合成，返回含 `operationId` 的原生结果；单请求等待 90 秒，不调用宿主 TTS。
- `send_card(target_session_id, card, sender_id=None, operation_id=None) -> dict`：一张 `kairo.app/kairo.url/kairo.biz` Json 字典卡片，复用完整卡片预检和名单；返回含 `operationId` 的原生结果，调用方可提前保存 ID 并在等待取消后只查询同一意图。
- `get_send_status(operation_id) -> dict`：只查询已存在意图，不再次发送。
- `get_sessions() -> list[dict]`：只读原生会话，用于准确路由和群名单配置。
- `send_chain(target_session_id, message, sender_id=None) -> None`：顺序发送支持的组件，失败或未知抛含 `result` 的 `BridgeError`；事件回复保留原群发送者作名单复查。

管理员命令为 `/kairo notify <平台实例ID> <准确工号> <正文>`，不开放额外 HTTP 通知接口。四个原按需模型工具仍只发当前会话；新增两个管理员通知工具在当前 Kairo 实例内查人和选择后发文本私聊，不允许模型指定实例、会话、UID 或工号。通讯超时/断线且未确认成功的 Python 发送结果额外保留 `code`，不重发。工具使用及网络前提见主说明，内部字段见 [协议 v2](PROTOCOL.md)。

## API 依据

- [AstrBot 平台适配器文档](https://docs.astrbot.app/dev/plugin-platform-adapter.html)
- [AstrBot 消息发送文档](https://docs.astrbot.app/dev/star/guides/send-message.html)
- [AstrBot 平台注册源码](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.0-beta.1/astrbot/core/platform/register.py)
- [AstrBot 平台生命周期源码](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.0-beta.1/astrbot/core/platform/platform.py)
- [AstrBot 消息模型源码](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.0-beta.1/astrbot/core/platform/astrbot_message.py)
- [Driver 公开接口](https://github.com/dnslin/kairo-driver/blob/29e95f622a3aef1e5fbe266381431041803ef8b9/src/types/index.ts)
- [aiohttp WebSocket 与文件响应](https://docs.aiohttp.org/en/stable/web_reference.html)

官方平台教程部分示例仍采用旧构造参数，实现以验证基线源码为准。规划时调查记录保留在 [plan.md](../tasks/plan.md)，其中旧版问题是调查快照，不是当前实现说明。

## 原图缓存审计修复

- 原生下载每次写入独立随机 `.part` 文件，返回成功并检查文件后才重命名为最终缓存。进程中断的残留文件不会命中缓存；超时任务之后的迟到写入只影响自身临时文件，不能覆盖后续成功缓存。仍复用既有目录保留期清理，不增加锁、校验数据库或恢复状态机。
- 内部 `normalize/downloadImage/cacheImage` 的 Driver 参数全部必填，删除仅为测试保留的无 Driver 缓存模式；测试改用实际 Fake Driver，生产入口仍传入当前已核对身份的 Driver。
- 原图来源复用配套 Driver 的 `hasOriginalImageSource/getOriginalImageUri`，包括空原图字段拒绝缩略图降级的边界。Driver 缓存外职责不变，HTTP 上传、目录白名单、大小限制和保留期仍由桥接负责。

中断和迟到写入两条新增回归修复前均失败：分别上传24字节的中断文件和被迟到写入覆盖的缓存；原子发布后通过。Driver 空原图字段两项回归也先失败后通过。实际执行 Driver `pnpm check`，build/typecheck、33文件404项测试与lint通过；桥接远端准备固定源码、`pnpm install --lockfile-only --offline`、`pnpm install --frozen-lockfile` 和标准 `pnpm check` 通过，构建及32项测试无跳过。Python全套 `python.exe -m pytest -q --tb=short` 设置 `ASTRBOT_SOURCE` 后119项通过、无跳过，保留宿主已有audioop弃用警告；Python实现未修改，没有重新声称本轮运行Ruff。

运行 `node artifacts/tmp/source-rule-smoke.mjs` 和 `node artifacts/tmp/atomic-image-smoke.mjs`：前者验证本轮Driver真实原图下载到`.part`并解码；后者使用实际安装的固定Driver及桥接编译产物，经独立临时文件、重命名发布、真实鉴权HTTP上传，并重开Attachments复用缓存，1次下载、2次上传的字节均一致，580×180 PNG、138182字节。第一份脚本初次因Windows ESM路径格式在加载阶段失败，改为file URL后通过。服务、独立CDP连接及临时数据均释放，一次性脚本随后删除；没有发送消息、调用模型、接管生产Hook或重启桥接。

Git HTTPS直连推送两次不可达，读取现有Windows系统代理后使用单次进程代理完成Driver推送和远端准备；没有修改持久Git代理配置。配套Driver PR [#15](https://github.com/dnslin/kairo-driver/pull/15) 与插件PR [#1](https://github.com/dnslin/astrbot_plugin_kairo/pull/1) 均只提交审查，不自动合并。

## 按需语音与原生卡片工具（方案 B）

`main.py/tools.py` 注册四个明确工具；请求级仅移除非 Kairo 的本插件工具，保留人格及用户停用选择。工具从真实原始事件取得目标和群发送者，发送前复查现有名单。语音经公共 `send_voice_text` 与新增 `voice_text` 请求直接进入 Driver；三类卡片经公共 `send_card` 复用既有 Json 字段、完整卡片预检和原生分派。四种工具在首次 await 前保存操作 ID，首次尝试记录在事件中，不给工具实例保存会话，不建立第二份持久发送记录。

只有确认 sent 才返回 None 结束默认主聊天 Agent 下一轮续答；失败/unknown 返回原生原因与意图 ID。真实 ToolLoopAgentRunner + FunctionToolExecutor 验证同批重复只有一次提交、成功不复述而失败继续解释。曾临时颠倒语音成功条件，三条相应回归确实失败，恢复后通过；删除了工具描述措辞与构造参数复制断言，没有通过弱化消费者断言使检查变绿。

### 本轮实际执行

| 命令/场景 | 观察结果 |
| --- | --- |
| Driver `pnpm check` | 构建、类型检查、33 文件 409 项测试与 lint 通过；新增代理回归使用真实本地 CONNECT 边界，不访问外网 |
| Driver 三个修改 TS 文件 `pnpm exec prettier --check` | 首次提示格式，格式化后通过 |
| `KAIRO_DRIVER_SOURCE` 指向本地已提交仓库后运行 `node scripts/prepare-driver.mjs` | 固定 `faae824017f5068e80012b75680bb30de100c3da` 的独立源码目录准备、冻结安装及构建通过，不使用开发仓库链接 |
| 桥接 `pnpm install --lockfile-only --offline`、`pnpm install --frozen-lockfile`、`pnpm check` | 新固定目录依赖与锁文件一致；构建和 35 项 Node 测试通过 |
| AstrBot 环境 Python `-m pytest -q --tb=short --showlocals` | 最终全套 186 项通过、无跳过；保留宿主已有 audioop 弃用警告 |
| 修改的 8 个 Python 模块/测试 `ruff check`、`ruff format --check` | 静态规则及格式通过 |
| `python artifacts/tmp/on-demand-tools-smoke.py` | 实际安装的新固定 Driver、编译桥接/SQLite、真实 AstrBot 事件/工具/WS；4 类输出固定原生目标，成功模型 1 轮，名单拒绝 0 次提交，unknown 重复不重发，共 5 次 Fake 原生调用；连续 50 次图片 HTTP 往返字节一致 |
| 仅对子进程设置标准 `HTTPS_PROXY`，运行 `node artifacts/tmp/text-voice-prepare-smoke.mjs` | 正常安装的固定 Driver 无临时注入，真实 Edge 合成及 KK AMR 编码/回解通过：3534 字节、4 秒、1372 毫秒；0 条聊天消息发送 |

真实合成最初直连为 Edge 403，临时补 Cookie 无效，标准 Node 全局代理启动参数在该 SDK 路径也未解决。显式传 SDK 已有代理选项后成功，因而仅在 Driver 文字合成选项中读取非空 HTTPS_PROXY（优先）/HTTP_PROXY；未设置仍直连，指定代理失败不再切换路线。上游依赖及音频补丁未变，不调用 AstrBot TTS、不加 KK 专用代理配置或重试。真实运行只使用独立 CDP 连接，未调用 Driver.connect 接管生产 Hook，未调用外部模型或重启生产服务。

同步新依赖后的首次完整 Python 回归曾出现 1 次原有图片往返组件缺失（StopIteration），当次原始附件错误没有输出。诊断单项通过；现已让该断言在缺图时附带完整原始消息，未放宽文件字节核对。最终全套与独立连续图片往返均未复现，根因仍未定位，不能把后续通过宣称为该问题已修复。

上述实施阶段仅本地提交和验证，未发布；后续发布先完成 Driver 2.0.1，再固定插件依赖到其发布提交 `8208e78b1134484f8b374edb33ee2d595e624591`。一次性脚本及隔离数据在烟测完成后清理。真实私聊/群播放到结尾、卡片呈现/跳转及自然语言模型选择保留人工验收，不因生成 AMR 或替身 sent 勾选原 T14。

### 0.3.0 发布复核

配套 [Driver 2.0.1](https://github.com/dnslin/kairo-driver/releases/tag/v2.0.1) 已先行发布，固定提交 `8208e78b1134484f8b374edb33ee2d595e624591`。发布审查发现代理 CONNECT 挂起时错误虽返回但 TCP 仍存活；新增回归先失败，补丁通过 AbortSignal 取消本次代理连接后通过。Driver 冻结安装和完整检查为 33 文件 410 项、构建、类型检查及 lint 通过，没有升级其他依赖。

插件实际从 GitHub 获取该提交，执行 `node scripts/prepare-driver.mjs` 完成冻结安装与构建，再执行桥接 `pnpm install --lockfile-only --offline`、`pnpm install --frozen-lockfile`、`pnpm check`，构建及 35 项测试通过。首次准备因本地 Driver 补丁含两处 CRLF、Git 发布源码已规范为 LF 而字节不一致；改为原样同步实际发布提交的补丁后通过，没有放宽补丁一致性检查。

设置 `ASTRBOT_SOURCE` 后，AstrBot 环境执行 `python.exe -m pytest -q --tb=short --showlocals`：取消修复后最终 187 项通过、无跳过；`ruff check *.py tests` 和 `ruff format --check *.py tests` 通过，18 文件格式正确。保留已有 `audioop` 弃用警告，Node 保留 SQLite 实验特性警告。

独立 Node 进程以内联脚本运行实际安装的发布 Driver 和 `bridge/dist`：真实 WebSocket 完成鉴权头、协议握手及文字语音/三类卡片发送，4 次 Fake 原生调用均固定到原始群目标；重复请求及状态查询没有再次提交，重开 SQLite 后四份终态仍为 sent。另以桥接实际安装的 Edge SDK 运行 `ttsPromise`，本地 CONNECT 不返回时得到原始 `Timed out` 并观察到代理 TCP 关闭，没有音频产物或外网连接。没有创建长期烟测脚本，没有发送真实聊天消息、调用生产模型或重启运行服务。

发布审查另发现卡片已提交后取消等待会丢失操作 ID，语音已有稳定 ID。扩展原取消回归后，卡片先失败，修复后工具文件 64 项通过。新增公共单卡片 `send_card` 复用既有预检、名单及发送意图处理，工具在首次 await 前保存并贯通同一 ID；普通消息链接口不变。Python LSP references 返回没有可用语言服务器，使用实际调用路径、回归和独立运行补足，没有把导航失败记为成功。

独立 Python 进程以内联脚本运行真实 AstrBot 平台/事件/工具、真实 HTTP/WS、编译 bridge 和 SQLite，KK9 使用已发布 Fake：三类卡片均在原生请求提交后取消等待，重复调用保留同一个 unknown 操作 ID、不再提交；原生完成后通过公共 `get_send_status` 查询原 ID，三份结果均为 sent，总原生调用仅 3 次。隔离宿主、进程、服务及临时数据库全部退出并清理，没有发送真实消息。


## 远程 CDP 附件适配

配套依赖从旧 2.0.1 发布提交切换到合并 [Driver PR #17](https://github.com/dnslin/kairo-driver/pull/17) 的 main 提交 `1c4223fee51296ff68aa8f18b98d406bcdd800c8`，准备脚本、目录依赖及锁文件同步固定。上游包版本仍为 2.0.1，本次以提交身份区分。没有改动 Driver 源码、音频补丁、运行配置或生产桥接进程。

桥接和 UID 命令接受远程 HTTP/HTTPS 发现基址及路径前缀；不自动改写发现返回的 WebSocket 地址。移除旧 `attachmentRoots` 配置和桥接本机目录扫描。图片统一调用 `downloadImage`，普通已缓存文件统一调用 `saveFile`，两者先保存到桥接自管目录再上传 AstrBot。仅有 Windows 准确原图路径、没有 URI 的图片也可处理；所有远端路径仅作为来源标识交给 Driver，不做桥接本地文件读取。发送侧调用不变，仍传桥接本机路径，保留既有发送防重和结果语义。

接收图片和文件复用按类别及来源区分的缓存保存逻辑：独占临时路径、真实文件及大小检查、完成后发布、并发同源复用、上传失败后重开复用和保留期清理。原图 20 MiB、普通文件 100 MiB 限制不变；文件未缓存仍逐项报错，不影响正文，不增加普通文件下载协议或 Windows 文件服务。

### 本轮执行结果

- 使用 Node 22.23.0、pnpm 11.19.0 执行 `node scripts/prepare-driver.mjs`、`pnpm install --lockfile-only --offline`、`pnpm install --frozen-lockfile`：固定源码冻结安装及构建、桥接锁文件生成及冻结安装通过。系统默认 Node 14 曾因不支持 `--import`、pnpm 启动器选择旧 Node 而失败；仅调整本次验证进程的 PATH，未修改持久环境。
- 新增“Windows 原图缓存无 URI 与普通文件均由 Driver 保存到桥接本地后上传”回归：旧桥接实际失败（上传字节为空），改造后通过。`pnpm check`：TypeScript 构建及 39 项 Node 测试通过；保留 SQLite 实验特性警告。
- 设置 `ASTRBOT_SOURCE=D:/Person/AstrBot`，用 AstrBot 虚拟环境执行 `python.exe -m pytest -q --tb=short`：最终 187 项通过，无跳过，保留 `audioop` 弃用警告。首次有 1 项旧 URI 图片测试依赖本机目录扫描而失败；改为由 Driver 提供 URI 对应原图、同时放置错误本机同名图片，保留实际字节核对后全套通过。跨语言往返测试使用 Windows 缓存路径和 Driver Fake 的独立缓存字节，不再依赖共享目录。
- `python.exe -m ruff check tools.py tests/test_integration.py`、`python.exe -m ruff format --check tools.py tests/test_integration.py` 通过；仅格式化本次改动的集成测试文件。
- 独立 Node 内联烟测运行编译后的 `bridge/dist` 和实际安装的固定 Driver，连接真实 `http://172.16.0.18:9222`。仅建立该 Driver 的独立 CDP 连接，不调用 `Driver.connect` 接管消息 Hook；自建 Windows 临时文件验证 786469 字节多分块文档及 1771 字节 PNG 原图保存，经真实鉴权 HTTP 上传 4 次，字节逐一相同。准确原图只提供 Windows 缓存路径、不提供 URI，另有不同缩略图；删除远端临时文件后，重开 Attachments 仍成功复用图片和文件的本地缓存。远端文件、HTTP 服务和本地隔离目录已释放。
- 另一份独立内联烟测实际启动 `scripts/whoami.mjs`，对 `127.0.0.2` 的受控发现服务保留 `/proxy/kk9` 前缀，请求 `/proxy/kk9/json`；地址未被回环限制拒绝，无页面时明确失败，没有安装 Hook。

本轮真实附件烟测是 Windows Driver → 远程 Windows KK9，不冒充 Linux → Windows 验收；Linux 桥接真机运行仍未在本轮执行。没有发送、撤回聊天消息、调用生产模型或重启服务；原生云端原图下载、接收端呈现及语音播放不因缓存文件传输通过而视为完成。姓名查人及重名选择功能不在本次适配范围。

## UID 命令读取桥接配置修复

用户反馈已填写远程 `cdp.url`，执行 `pnpm run whoami` 仍报 `fetch failed`。源码确认旧命令仅读取环境变量，不读取桥接配置，未设置环境变量时仍请求本机 9222；这解释了地址来源不一致，但不能据此认定用户服务器网络已连通。

`scripts/whoami.mjs` 现默认读取当前目录 `config.json` 的 CDP 设置，支持 `--config <路径>`，保留环境变量优先覆盖。UID 初始化只读取 CDP 字段，不要求先填好 UID、AstrBot 地址和 token。首次默认文件尚不存在是正常初始化状态；显式文件缺失、损坏 JSON、错误字段不回退。失败时显示实际 CDP 地址，便于定位连错地址和真实网络故障。

新增 CLI 行为回归直接启动真实 whoami 子进程，使用受控 HTTP 发现服务核对配置地址、路径前缀和页面匹配；页面不提供 WebSocket，确保不会安装 Hook。修复前显式配置被忽略的回归实际失败，修复后 3 项通过；`pnpm check` 构建及 42 项 Node 测试通过。独立内联烟测实际执行 `pnpm run whoami --config <临时配置>`，观察到 `/uid-smoke/json`、配置中的页面片段和失败输出中的实际地址，按预期因没有页面而停止。烟测最初 Windows shell 参数转义误把引号传入文件名，修正一次性启动方式后通过，未修改产品的路径处理。

本次没有连接用户生产 KK、读取实际 UID、发送消息或重启服务，也没有重复执行用户报告的失败命令来确认故障。配置加载与命令分派已验证，用户远程服务器的网络连通性仍需从其桥接机器观察。

## 0.4.0 发布准备

插件元数据、Python 项目及桥接包版本统一更新为 0.4.0，README 将远程 CDP、统一附件传输和 UID 配置读取修复归入本次变更，不归入历史 0.3.0。Driver 仍固定到 `1c4223fee51296ff68aa8f18b98d406bcdd800c8`。

发布复核发现 Windows 为 UID 测试发现服务分配了 6000 端口，Node `fetch` 因 `bad port` 在发出请求前拒绝，导致该项偶发失败。测试服务改为从 20000 起选择未占用高位端口，避免 fetch 保留端口；只对真实端口占用继续选择，不改产品连接实现、超时或断言。修正后 `pnpm check` 构建及 42 项 Node 测试通过。版本更新后的 Python 全套 187 项、`ruff check .` 以及 `ruff format --check .` 的 18 文件检查通过，保留既有 SQLite 实验特性与 `audioop` 弃用警告。

发布前再次以真实 `pnpm run whoami --config <临时配置>` 执行隔离命令烟测，观察到配置指定的 `/uid-smoke/json`、页面片段及错误中的实际地址；无页面时按预期失败，没有连接生产 KK 或安装 Hook。此前真实 Windows → 远程 Windows 附件烟测的范围和限制不变；本次版本号及测试监听修复不扩大为 Linux 真机验收。未修改运行配置、发送数据库或生产服务。

## 管理员按姓名通知接入（0.5.0）

用户确认仅管理员可用。固定 Driver 升级到 `29e95f622a3aef1e5fbe266381431041803ef8b9`，两份音频补丁与上游一致；准备脚本以本机源码来源完成固定检出及冻结安装，桥接锁文件同步并完成冻结安装。不改 Edge TTS 协议，不宣称修复现存语音 403。

新增只读 `search_employees` 和两个真实 FunctionTool，沿用 `Context.add_llm_tools` 归属与启停方式。请求级移除无权限工具，执行时再次检查原生事件及管理员角色；发起员工、原群和接收员工复查当前名单。只对单个完全匹配姓名自动发；其余列出全部候选并等待下一条真实编号消息，保存 UID/工号快照和首次正文，不接受模型指定路由。身份变化、缺少工号、不明确选择均不改投。

候选及最新意图按平台实例、原生会话和发起人隔离；新通知替换旧通知，旧在途搜索不能覆盖新候选或恢复已完成意图，选择后先消耗状态再等待发送。原生事件增加高精度 `received_at_ns`，候选使用同一高精度时钟；不依赖可被改写的上下文 ID 或低精度宿主墙钟判断选择顺序。内存候选不跨重载保存，不新增数据库、锁或配置框架；发送仍使用原有 SQLite 意图记录。

### 本轮验证

- `pnpm check`：TypeScript 构建及 44 项 Node 测试通过，无跳过；只读搜索通过真实 JSON WebSocket 保留 503 个候选、可空身份和全部部门路径，原生错误直接返回，没有发送副作用。
- 设置 `ASTRBOT_SOURCE=D:/Person/AstrBot`，用 AstrBot 虚拟环境执行 `python.exe -m pytest -q --tb=short`：286 项通过，无跳过；保留宿主 `audioop` 弃用警告。覆盖权限、姓名准确/模糊/重名、缺失身份、当前名单、编号与原生消息一致、状态隔离、重排仍绑定原 UID/正文、旧在途查询、并发/取消/未知不重发。
- 首轮回归因 Windows `created_at` 与候选完成墙钟值相同，误拒绝合法下一条消息，并令等待发送门闩的用例挂起。诊断输出确认两值相等后改为高精度接收顺序；新增确定性同墙钟回归，94 项通知专项通过，测试控制门闩也有明确等待界限。未放宽同消息或过期选择检查。
- `python.exe -m ruff check .`、`python.exe -m ruff format --check .`：通过，20 个 Python 文件格式符合要求。仅格式化本次修改文件。
- 独立 Python/Node 内联烟测使用实际安装的固定 Driver、`bridge/dist`、真实 AstrBot 事件/工具、WebSocket 和 SQLite，仅 KK9 使用 Fake：两位同名员工及多部门展示；非管理员拒绝；选择后按 `e0044`（保留大小写/前导零）发送首次正文一次；名单变化拒绝；`unknown` 重复调用不重发。仅 2 次 Fake 原生调用，数据库持久状态为 `sent`、`unknown`；进程、服务、数据库句柄及临时文件已清理。首次烟测的只读 SQLite 核查仅结束事务、未关闭句柄，Windows 拒绝删除临时文件；修正一次性脚本显式关闭并清理原目录后，完整烟测退出 0。产品发送 Store 无需修改。
- 独立进程内临时移除非管理员门禁，权限回归按预期失败；恢复后进程退出，未修改持久源码。证明测试能够捕获非管理员搜索泄露，而不只是检查工具注册。

以上为实现阶段验证记录；该阶段没有发布、提交或推送。后续按用户要求发布 `0.5.0`、创建 `v0.5.0`，发布阶段不重复测试。没有重启现有 AstrBot/桥接、修改运行配置或向真实员工发送消息。真实模型是否正确提取姓名/正文、展示候选、调用选择工具及真实接收端通知仍待授权人工验收；本次不扩大原 T14 的通过范围。

