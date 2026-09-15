import asyncio
import hashlib
from pathlib import Path
from uuid import uuid4

from astrbot.api import logger
from astrbot.api.event import MessageChain
from astrbot.api.message_components import At, AtAll, File, Image, Plain, Reply
from astrbot.api.platform import (
    AstrBotMessage,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)
from astrbot.api.star import StarTools
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.platform import PlatformStatus

from .event import KairoMessageEvent
from .mapping import convert_message, target_from_session
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
        self._stopped = asyncio.Event()

    def _on_status(self, connected: bool) -> None:
        self.status = PlatformStatus.RUNNING if connected else PlatformStatus.PENDING

    def meta(self) -> PlatformMetadata:
        return self.metadata

    def get_client(self) -> BridgeServer:
        return self.server

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
        if message is not None:
            self.commit_event(self.create_event(message))

    def create_event(self, message: AstrBotMessage) -> KairoMessageEvent:
        return KairoMessageEvent(message, self.meta(), self)

    async def send_by_session(self, session: MessageSession, message_chain: MessageChain) -> None:
        if session.platform_id != self.meta().id:
            raise ValueError("会话所属的平台实例与当前 Kairo 实例不一致")
        await self.send_chain(target_from_session(session.session_id), message_chain)
        await super().send_by_session(session, message_chain)

    async def _send(self, params: dict) -> None:
        operation_id = uuid4().hex
        params = {**params, "operation_id": operation_id}
        try:
            result = await self.server.request("send", params)
        except BridgeError as exc:
            if exc.code not in {"TIMEOUT", "CONNECTION_LOST", "DISCONNECTED"}:
                raise
            result = {"status": "unknown", "error": str(exc)}

        if result.get("status") == "unknown":
            try:
                result = await self.server.request(
                    "get_send_status", {"operation_id": operation_id}
                )
            except BridgeError as exc:
                result = {"status": "unknown", "error": str(exc)}

        if result.get("status") == "delivered":
            return
        if result.get("status") == "failed":
            raise BridgeError("SEND_FAILED", result.get("error") or "KK9 发送失败")
        logger.error("KK9 发送状态未知，未自动重发。operation_id=%s", operation_id)
        raise BridgeError(
            "SEND_UNKNOWN",
            f"KK9 发送状态未知，请核对客户端。操作 ID：{operation_id}；未自动重发。",
        )

    async def send_chain(self, target_session_id: str, message: MessageChain) -> None:
        """同一文本回复一次发送；附件按消息链顺序单独传输。"""
        if not target_session_id:
            raise ValueError("KK9 目标会话 ID 不能为空")
        # 在触发任何发送前检查类型，避免先发半条消息再静默丢弃其余内容。
        for component in message.chain:
            if not isinstance(component, (Plain, At, AtAll, Reply, Image, File)):
                raise BridgeError(
                    "UNSUPPORTED_COMPONENT",
                    f"Kairo 暂不支持发送 {type(component).__name__} 消息段",
                )

        text_parts: list[str] = []
        mentions: list[dict] = []
        reply_to: str | None = None

        async def flush_text() -> None:
            nonlocal text_parts, mentions, reply_to
            text = "".join(text_parts)
            if text.strip() or mentions:
                params = {
                    "target_session_id": target_session_id,
                    "kind": "text",
                    "text": text,
                }
                if mentions:
                    params["mentions"] = mentions
                if reply_to:
                    params["reply_to"] = reply_to
                await self._send(params)
                text_parts = []
                mentions = []
                reply_to = None

        for component in message.chain:
            if isinstance(component, Plain):
                text_parts.append(component.text)
            elif isinstance(component, At):
                uid = str(component.qq)
                name = component.name or ("所有人" if uid == "all" else uid)
                mentions.append({"uid": uid, "name": name})
            elif isinstance(component, AtAll):
                mentions.append({"uid": "all", "name": "所有人"})
            elif isinstance(component, Reply):
                reply_to = str(component.id)
            elif isinstance(component, (Image, File)):
                await flush_text()
                if reply_to:
                    raise BridgeError(
                        "UNSUPPORTED_REPLY",
                        "KK9 的图片和文件发送接口不支持引用，请同时提供引用回复的文字。",
                    )
                if isinstance(component, Image):
                    path = Path(await component.convert_to_file_path())
                    name = path.name
                    kind = "image"
                else:
                    file_path = await component.get_file()
                    if not file_path:
                        raise BridgeError("FILE_UNAVAILABLE", "待发送文件无法读取")
                    path = Path(file_path)
                    name = component.name or path.name
                    kind = "file"
                descriptor = await self.server.add_file(path, name=name)
                params = {
                    "target_session_id": target_session_id,
                    "kind": kind,
                    "file_id": descriptor["file_id"],
                    "name": descriptor["name"],
                }
                await self._send(params)
                reply_to = None
        await flush_text()
