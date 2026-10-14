"""Admin-only employee notifications bound to native sender/session and fresh UID identity."""

import asyncio
import re
from dataclasses import dataclass
from time import perf_counter_ns
from uuid import uuid4

from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.tool import FunctionTool
from astrbot.core.astr_agent_context import AstrAgentContext
from jsonschema import ValidationError, validate

from .event import KairoMessageEvent
from .tools import _ATTEMPTS_KEY, _card_data, _media_data, _outcome_error, is_kairo_event
from .transport import BridgeError

_SEND_KEY = "astrbot_plugin_kairo.notification_send"
_TEXT = {"type": "string", "minLength": 1}
_CHOICE = re.compile(
    r"(?:(?:请\s*)?(?:选择|选)\s*)?(?:第\s*)?"
    r"([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*(?:个|位|号)?[。！!]?"
)
_DIGITS = {char: number for number, char in enumerate("零一二三四五六七八九")}
_DIGITS.update({"〇": 0, "两": 2})


def _authorization_error(event) -> str | None:
    if not is_kairo_event(event):
        return "错误：通知工具仅可用于当前真实的 Kairo 消息事件。"
    if not event.is_admin():
        return "错误（ACCESS_DENIED）：仅真实管理员角色可查询、选择或通知员工。"
    return None


def _raw_choice(event: KairoMessageEvent, candidate_count: int) -> int | None:
    # Waking/context plugins may rewrite message_str; only native current content
    # can authorize selection. A model-provided integer alone is never consent.
    content = event.message_obj.raw_message.get("content")
    if not isinstance(content, str) or not (match := _CHOICE.fullmatch(content.strip())):
        return None
    number = match[1]
    if number.isascii():
        # Reject impossible indexes before int conversion, without imposing any
        # limit on the complete candidate list or Python's large-int digit limit.
        digits = number.lstrip("0") or "0"
        if len(digits) > len(str(candidate_count)):
            return None
        return int(digits)
    if not any(unit in number for unit in "十百千"):
        if len(number) != 1:
            return None
        return _DIGITS[number]
    total, digit, last_unit = 0, None, 10_000
    for char in number:
        if char in _DIGITS:
            if digit is not None and digit != 0:
                return None
            digit = _DIGITS[char]
            continue
        unit = {"十": 10, "百": 100, "千": 1000}[char]
        if unit >= last_unit:
            return None
        if digit is None:
            if total or unit != 10:
                return None
            digit = 1
        if digit == 0:
            return None
        total += digit * unit
        digit, last_unit = None, unit
    return total + (digit or 0)


def _timestamp(event: KairoMessageEvent) -> float:
    timestamp = event.message_obj.raw_message.get("timestamp")
    if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool) and timestamp > 0:
        return timestamp / 1000 if timestamp > 10**11 else timestamp
    return event.message_obj.timestamp


@dataclass
class _Pending:
    body: str | dict
    operation_id: str
    source_id: str
    source_timestamp: float
    # Immutable ordered snapshots bind selection to UID + exact login, not names.
    candidates: tuple[tuple[str, str | None], ...] | None = None
    ready_at_ns: int = 0


class KairoNotifications:
    """One plugin-local pending intent per (platform instance, native session, sender)."""

    def __init__(self) -> None:
        self._pending: dict[tuple[str, str, str], _Pending] = {}
        # Retain only generation metadata after consuming a pending intent, so an
        # older caller-policy lookup cannot resurrect an already superseded search.
        self._latest: dict[tuple[str, str, str], tuple[int, str]] = {}

    @staticmethod
    def _scope(event: KairoMessageEvent) -> tuple[str, str, str]:
        return event.get_platform_id(), event.target_session_id, event.sender_id

    async def _send(
        self, event: KairoMessageEvent, pending: _Pending, uid: str, login: str | None
    ) -> str:
        if error := _authorization_error(event):
            return error
        await event.adapter.get_client().check_inbound(event.message_obj)
        if error := _authorization_error(event):
            return error
        current = self._latest.get(self._scope(event))
        if current is None or current[1] != pending.operation_id:
            return "该通知已被同一管理员的新通知替换，旧查询不会发送。"
        if not login or not login.strip():
            return (
                "错误（IDENTITY_UNAVAILABLE）：所选员工工号未提供，未发送，不会使用 UID 代替工号。"
                f"operationId={pending.operation_id}"
            )
        if previous := event.get_extra(_SEND_KEY):
            return f"错误：当前消息已有通知发送尝试，不重发。operationId={previous}"
        # Both notification tools share this event-level side-effect guard.
        # Claim before recipient profile lookup/side-effect await, including cancellation.
        event.set_extra(_SEND_KEY, pending.operation_id)
        if isinstance(pending.body, str):
            content = {"text": pending.body}
        elif "kind" in pending.body:
            content = {"media": pending.body}
        else:
            content = {"card": pending.body}
        result = await event.adapter.get_client().notify_employee_uid(
            uid, login, **content, operation_id=pending.operation_id
        )
        if result.get("status") != "sent":
            prefix = f"[{result['code']}] " if result.get("code") is not None else ""
            return prefix + _outcome_error(result)
        event._has_send_oper = True
        return (
            "原生已确认发送（sent），不代表送达或已读。"
            f"operationId={result.get('operationId') or pending.operation_id}，"
            f"messageId={result.get('messageId') or '未返回'}，"
            f"sessionId={result.get('sessionId') or '未返回'}"
        )

    async def _notify(self, event: KairoMessageEvent, name: str, args: dict, attempt: dict) -> str:
        scope = self._scope(event)
        previous = self._latest.get(scope)
        if previous is not None and previous[0] > event.received_at_ns:
            return "该通知消息早于当前通知意图，旧查询不会替换或发送。"
        self._latest[scope] = (event.received_at_ns, attempt["operation_id"])
        is_media = name in {"kairo_send_image", "kairo_send_file"}
        pending = _Pending(
            body=args["text"]
            if name == "kairo_notify_employee"
            else (dict(args) if is_media else _card_data(name, args)),
            operation_id=attempt["operation_id"],
            source_id=event.message_obj.message_id,
            source_timestamp=_timestamp(event),
        )
        # Replace old choices before the first await. Object identity is the search
        # generation: an older in-flight result must never publish or auto-send.
        self._pending[scope] = pending
        try:
            if is_media:
                pending.body = await _media_data(event, name, args)
                if self._pending.get(scope) is not pending:
                    return "该通知已被同一管理员的新通知替换，旧附件不会发送。"
            result = await event.adapter.get_client().search_employees(args["name"])
        except BaseException:
            if self._pending.get(scope) is pending:
                del self._pending[scope]
            raise
        if self._pending.get(scope) is not pending:
            return "该通知已被同一管理员在当前会话的新通知替换，旧查询不会发送。"
        employees = result["employees"]
        if not employees:
            del self._pending[scope]
            return "未找到匹配员工，未发送通知。请核实姓名后重新发起通知。"
        if len(employees) == 1 and employees[0]["name"] == args["name"].strip():
            del self._pending[scope]
            employee = employees[0]
            return await self._send(event, pending, employee["id"], employee["loginName"])
        pending.candidates = tuple((item["id"], item["loginName"]) for item in employees)
        lines = ["找到以下候选员工，尚未发送。请完整展示列表，等待管理员下一条消息明确选择编号："]
        for index, employee in enumerate(employees, 1):
            name = employee["name"] or "姓名未提供"
            login = employee["loginName"]
            login = login if login and login.strip() else "工号未提供"
            paths = employee["departmentPaths"]
            departments = "；".join(paths) if paths else "部门未提供"
            lines.append(f"{index}. 姓名：{name}；工号：{login}；部门：{departments}")
        lines.append(
            "请在下一条消息回复编号（例如 2 或 选择第二个）；不能自行选择或在当前消息立即调用选择工具。"
        )
        pending.ready_at_ns = perf_counter_ns()
        return "\n".join(lines)

    async def _select(self, event: KairoMessageEvent, args: dict, attempt: dict) -> str:
        scope = self._scope(event)
        pending = self._pending.get(scope)
        if pending is None or pending.candidates is None:
            return "错误：当前管理员在此原生会话没有可选择的通知候选，请先发起员工通知。"
        if (
            event.message_obj.message_id == pending.source_id
            or event.received_at_ns <= pending.ready_at_ns
            or _timestamp(event) < pending.source_timestamp
        ):
            return "错误：必须等待候选列表后的下一条真实用户消息选择，原消息或过期消息不能确认。"
        choice = _raw_choice(event, len(pending.candidates))
        if choice != args["choice"] or choice is None:
            return "错误（INVALID_ARGUMENT）：当前原生用户消息没有与 choice 一致的明确数字选择。"
        if not 1 <= choice <= len(pending.candidates):
            return "错误（INVALID_ARGUMENT）：选择编号不在候选范围内，请按列表重新选择。"
        uid, login = pending.candidates[choice - 1]
        attempt["operation_id"] = pending.operation_id
        # Consume before the side-effect await; another event cannot submit this
        # intent again, even after identity failure, timeout or cancellation.
        del self._pending[scope]
        return await self._send(event, pending, uid, login)

    async def _execute(self, event: KairoMessageEvent, name: str, args: dict, attempt: dict) -> str:
        if error := _authorization_error(event):
            return error
        try:
            await event.adapter.get_client().check_inbound(event.message_obj)
            if error := _authorization_error(event):
                return error
            if name == "kairo_select_employee":
                return await self._select(event, args, attempt)
            return await self._notify(event, name, args, attempt)
        except BridgeError as exc:
            if exc.result:
                result = dict(exc.result)
                if not result.get("operationId"):
                    result["operationId"] = attempt["operation_id"]
                return f"[{exc.code}] {_outcome_error(result)}"
            return (
                f"错误（{exc.code}）：{exc.message}；"
                f"operationId={attempt['operation_id']}；不重发。"
            )
        except (ValueError, TypeError) as exc:
            return (
                f"错误（INVALID_ARGUMENT）：{exc}；operationId={attempt['operation_id']}；不重发。"
            )
        except OSError as exc:
            return (
                f"错误（FILE_UNAVAILABLE）：{exc}；operationId={attempt['operation_id']}；不重发。"
            )

    async def _call(
        self, tool: FunctionTool, context: ContextWrapper[AstrAgentContext], args: dict
    ) -> str | None:
        event = context.context.event
        # Authorization precedes schema/state/search access; model arguments or
        # platform strings alone never grant admin privileges.
        if error := _authorization_error(event):
            return error
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
            attempt = {"operation_id": uuid4().hex}
            task = asyncio.create_task(self._execute(event, tool.name, args, attempt))
            attempt["task"] = task
            attempts[tool.name] = attempt
            return await task
        task = attempt["task"]
        if task.cancelled():
            return (
                "错误：上次通知等待已取消，结果不确定（unknown）；不重发，请核查原生结果。"
                f"operationId={attempt['operation_id']}"
            )
        return await asyncio.shield(task)


class KairoNotifyEmployeeTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_notify_employee",
            description=(
                "仅当前真实 Kairo 管理员明确要求通知员工时调用。name 是用户提供的员工姓名，"
                "text 是完整原始通知正文，不能填 UID 或猜测工号。仅唯一且姓名完全相同的员工可直接发送。"
                "模糊或重名结果必须完整展示所有姓名、准确工号和部门候选，并等待用户下一条消息明确选择编号；"
                "不得自行选择，不得在同一消息调用选择工具。查无结果或工号缺失不发送，未知结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {"name": _TEXT, "text": _TEXT},
                "required": ["name", "text"],
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str:
        return await self._manager._call(self, context, kwargs)


class KairoSelectEmployeeTool(FunctionTool[AstrAgentContext]):
    def __init__(self, manager: KairoNotifications) -> None:
        super().__init__(
            name="kairo_select_employee",
            description=(
                "仅管理员已看到员工候选列表后，在下一条真实用户消息明确回复数字编号时调用。"
                "choice 必须对应当前原生消息的明确数字选择，不能由模型推断或替用户决定。"
                "按保存的候选 UID 和原始通知文本或卡片发送，不能修改内容、工号、会话或用户。"
                "发送前复查真实 UID、准确工号和员工名单；失败或未知结果不得重发。"
            ),
            parameters={
                "type": "object",
                "properties": {"choice": {"type": "integer", "minimum": 1}},
                "required": ["choice"],
                "additionalProperties": False,
            },
        )
        self._manager = manager

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str:
        return await self._manager._call(self, context, kwargs)
