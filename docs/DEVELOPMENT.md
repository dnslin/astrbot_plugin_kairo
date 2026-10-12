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
- Driver 固定提交：`15eb384f38c96fbfa9f5f6064713d5740f4bc45f`。新旧包均为 2.0.0，必须按源码提交而非包版本辨别接口。
- Python 3.12+、Node.js 22.13+（推荐 24）、pnpm 11.19.0。

Python 插件只声明 `aiohttp`，AstrBot API 由宿主提供。Driver 尚未发布 npm；准备脚本固定检出、按上游锁文件安装并构建，通过 `file:vendor/kairo-driver-15eb384f38c9` 目录依赖消费。保留上游两份音频依赖补丁，不再应用 `driver-native-send.patch`。更新固定提交时同步准备脚本、依赖目录名和锁文件，不修改相邻开发仓库。

准备过程先在独立临时目录检出，完成后才发布最终目录；中断可重试。已有最终目录若提交不符或跟踪文件修改则明确报错，不覆盖修改。不使用本机 tarball 作为跨系统锁文件输入。

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

0.2.0 本轮实际结果：

| 命令或场景 | 结果 |
| --- | --- |
| `pnpm check` | TypeScript 构建通过；18 个 Node 测试通过 |
| `python.exe -m pytest -q --tb=short`，设置 `ASTRBOT_SOURCE` | 114 个 Python/跨语言测试通过，无跳过；宿主 `audioop` 弃用警告 1 条 |
| `python.exe -m ruff check`，范围为根目录 8 个 Python 模块及 `tests` | 通过 |
| `python.exe -m ruff format --check`，同上 | 16 个文件格式符合要求 |
| 独立编译产物双进程 smoke | Python 平台生命周期 + `bridge/dist/bridge.js`，实际 WebSocket/HTTP，健康检查 v2；群回复固定到原生目标；PNG/WAV/文件字节一致；应用卡片、首次工号通知、名单拒绝、同意图仅提交一次、unknown 不重发；7 次原生 Fake 调用，退出释放进程和服务 |
| 隔离准备 smoke | 留有中断检出临时目录的全新目录，实际执行准备脚本两次均退出 0；使用本地仓库作源码来源，固定提交不变 |

独立 smoke 临时脚本和隔离数据已清理。Fake 只代替 KK9，不代替 AstrBot 类、传输或发送记录。自动测试还覆盖真实宿主 WakingCheck、真实管理员命令过滤/解析、名单各入口、原生查询失败、卡片完整预检、生命周期、数据库重开和迟到未知状态。

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
- [Driver 公开接口](https://github.com/dnslin/kairo-driver/blob/15eb384f38c96fbfa9f5f6064713d5740f4bc45f/src/types/index.ts)
- [aiohttp WebSocket 与文件响应](https://docs.aiohttp.org/en/stable/web_reference.html)

官方平台教程部分示例仍采用旧构造参数，实现以验证基线源码为准。规划时调查记录保留在 [plan.md](../tasks/plan.md)，其中旧版问题是调查快照，不是当前实现说明。
