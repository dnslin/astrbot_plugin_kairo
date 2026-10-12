# 开发说明

## 实现边界

根目录为 Python 平台插件；`bridge/src` 为 TypeScript 桥接；`tests` 为 Python 与双进程集成测试，`bridge/tests` 为 Node 测试。

- `mapping.py`：原生身份、提及、引用、附件与上下文编码。原生发送目标与 AstrBot 对话上下文分开。
- `policy.py`：每个平台实例共用员工/群规则，判定时读取当前配置。
- `client.py`：事件回复、主动发送、媒体、卡片和工号通知的共用入口，不向外暴露原始 RPC。
- `adapter.py` / `event.py`：宿主注册、生命周期、事件提交和回复目标。
- `main.py`：复用 AstrBot ADMIN 权限与真实命令解析，通知正文保留空格和换行。
- `transport.py` / `bridge/src`：协议 v2、WebSocket、鉴权文件传输、Driver 分派及持久发送记录。

不建立旧协议、旧界面会话 ID 或旧发送补丁兼容层。用户已确认无需旧数据迁移；现存运行目录不由准备脚本自动删除。

## 依赖来源

- AstrBot 验证基线：`v4.29.0-beta.1`，元数据约束 `>=4.29.0b1,<5`。该基线不是稳定版承诺。
- Driver 固定提交：`97729bc61e131592b9b850ad9ed922ca170188c8`。新旧包均为 2.0.0，必须按源码提交而非包版本辨别接口。
- Python 3.12+、Node.js 22.13+（推荐 24）、pnpm 11.19.0。

Python 插件只声明 `aiohttp`，AstrBot API 由宿主提供。Driver 尚未发布 npm；准备脚本固定检出、按上游锁文件安装并构建，通过 `file:vendor/kairo-driver-97729bc61e13` 目录依赖消费。保留上游两份音频依赖补丁，不再应用 `driver-native-send.patch`。更新固定提交时同步准备脚本、依赖目录名和锁文件，不修改相邻开发仓库。

准备过程先在独立临时目录检出，完成后才发布最终目录；中断可重试。已有最终目录若提交不符或跟踪文件修改则明确报错，不覆盖修改。不使用本机 tarball 作为跨系统锁文件输入。

原图修复最初通过本机 Driver 链接完成联调；pnpm 默认依赖检查曾将链接恢复到旧版，暴露新增接口缺失，相关失败没有被隐藏。本次提交将准备脚本、目录依赖和锁文件统一固定到配套 Driver 提交，恢复常规安装及 `pnpm check/start`，不再要求关闭依赖检查或保留本机链接。上游 PR 为 [kairo-driver #14](https://github.com/dnslin/kairo-driver/pull/14)，插件 PR 应在上游合并后合并。

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

CI 的 Node 检查覆盖 Windows/Linux，集成任务引用 `v4.29.0-beta.1`；本轮本地结果不能替代未运行的远端 CI。

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
- `get_send_status(operation_id) -> dict`：只查询已存在意图，不再次发送。
- `get_sessions() -> list[dict]`：只读原生会话，用于准确路由和群名单配置。
- `send_chain(target_session_id, message, sender_id=None) -> None`：顺序发送支持的组件，失败或未知抛含 `result` 的 `BridgeError`；事件回复保留原群发送者作名单复查。

管理员命令为 `/kairo notify <平台实例ID> <准确工号> <正文>`。不开放额外 HTTP 通知接口或模型工具。三类 Json 结构和使用示例见主说明，内部字段见 [协议 v2](PROTOCOL.md)。

## API 依据

- [AstrBot 平台适配器文档](https://docs.astrbot.app/dev/plugin-platform-adapter.html)
- [AstrBot 消息发送文档](https://docs.astrbot.app/dev/star/guides/send-message.html)
- [AstrBot 平台注册源码](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.0-beta.1/astrbot/core/platform/register.py)
- [AstrBot 平台生命周期源码](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.0-beta.1/astrbot/core/platform/platform.py)
- [AstrBot 消息模型源码](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.0-beta.1/astrbot/core/platform/astrbot_message.py)
- [Driver 公开接口](https://github.com/dnslin/kairo-driver/blob/97729bc61e131592b9b850ad9ed922ca170188c8/src/types/index.ts)
- [aiohttp WebSocket 与文件响应](https://docs.aiohttp.org/en/stable/web_reference.html)

官方平台教程部分示例仍采用旧构造参数，实现以验证基线源码为准。规划时调查记录保留在 [plan.md](../tasks/plan.md)，其中旧版问题是调查快照，不是当前实现说明。
