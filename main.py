from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.platform import MessageType
from astrbot.api.star import Context, Star
from astrbot.core.provider.entities import ProviderRequest
from astrbot.core.star.filter.command import GreedyStr

from .notifications import KairoNotifications, KairoNotifyEmployeeTool, KairoSelectEmployeeTool
from .tools import (
    KAIRO_ADMIN_TOOL_NAMES,
    KAIRO_TOOL_NAMES,
    KairoGetGroupMembersTool,
    KairoSendAppCardTool,
    KairoSendBizCardTool,
    KairoSendFileTool,
    KairoSendImageTool,
    KairoSendUrlCardTool,
    KairoSendVoiceTool,
    is_kairo_event,
)
from .transport import BridgeError


class KairoPlugin(Star):
    """加载平台适配器；连接由 AstrBot 的平台管理器维护。"""

    def __init__(self, context: Context) -> None:
        super().__init__(context)
        from .adapter import KairoPlatformAdapter  # noqa: F401

        notifications = KairoNotifications()
        tools = (
            KairoSendVoiceTool(),
            KairoSendAppCardTool(notifications),
            KairoSendUrlCardTool(notifications),
            KairoSendBizCardTool(notifications),
            KairoSendImageTool(notifications),
            KairoSendFileTool(notifications),
            KairoGetGroupMembersTool(),
            KairoNotifyEmployeeTool(notifications),
            KairoSelectEmployeeTool(notifications),
        )
        for tool in tools:
            # Context 按 __module__ 标记工具归属，保持启停/重载与主插件一致。
            tool.__module__ = type(self).__module__
        context.add_llm_tools(*tools)

    @filter.on_llm_request()
    async def filter_kairo_tools(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        """只移除不适用或无权限的工具，不补回人格或用户已移除的工具。"""
        if req.func_tool is None:
            return
        if not is_kairo_event(event):
            excluded = KAIRO_TOOL_NAMES
        else:
            excluded = frozenset() if event.is_admin() else KAIRO_ADMIN_TOOL_NAMES
            if event.message_obj.type != MessageType.GROUP_MESSAGE:
                excluded = excluded | {"kairo_get_group_members"}
        for name in excluded:
            req.func_tool.remove_tool(name)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("kairo notify")
    async def notify(
        self,
        event: AstrMessageEvent,
        platform_id: str,
        login_name: str,
        text: GreedyStr,
    ):
        """按准确工号发送文本通知，必须明确指定 Kairo 平台实例。"""
        # GreedyStr 让真实指令解析器接收完整正文；其内部会归一化空白，
        # 因而从已由宿主去掉唤醒前缀的原文还原正文空格和换行。
        parts = event.get_message_str().split(maxsplit=4)
        if not text or len(parts) < 5 or not parts[4].strip():
            yield event.plain_result("用法：/kairo notify <平台实例ID> <准确工号> <正文>")
            return
        text = parts[4]
        platform = self.context.get_platform_inst(platform_id)
        if platform is None or platform.meta().name != "kairo":
            yield event.plain_result(f"未找到 Kairo 平台实例“{platform_id}”")
            return
        try:
            result = await platform.get_client().notify_employee(login_name, text)
        except BridgeError as exc:
            yield event.plain_result(f"通知调用失败（{exc.code}）：{exc.message}")
            return

        operation_id = result.get("operationId", "未返回")
        diagnostic = f"operationId={operation_id}"
        if result.get("nativeCode") is not None:
            diagnostic += f"，nativeCode={result['nativeCode']}"
        status = result.get("status")
        if status == "sent":
            notice = "原生发送已确认（sent），不代表对方已收到或已读。"
        elif status == "failed":
            notice = f"通知发送失败（failed）：{result.get('error') or '原生发送失败'}。"
        elif status == "unknown":
            notice = "通知发送结果不确定（unknown），不会自动重发，请先核查原生结果。"
            if result.get("error"):
                notice += f" 原因：{result['error']}。"
        else:
            raise BridgeError("INVALID_RESPONSE", f"通知返回无效状态：{status!r}")
        yield event.plain_result(f"{notice}\n{diagnostic}")
