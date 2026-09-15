from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.platform import AstrBotMessage, PlatformMetadata

if TYPE_CHECKING:
    from .adapter import KairoPlatformAdapter


class KairoMessageEvent(AstrMessageEvent):
    def __init__(
        self,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        adapter: "KairoPlatformAdapter",
    ) -> None:
        super().__init__(
            message_obj.message_str,
            message_obj,
            platform_meta,
            message_obj.session_id,
        )
        self.adapter = adapter
        # 上下文会话可能被隔离或被其他插件改写；回复目标始终来自原始消息。
        self.target_session_id = str(message_obj.raw_message["sessionId"])

    async def send(self, message: MessageChain) -> None:
        await self.adapter.send_chain(self.target_session_id, message)
        await super().send(message)

    async def send_streaming(
        self,
        generator: AsyncGenerator[MessageChain, None],
        use_fallback: bool = False,
    ) -> None:
        """KK9 不支持流式发送；误调用时等待生成完毕，再发送完整消息。"""
        result = MessageChain()
        async for chunk in generator:
            result.chain.extend(chunk.chain)
        if result.chain:
            await self.send(result)
