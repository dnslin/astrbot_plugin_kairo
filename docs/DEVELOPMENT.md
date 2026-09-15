# 开发说明

根目录为 Python 平台插件；`bridge/src` 为 TypeScript 桥接；`tests` 为 Python 和跨语言测试，`bridge/tests` 为 Node 测试。

## 依赖来源

- AstrBot 验证基线：`06261c532a6425c7a220e78791acef615cba549c`，版本 4.28.1。
- Driver 固定版本：`1da7e8e67ee597624eb47a090276a7957316a258`，包版本 2.0.0。
- Python 3.12+，Node.js 22.13+（推荐 24），pnpm 11.19.0。

Python 插件只声明 `aiohttp`，其余 AstrBot API 由宿主提供。Driver 尚未发布 npm，因此准备脚本固定检出、构建并打包，再通过本地 tarball 安装。音频依赖补丁放在 `bridge/patches` 并由 `pnpm-workspace.yaml` 应用。更新 Driver 时同时更新固定提交、补丁和锁文件，不能只修改包版本号。

## 本地检查

准备 Node 依赖并检查：

```bash
cd bridge
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm check
cd ..
```

Python 测试需要完整的 AstrBot 源码及其依赖。可在相邻目录克隆验证基线，使用独立虚拟环境：

```bash
git clone https://github.com/AstrBotDevs/AstrBot.git ../AstrBot
git -C ../AstrBot checkout 06261c532a6425c7a220e78791acef615cba549c
uv venv .venv
uv pip install --python .venv/bin/python -r ../AstrBot/pyproject.toml -r requirements.txt pytest pytest-asyncio ruff
ASTRBOT_SOURCE=../AstrBot .venv/bin/python -m pytest -q
.venv/bin/ruff check .
.venv/bin/ruff format --check .
```

Windows 使用 `.venv\Scripts\python.exe`，并用 `$env:ASTRBOT_SOURCE = "..\AstrBot"` 设置源码路径。

没有安装 Node 依赖时，跨语言测试会明确跳过；完整检查应先准备 bridge，并确认没有跳过这两项测试。`tests/node_fixture.mts` 只用于自动联调，没有面向用户的模拟模式。

## 验证范围

- Python：消息规范化、群成员会话路由、@ 与引用、流式误调用聚合、附件、发送失败与未知状态、鉴权和去重。
- Node：协议校验、实际 UID 核对、失效恢复、未确认事件重放、发送状态持久化、附件路径边界。
- 跨语言：实际 AstrBot 事件与 Node bridge，通过 Driver 的 FakeKK9Driver 验证文本及双向附件内容、主动消息、未知状态和重连。

这些测试不等于真实 KK9 验收。真实联调只在获得使用授权的机器人账号及指定私聊/群聊范围执行；不得批量给现有员工会话发送测试消息。

## API 依据

- [AstrBot 平台注册](https://github.com/AstrBotDevs/AstrBot/blob/06261c532a6425c7a220e78791acef615cba549c/astrbot/core/platform/register.py)
- [AstrBot 平台生命周期](https://github.com/AstrBotDevs/AstrBot/blob/06261c532a6425c7a220e78791acef615cba549c/astrbot/core/platform/platform.py)
- [AstrBot 消息模型](https://github.com/AstrBotDevs/AstrBot/blob/06261c532a6425c7a220e78791acef615cba549c/astrbot/core/platform/astrbot_message.py)
- [Driver 公开接口](https://github.com/dnslin/kairo-driver/blob/1da7e8e67ee597624eb47a090276a7957316a258/src/types/index.ts)
- [aiohttp WebSocket 与文件响应](https://docs.aiohttp.org/en/stable/web_reference.html)

官方平台教程的部分示例与 4.28.1 的构造参数不一致，实现以以上源码为准。
