"""Kairo 媒体、卡片工具及请求级权限分组。"""

from __future__ import annotations

import asyncio
from html import escape
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from astrbot.api.message_components import File, Image
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.tool import FunctionTool
from astrbot.core.astr_agent_context import AstrAgentContext
from jsonschema import ValidationError, validate

from .event import KairoMessageEvent
from .transport import BridgeError

if TYPE_CHECKING:
    from .notifications import KairoNotifications

KAIRO_ADMIN_TOOL_NAMES = frozenset({"kairo_notify_employee", "kairo_select_employee"})
KAIRO_TOOL_NAMES = (
    frozenset(
        {
            "kairo_send_voice",
            "kairo_send_image",
            "kairo_send_file",
            "kairo_send_app_card",
            "kairo_send_url_card",
            "kairo_send_biz_card",
        }
    )
    | KAIRO_ADMIN_TOOL_NAMES
)
_ATTEMPTS_KEY = "astrbot_plugin_kairo.tool_attempts"
_TEXT = {"type": "string", "minLength": 1}


def is_kairo_event(event) -> bool:
    # 平台名本身不是原生事件凭据；其他适配器不能伪造一个会话参数来发送。
    return isinstance(event, KairoMessageEvent) and event.get_platform_name() == "kairo"


def _outcome_error(result: dict) -> str:
    status = result.get("status")
    diagnostic = f"operationId={result.get('operationId') or '未返回'}"
    if result.get("nativeCode") is not None:
        diagnostic += f"，nativeCode={result['nativeCode']}"
    reason = result.get("error") or "原生发送未确认"
    if status == "unknown":
        return f"错误：发送结果不确定（unknown）：{reason}；不重发，请先核查原生结果。{diagnostic}"
    return f"错误：发送未成功（{status!r}）：{reason}。{diagnostic}"


def _card_data(name: str, args: dict) -> dict:
    data = {key: value for key, value in args.items() if key != "name"}
    if name == "kairo_send_app_card":
        data["type"] = "kairo.app"
        data["content"] = (
            escape(data.pop("text")).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
        )
    elif name == "kairo_send_url_card":
        data["type"] = "kairo.url"
    else:
        data["type"] = "kairo.biz"
        data["content"] = data.pop("text")
        if "summary" in data:
            data["summary"] = list(data["summary"])
    return data


async def _media_data(event: KairoMessageEvent, name: str, args: dict) -> dict:
    kind = "image" if name == "kairo_send_image" else "file"
    if "path" in args:
        if not event.is_admin():
            raise BridgeError("ACCESS_DENIED", "仅管理员可指定宿主本地文件路径")
        if "attachment_index" in args:
            raise ValueError("path 和 attachment_index 不能同时提供")
        source = Path(args["path"])
    else:
        component = Image if kind == "image" else File
        attachments = [item for item in event.get_messages() if isinstance(item, component)]
        index = args.get("attachment_index", 1)
        if index > len(attachments):
            raise BridgeError("FILE_UNAVAILABLE", f"当前消息没有第 {index} 个{kind}附件")
        source = attachments[index - 1]
    return await event.adapter.get_client().prepare_media(kind, source)


async def _submit(event: KairoMessageEvent, name: str, args: dict, operation_id: str) -> str | None:
    try:
        if name == "kairo_send_voice":
            result = await event.adapter.get_client().send_voice_text(
                event.target_session_id,
                args["text"],
                sender_id=event.sender_id,
                operation_id=operation_id,
            )
        elif name in {"kairo_send_image", "kairo_send_file"}:
            client = event.adapter.get_client()
            # 任意宿主路径仅管理员可读；先检查再做名单查询或文件 I/O。
            if "path" in args and not event.is_admin():
                raise BridgeError("ACCESS_DENIED", "仅管理员可指定宿主本地文件路径")
            await client.check_inbound(event.message_obj)
            media = await _media_data(event, name, args)
            result = await client.send_media(
                event.target_session_id, media, sender_id=event.sender_id, operation_id=operation_id
            )
        else:
            data = _card_data(name, args)
            result = await event.adapter.get_client().send_card(
                event.target_session_id,
                data,
                sender_id=event.sender_id,
                operation_id=operation_id,
            )
        if result.get("status") != "sent":
            return _outcome_error(result)
        event._has_send_oper = True
    except BridgeError as exc:
        if exc.result:
            return f"[{exc.code}] {_outcome_error(exc.result)}"
        return (
            f"错误（{exc.code}）：{exc.message}；operationId={operation_id or '未返回'}；不重发。"
        )
    except (ValueError, TypeError) as exc:
        return f"错误（INVALID_ARGUMENT）：{exc}；operationId={operation_id or '未提交'}；不重发。"
    except OSError as exc:
        return f"错误（FILE_UNAVAILABLE）：{exc}；operationId={operation_id}；不重发。"
    # 宿主执行器用 None 结束默认主聊天 Agent 的续答，不另补一条文字消息。
    return None


async def _call(
    tool: FunctionTool, context: ContextWrapper[AstrAgentContext], args: dict
) -> str | None:
    event = context.context.event
    if not is_kairo_event(event):
        return "错误：该工具仅可用于当前真实的 Kairo 消息事件，不能指定其他发送目标。"
    attempts = event.get_extra(_ATTEMPTS_KEY)
    if attempts is None:
        attempts = {}
        event.set_extra(_ATTEMPTS_KEY, attempts)
    attempt = attempts.get(tool.name)
    if attempt is None:
        try:
            validate(args, tool.parameters)
            for key, value in args.items():
                if isinstance(value, str):
                    if not value.strip():
                        raise ValueError(f"{key} 必须是非空文字")
                    if len(value.encode("utf-16-le", "surrogatepass")) // 2 > 128_000:
                        raise ValueError(f"{key} 超过 128000 UTF-16 单位")
        except (ValidationError, ValueError, TypeError) as exc:
            reason = exc.message if isinstance(exc, ValidationError) else str(exc)
            return f"错误（INVALID_ARGUMENT）：{reason}；operationId=未提交。"
        operation_id = uuid4().hex
        # 在首次 await / 外部副作用之前记录；记录在事件而不是复用的工具实例上。
        task = asyncio.create_task(_submit(event, tool.name, args, operation_id))
        attempt = {"task": task, "operation_id": operation_id}
        attempts[tool.name] = attempt
        return await task
    task = attempt["task"]
    if task.cancelled():
        return (
            "错误：上次发送等待已取消，结果不确定（unknown）；不重发，请先核查原生结果。"
            f"operationId={attempt['operation_id'] or '未返回'}"
        )
    # 同批并发调用只等待首次尝试；取消一个重复等待者不能取消原始发送。
    return await asyncio.shield(task)


class KairoSendVoiceTool(FunctionTool[AstrAgentContext]):
    def __init__(self) -> None:
        super().__init__(
            name="kairo_send_voice",
            description=(
                "仅在用户明确要求语音/朗读回复时调用，将 text 交给 Driver 通过 Edge 合成语音并发送到当前会话。"
                "普通聊天不要调用；不支持音色、文件、引用或提及。不确定的发送结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {"text": _TEXT},
                "required": ["text"],
                "additionalProperties": False,
            },
        )

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str | None:
        return await _call(self, context, kwargs)


class KairoSendAppCardTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_send_app_card",
            description=(
                "仅在用户明确要求应用卡片/公告卡片时调用。不传 name 发到当前 Kairo 会话；"
                "管理员明确要求跨会话通知员工时，name 填用户提供的员工姓名，不得填 UID 或猜测工号。"
                "重名或模糊匹配须展示全部候选，等待下一条用户消息调用 kairo_select_employee 选择。"
                "title 和 text 为普通文字，正文由插件转义 HTML 并保留换行；linkUrl 可选。"
                "普通聊天不要调用；不要另补文字，不确定的发送结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {"title": _TEXT, "text": _TEXT, "linkUrl": _TEXT, "name": _TEXT},
                "required": ["title", "text"],
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str | None:
        if "name" in kwargs:
            return await self._manager._call(self, context, kwargs)
        return await _call(self, context, kwargs)


class KairoSendUrlCardTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_send_url_card",
            description=(
                "仅在用户明确要求链接卡片时调用。不传 name 发到当前 Kairo 会话；"
                "管理员明确要求跨会话通知员工时，name 填用户提供的员工姓名，不得填 UID 或猜测工号。"
                "重名或模糊匹配须展示全部候选，等待下一条用户消息调用 kairo_select_employee 选择。"
                "提供普通文字 title/summary 和用户指定或已知的 linkUrl，可选 picUrl。"
                "普通聊天不要调用；不要另补文字，不确定的发送结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": _TEXT,
                    "summary": _TEXT,
                    "linkUrl": _TEXT,
                    "picUrl": _TEXT,
                    "name": _TEXT,
                },
                "required": ["title", "summary", "linkUrl"],
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str | None:
        if "name" in kwargs:
            return await self._manager._call(self, context, kwargs)
        return await _call(self, context, kwargs)


class KairoSendBizCardTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_send_biz_card",
            description=(
                "仅在用户明确要求业务卡片时调用。不传 name 发到当前 Kairo 会话；"
                "管理员明确要求跨会话通知员工时，name 填用户提供的员工姓名，不得填 UID 或猜测工号。"
                "重名或模糊匹配须展示全部候选，等待下一条用户消息调用 kairo_select_employee 选择。"
                "title/text/summary 是普通文字；bizType=1 为任务样式、2 为日程样式，bizUrl 为已存在业务的相对路径。"
                "不可虚构业务目标，不会创建业务对象；没有真实业务路径时不要调用。"
                "普通聊天不要调用；不要另补文字，不确定的发送结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": _TEXT,
                    "text": _TEXT,
                    "bizType": {"type": "integer", "enum": [1, 2]},
                    "bizUrl": {"type": "string", "pattern": "^/(?!/)", "minLength": 1},
                    "summary": {"type": "array", "items": {"type": "string"}},
                    "name": _TEXT,
                },
                "required": ["title", "text", "bizType", "bizUrl"],
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str | None:
        if "name" in kwargs:
            return await self._manager._call(self, context, kwargs)
        return await _call(self, context, kwargs)


class KairoSendImageTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_send_image",
            description=(
                "仅在用户明确要求发送图片时调用。不传 name 发当前 Kairo 会话；"
                "管理员可用员工姓名 name 跨会话推送，包括首次私聊。不得猜测 UID 或工号。"
                "默认发送当前消息的第一张图片；attachment_index 为图片序号，从 1 开始。"
                "管理员也可用 path 指定已存在的宿主本地图片，不可编造路径或填 URL；"
                "path 与 attachment_index 二选一。没有可用图片时不能发送。"
                "重名或模糊匹配须展示全部候选，等下一条用户消息调用 kairo_select_employee。"
                "不另补文字，不确定的发送结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": _TEXT,
                    "path": _TEXT,
                    "attachment_index": {"type": "integer", "minimum": 1},
                },
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str | None:
        if "name" in kwargs:
            return await self._manager._call(self, context, kwargs)
        return await _call(self, context, kwargs)


class KairoSendFileTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_send_file",
            description=(
                "仅在用户明确要求发送文件时调用。不传 name 发当前 Kairo 会话；"
                "管理员可用员工姓名 name 跨会话推送，包括首次私聊。不得猜测 UID 或工号。"
                "默认发送当前消息的第一个文件；attachment_index 为文件序号，从 1 开始。"
                "管理员也可用 path 指定已存在的宿主本地文件，不可编造路径或填 URL；"
                "path 与 attachment_index 二选一。没有可用文件时不能发送。"
                "重名或模糊匹配须展示全部候选，等下一条用户消息调用 kairo_select_employee。"
                "保留原始文件名，不另补文字，不确定的发送结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": _TEXT,
                    "path": _TEXT,
                    "attachment_index": {"type": "integer", "minimum": 1},
                },
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str | None:
        if "name" in kwargs:
            return await self._manager._call(self, context, kwargs)
        return await _call(self, context, kwargs)
