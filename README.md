# Kairo for AstrBot

通过 [kairo-driver](https://github.com/dnslin/kairo-driver) 把 KK9 接入 AstrBot。

仓库包含两部分：根目录是 AstrBot 平台插件，`bridge/` 是运行在 KK9 电脑上的 Node.js 桥接程序。Windows 主动连接 AstrBot，KK9 的 CDP 保留在本机。无需修改 AstrBot 源码。

**KK9 不支持流式输出。** 本插件等待回复生成完成后发送；如果回复包含图片或文件，按消息顺序分别发送。

## 支持范围

| 功能 | 当前支持情况 |
| --- | --- |
| 私聊、群聊文本收发 | 支持 |
| 群聊 @ 机器人、@ 成员、@ 全体 | 支持，是否唤醒由 AstrBot 配置决定 |
| 文本引用回复 | 支持 |
| 图片、文件发送 | 支持跨机器传输；图片 20 MiB，文件 100 MiB |
| 接收图片、文件 | 支持读取允许目录内已经缓存的附件 |
| 未缓存附件 | 明确提示内容不可用，目前不自动下载 |
| 主动发送 | 支持发送到 KK9 已存在的会话 |
| 群内员工上下文隔离 | 默认开启，可在平台配置中关闭 |
| 连接恢复 | 支持 WebSocket 重连及失效 Driver 重建 |

模型、知识库、文件解析和普通插件继续由 AstrBot 负责。仅适用于 QQ 等特定平台的插件，不会自动获得 KK9 对应能力。

## 1. 安装 AstrBot 插件

使用 **AstrBot 4.28.1** 或之后的 4.x 版本、Python 3.12+。本版已对 AstrBot 4.28.1 源码进行验证。

在 AstrBot 插件管理页面，通过 GitHub 仓库地址安装：

```text
https://github.com/dnslin/astrbot_plugin_kairo
```

安装后重启 AstrBot，在消息平台中新增 **Kairo（KK9）**，填写：

| 字段 | 填写方式 |
| --- | --- |
| 平台 ID | 例如 `kairo`；使用后保持稳定，避免对话标识改变 |
| 监听地址 | 默认 `0.0.0.0`，接受 Windows 的连接 |
| 桥接服务端口 | 默认 `6190` |
| Token | 自行生成，至少 32 个无空白 ASCII 字符，两端一致 |
| KK9 机器人 UID | Windows 实际登录的机器人 UID，两端一致 |
| 群内按员工隔离对话 | 默认开启；关闭后整群共享上下文 |

UID 可以在下一步准备桥接依赖后，通过 `pnpm whoami` 读取。

如果 AstrBot 运行在 Docker 中，在**原有 AstrBot 服务**的 `ports` 中追加端口映射，然后重新创建容器：

```yaml
ports:
  # 保留你原来已有的端口映射
  - "6190:6190"
```

跨机器连接要保证 Windows 能访问这个端口；通过公网连接时使用 HTTPS/WSS。桥接的 `/ws` 和 `/files` 都需要同一份 Token，不要公开 KK9 的 CDP 端口。

## 2. 启动 Windows 桥接

在 KK9 所在 Windows 电脑安装 Node.js 24、Git 和 pnpm 11.19.0，执行：

```powershell
git clone https://github.com/dnslin/astrbot_plugin_kairo.git
cd astrbot_plugin_kairo/bridge
node scripts/prepare-driver.mjs
pnpm install --frozen-lockfile
pnpm build
Copy-Item config.example.json config.json
```

准备脚本会获取固定版本的 Driver 并打包，不需要你手动复制 Driver 源码。

完全退出 KK9，再用实际安装路径启动客户端，登录机器人账号：

```powershell
& "C:\Path\To\KK9.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

先运行 `pnpm whoami` 获取 UID，再编辑 `config.json`：

```json
{
  "serverUrl": "http://你的AstrBot服务器IP:6190",
  "token": "与AstrBot中相同的随机Token",
  "expectedUserId": "机器人UID",
  "cdp": {
    "url": "http://127.0.0.1:9222",
    "pageMatch": "renderer.html"
  },
  "attachmentRoots": [],
  "dataDir": "./data"
}
```

可以用下面的命令生成 Token，再复制到两端：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`attachmentRoots` 为空时仍可收发文字、发送附件，但不会读取收到的本地附件。需要接收附件时，填入 KK9 **实际缓存目录**，例如 `"C:\\Users\\你的用户名\\实际缓存目录"`；不要填整个磁盘。

最后启用 AstrBot 的 Kairo 平台并启动桥接：

```powershell
pnpm start
```

看到“**AstrBot 桥接已连接，使用完整消息收发**”后，可以用一个指定测试账号先验证私聊，再验证群里 @ 机器人。完整参数和故障处理见 [Windows 桥接说明](bridge/README.md)。

## 运行边界

- 收到 `unknown` 发送结果时，只查询同一个操作 ID，不直接重发。发送记录保存在 Windows 的 `data/send-operations.sqlite` 中，重建 Driver 后继续使用。
- 入站未确认消息暂存在内存中，可在短暂 WebSocket 断线后重放；进程重启或 KK9 断线期间的消息不保证补回。服务端 ACK 表示事件已经交给 AstrBot，不代表模型处理或回复已经完成。
- 服务端附件默认保留 24 小时，总缓存限制 1 GiB；Windows 下载的发送附件默认保留 24 小时。历史会话中的附件过期后可能无法重新读取。
- 当前图片、文件消息不支持原生引用；可以引用一段文字，再单独发送图片或文件。语音、业务卡片、撤回和组织架构尚未接入。
- 群内上下文隔离不改变 AstrBot 的权限规则，部分群内会话管理命令仍需要 AstrBot 管理员权限。
- 新安装或升级插件后重启 AstrBot。本版未进行真实 Windows KK9 联调，首次使用请在指定测试会话验证文本、附件、@、引用及客户端重启恢复。

## 开发与验证

参见 [开发说明](docs/DEVELOPMENT.md) 和 [桥接协议](docs/PROTOCOL.md)。测试使用真实 AstrBot 类、真实 WebSocket/HTTP 和 Driver 提供的 `FakeKK9Driver`，不会连接或发送消息到真实 KK9。
