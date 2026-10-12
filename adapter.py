import asyncio
import hashlib

from astrbot.api import logger
from astrbot.api.event import MessageChain
from astrbot.api.platform import (
    AstrBotMessage,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)
from astrbot.api.star import StarTools
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.platform import PlatformStatus

from .client import KairoClient
from .event import KairoMessageEvent
from .mapping import convert_message, decode_session
from .policy import KairoAccessPolicy
from .transport import BridgeError, BridgeServer


@register_platform_adapter(
    "kairo",
    "通过 kairo-driver 连接 KK9",
    default_config_tmpl={
        "id": "kairo",
        "type": "kairo",
        "enable": False,
        "host": "0.0.0.0",
        "port": 6190,
        "token": "",
        "bot_uid": "",
        "isolate_group_users": True,
        "reply_format": "text",
        "user_blacklist": [],
        "user_whitelist": [],
        "enable_user_whitelist": False,
        "group_blacklist": [],
        "group_whitelist": [],
        "enable_group_whitelist": False,
    },
    adapter_display_name="Kairo（KK9）",
    support_streaming_message=False,
    config_metadata={
        "host": {"description": "监听地址", "type": "string"},
        "port": {"description": "桥接服务端口", "type": "int"},
        "token": {
            "description": "桥接访问 Token",
            "type": "string",
            "secret": True,
            "hint": "与 Windows 桥接程序配置保持一致，至少 32 个字符。",
        },
        "bot_uid": {
            "description": "KK9 机器人 UID",
            "type": "string",
            "hint": "必须与 Windows 上实际登录的 KK9 账号一致。",
        },
        "isolate_group_users": {
            "description": "群内按员工隔离对话",
            "type": "bool",
            "hint": "开启时同一群的不同员工使用各自的上下文；关闭时整群共享。",
        },
        "reply_format": {
            "description": "普通文字回复格式",
            "type": "string",
            "options": ["text", "card"],
            "hint": "card 使用原生应用卡片；卡片不支持引用/提及，请关闭相关回复装饰。",
        },
        "user_blacklist": {"description": "员工黑名单（准确工号）", "type": "list"},
        "user_whitelist": {"description": "员工白名单（准确工号）", "type": "list"},
        "enable_user_whitelist": {
            "description": "启用员工白名单",
            "type": "bool",
            "hint": "开启后空名单拒绝所有员工；限制私聊、群成员触发和工号通知。管理员不豁免。",
        },
        "group_blacklist": {"description": "群黑名单（原生会话 ID）", "type": "list"},
        "group_whitelist": {"description": "群白名单（原生会话 ID）", "type": "list"},
        "enable_group_whitelist": {
            "description": "启用群白名单",
            "type": "bool",
            "hint": "开启后空名单拒绝所有群。群消息对全体成员可见，员工名单不隐藏群消息。",
        },
    },
)
class KairoPlatformAdapter(Platform):
    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)
        self.settings = platform_settings
        self.bot_uid = str(platform_config.get("bot_uid") or "").strip()
        token = str(platform_config.get("token") or "").strip()
        if not self.bot_uid:
            raise ValueError("请配置 KK9 机器人 UID（bot_uid）")
        if len(token) < 32:
            raise ValueError("Kairo 桥接 Token 至少需要 32 个字符")
        self.host = str(platform_config.get("host") or "0.0.0.0")
        self.port = int(platform_config.get("port", 6190))
        if not 1 <= self.port <= 65535:
            raise ValueError("Kairo 桥接端口必须在 1–65535 之间")
        self.isolate_group_users = bool(platform_config.get("isolate_group_users", True))
        self.metadata = PlatformMetadata(
            name="kairo",
            description="通过 kairo-driver 连接 KK9",
            id=str(platform_config.get("id") or "kairo"),
            adapter_display_name="Kairo（KK9）",
            support_streaming_message=False,
            support_proactive_message=True,
        )
        # 实例 ID 可能含路径字符，用摘要分目录，避免不同机器人共用附件。
        instance_dir = hashlib.sha256(self.metadata.id.encode()).hexdigest()[:16]
        storage_dir = StarTools.get_data_dir("astrbot_plugin_kairo") / instance_dir
        self.server = BridgeServer(
            token=token,
            expected_self_id=self.bot_uid,
            on_event=self.on_event,
            on_status=self._on_status,
            storage_dir=storage_dir,
        )
        self.client = KairoClient(
            self.server,
            KairoAccessPolicy(platform_config),
            reply_format=str(platform_config.get("reply_format", "text")),
        )
        self._stopped = asyncio.Event()

    def _on_status(self, connected: bool) -> None:
        self.status = PlatformStatus.RUNNING if connected else PlatformStatus.PENDING

    def meta(self) -> PlatformMetadata:
        return self.metadata

    def get_client(self) -> KairoClient:
        return self.client

    async def run(self) -> None:
        try:
            await self.server.start(self.host, self.port)
            logger.info("Kairo 桥接服务已启动，等待 KK9 连接，端口 %s", self.port)
            await self._stopped.wait()
        finally:
            await self.server.close()
            self.status = PlatformStatus.STOPPED

    async def terminate(self) -> None:
        self._stopped.set()
        await self.server.close()
        self.status = PlatformStatus.STOPPED

    async def on_event(self, data: dict) -> None:
        message = convert_message(
            data,
            self_id=self.bot_uid,
            isolate_group_users=self.isolate_group_users,
            get_file_path=self.server.get_file_path,
        )
        if message is None:
            return
        try:
            await self.client.check_inbound(message)
        except BridgeError as exc:
            if exc.code not in {"ACCESS_DENIED", "IDENTITY_UNAVAILABLE"}:
                raise
            # A missing identity is a resolved rejection, not a transient IPC
            # failure that should reconnect and replay forever.
            logger.warning("Kairo rejected incoming message [%s]: %s", exc.code, exc)
            return
        self.commit_event(self.create_event(message))

    def create_event(self, message: AstrBotMessage) -> KairoMessageEvent:
        return KairoMessageEvent(message, self.meta(), self)

    async def send_by_session(self, session: MessageSession, message_chain: MessageChain) -> None:
        if session.platform_id != self.meta().id:
            raise ValueError("会话所属的平台实例与当前 Kairo 实例不一致")
        target, sender_id = decode_session(session.session_id)
        await self.client.send_chain(target, message_chain, sender_id=sender_id)
        await super().send_by_session(session, message_chain)

    async def send_chain(
        self, target_session_id: str, message: MessageChain, *, sender_id: str | None = None
    ) -> None:
        await self.client.send_chain(target_session_id, message, sender_id=sender_id)
