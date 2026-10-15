"""Shared Kairo sending and access checks for events and proactive callers."""

from html import escape
from pathlib import Path
from uuid import uuid4

from astrbot.api.event import MessageChain
from astrbot.api.message_components import At, AtAll, File, Image, Json, Plain, Record, Reply
from astrbot.api.platform import AstrBotMessage, MessageType

from .policy import KairoAccessPolicy
from .transport import BridgeError, BridgeServer


class KairoClient:
    """Send through one policy boundary without exposing raw bridge requests."""

    def __init__(
        self, server: BridgeServer, policy: KairoAccessPolicy, *, reply_format: str = "text"
    ) -> None:
        if reply_format not in {"text", "card"}:
            raise ValueError("reply_format 必须是 text 或 card")
        self._server = server
        self._policy = policy
        self.reply_format = reply_format

    async def _check_employee_id(self, user_id: str) -> None:
        if not self._policy.requires_employee_identity:
            return
        response = await self._server.request("get_user_profile", {"user_id": user_id})
        profile = response["profile"]
        if profile is None or not profile.get("loginName"):
            raise BridgeError("IDENTITY_UNAVAILABLE", f"无法取得员工 {user_id} 的准确工号")
        self._policy.check_employee(profile["loginName"])

    async def check_inbound(self, message: AstrBotMessage) -> None:
        """Apply the same employee and group rules before AstrBot sees a message."""
        if message.type == MessageType.GROUP_MESSAGE:
            self._policy.check_group(str(message.raw_message["sessionId"]))
        await self._check_employee_id(str(message.sender.user_id))

    async def _check_target(self, session_id: str, sender_id: str | None) -> None:
        if not (self._policy.requires_employee_identity or self._policy.requires_group_identity):
            return
        response = await self._server.request("get_sessions", {})
        session = next((item for item in response["sessions"] if item["id"] == session_id), None)
        if session is None:
            raise BridgeError("SESSION_NOT_FOUND", f"原生会话不存在：{session_id}")
        if session["type"] == "group":
            self._policy.check_group(session_id)
            if sender_id is not None:
                await self._check_employee_id(sender_id)
        elif session["type"] == "private":
            await self._check_employee_id(str(session["receiverId"]))
        else:
            raise BridgeError("UNSUPPORTED_SESSION", f"不支持的 KK9 会话类型：{session['type']}")

    async def _send_operation(
        self,
        action: str,
        params: dict,
        *,
        operation_id: str | None = None,
        timeout: float | None = None,
    ) -> dict:
        """Submit once and reconcile only the same intent after an uncertain result."""
        operation_id = uuid4().hex if operation_id is None else operation_id.strip()
        if not operation_id:
            raise ValueError("operation_id 不能为空")
        params = {**params, "operation_id": operation_id}
        request_error: str | None = None
        try:
            result = await self._server.request(action, params, timeout=timeout)
        except BridgeError as exc:
            if exc.code not in {"TIMEOUT", "CONNECTION_LOST"}:
                raise
            request_error = exc.code
            result = {"status": "unknown", "operationId": operation_id, "error": str(exc)}
        if result["status"] == "unknown":
            try:
                result = await self._server.request(
                    "get_send_status", {"operation_id": operation_id}
                )
            except BridgeError as exc:
                result = {
                    **result,
                    "error": f"{result.get('error') or '发送结果未知'}；状态查询失败 [{exc.code}]：{exc}",
                }
        if request_error is not None and result.get("status") != "sent" and not result.get("code"):
            result = {**result, "code": request_error}
        return {**result, "operationId": operation_id}

    async def search_employees(self, keyword: str) -> dict:
        """Read the Driver's complete, UID-deduplicated employee search result.

        Partial or malformed responses cannot establish a unique recipient and are
        rejected in full. Driver owns pagination; this call never retries or truncates.
        """
        keyword = keyword.strip()
        if not keyword:
            raise ValueError("员工搜索姓名不能为空")
        result = await self._server.request("search_employees", {"keyword": keyword}, timeout=35)
        if (
            not isinstance(result, dict)
            or result.get("hasMore") is not False
            or not isinstance(result.get("employees"), list)
        ):
            raise BridgeError("INVALID_RESPONSE", "员工搜索未返回完整的候选列表")
        seen: set[str] = set()
        for employee in result["employees"]:
            if not isinstance(employee, dict) or not {
                "id",
                "name",
                "loginName",
                "departmentPaths",
            }.issubset(employee):
                raise BridgeError("INVALID_RESPONSE", "员工搜索候选缺少必要身份字段")
            uid = employee["id"]
            if not isinstance(uid, str) or not uid.strip() or uid in seen:
                raise BridgeError("INVALID_RESPONSE", "员工搜索候选 UID 无效或重复")
            for field in ("name", "loginName"):
                if employee[field] is not None and not isinstance(employee[field], str):
                    raise BridgeError("INVALID_RESPONSE", f"员工搜索候选 {field} 类型无效")
            paths = employee["departmentPaths"]
            if paths is not None and (
                not isinstance(paths, list) or any(not isinstance(path, str) for path in paths)
            ):
                raise BridgeError("INVALID_RESPONSE", "员工搜索候选部门路径类型无效")
            seen.add(uid)
        return result

    async def get_group_members(
        self, session_id: str, *, sender_id: str | None = None
    ) -> list[dict]:
        """读取完整原生群资料；沿用当前名单，失败不返回部分成员。"""
        if (
            not isinstance(session_id, str)
            or not session_id.isascii()
            or not session_id.isdecimal()
            or session_id.startswith("0")
        ):
            raise ValueError(f"需要原生 KK9 群会话 ID：{session_id}")
        self._policy.check_group(session_id)
        if sender_id is not None:
            await self._check_employee_id(sender_id)
        response = await self._server.request(
            "get_group_members", {"session_id": session_id}, timeout=35
        )
        if not isinstance(response, dict) or not isinstance(response.get("members"), list):
            raise BridgeError("INVALID_RESPONSE", "群成员查询未返回完整成员列表")
        members = response["members"]
        required = {"id", "name", "loginName", "departmentPaths", "position"}
        seen: set[str] = set()
        for member in members:
            if not isinstance(member, dict) or not required.issubset(member):
                raise BridgeError("INVALID_RESPONSE", "群成员档案缺少必要字段")
            uid = member["id"]
            if not isinstance(uid, str) or not uid.strip() or uid in seen:
                raise BridgeError("INVALID_RESPONSE", "群成员 UID 无效或重复")
            for field in ("name", "loginName", "position"):
                if member[field] is not None and not isinstance(member[field], str):
                    raise BridgeError("INVALID_RESPONSE", f"群成员 {field} 类型无效")
            paths = member["departmentPaths"]
            if paths is not None and (
                not isinstance(paths, list) or any(not isinstance(path, str) for path in paths)
            ):
                raise BridgeError("INVALID_RESPONSE", "群成员部门路径类型无效")
            seen.add(uid)
        # 全量档案可能等待数十秒，返回前重新应用这段时间内更新的名单。
        self._policy.check_group(session_id)
        if sender_id is not None:
            await self._check_employee_id(sender_id)
        return members

    async def notify_employee_uid(
        self,
        user_id: str,
        login_name: str,
        text: str | None = None,
        *,
        card: dict | None = None,
        media: dict | None = None,
        operation_id: str | None = None,
    ) -> dict:
        """Recheck the selected UID and exact login snapshot, then use the policy send path.

        A changed or missing identity is not a reason to guess another login or UID.
        The bridge supplies the real raw login, never the Driver's display fallback.
        """
        if sum(value is not None for value in (text, card, media)) != 1:
            raise ValueError("通知必须且只能提供 text、card 或 media 之一")
        if not user_id.strip() or not login_name.strip():
            raise BridgeError("IDENTITY_UNAVAILABLE", "所选员工缺少 UID 或准确工号")
        response = await self._server.request("get_user_profile", {"user_id": user_id})
        if not isinstance(response, dict) or "profile" not in response:
            raise BridgeError("INVALID_RESPONSE", "员工档案响应无效")
        profile = response["profile"]
        if profile is None:
            raise BridgeError("IDENTITY_UNAVAILABLE", f"无法取得员工 {user_id} 的档案")
        if not isinstance(profile, dict):
            raise BridgeError("INVALID_RESPONSE", "员工档案类型无效")
        uid, login = profile.get("id"), profile.get("loginName")
        if (
            not isinstance(uid, str)
            or not uid.strip()
            or not isinstance(login, str)
            or not login.strip()
        ):
            raise BridgeError("IDENTITY_UNAVAILABLE", f"员工 {user_id} 缺少真实 UID 或准确工号")
        if uid != user_id or login != login_name:
            raise BridgeError("IDENTITY_CHANGED", "所选员工 UID 或准确工号已变化，请重新查询")
        if card is not None:
            return await self.notify_employee_card(login_name, card, operation_id=operation_id)
        if media is not None:
            self._policy.check_employee(login_name)
            return await self._send_operation(
                "send_media_to_user", {**media, "login_name": login_name}, operation_id=operation_id
            )
        return await self.notify_employee(login_name, text, operation_id=operation_id)

    async def notify_employee(
        self, login_name: str, text: str, *, operation_id: str | None = None
    ) -> dict:
        """Notify an exact employee login, including a first private contact.

        Args:
            login_name: Exact, case-sensitive KK9 login name, not a nickname or UID.
            text: Nonempty notification text; this API does not send media.
            operation_id: Stable intent ID to keep when querying an uncertain send.

        Returns:
            Native sent/failed/unknown outcome and operationId. A sent outcome also
            contains the confirmed messageId and private sessionId, not delivery proof.

        Raises:
            BridgeError: Access was denied, or the bridge could not accept the request.
            ValueError: The employee, text, or operation ID was empty.
        """
        login_name = login_name.strip()
        if not login_name or not text.strip():
            raise ValueError("准确工号和通知正文不能为空")
        self._policy.check_employee(login_name)
        return await self._send_operation(
            "send_to_user", {"login_name": login_name, "text": text}, operation_id=operation_id
        )

    async def notify_employee_card(
        self, login_name: str, card: dict, *, operation_id: str | None = None
    ) -> dict:
        """按准确工号发送卡片；首次私聊由原生发送建立，不预发文本。"""
        login_name = login_name.strip()
        if not login_name:
            raise ValueError("准确工号不能为空")
        params = self._card_params(card)
        self._policy.check_employee(login_name)
        return await self._send_operation(
            "send_card_to_user",
            {**params, "login_name": login_name},
            operation_id=operation_id,
        )

    async def prepare_media(self, kind: str, source: Image | File | Path) -> dict:
        """缓存附件字节；候选选择期间不再读取原文件或选择消息的附件。"""
        if kind not in {"image", "file"}:
            raise ValueError("附件只支持 image 或 file")
        if isinstance(source, File):
            resolved = await source.get_file()
            if not resolved:
                raise BridgeError("FILE_UNAVAILABLE", "待发送文件无法读取")
            path = Path(resolved)
            name = source.name or path.name
        elif isinstance(source, Image):
            path = Path(await source.convert_to_file_path())
            name = path.name
        else:
            path, name = source, source.name
        descriptor = await self._server.add_file(path, name=name)
        return {"kind": kind, "file_id": descriptor["file_id"], "name": descriptor["name"]}

    async def send_media(
        self,
        target_session_id: str,
        media: dict,
        *,
        sender_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict:
        """发送已缓存的图片或文件到明确原生会话，保留发送结果和操作 ID。"""
        if (
            not target_session_id.isascii()
            or not target_session_id.isdecimal()
            or target_session_id.startswith("0")
        ):
            raise ValueError(f"需要原生 KK9 会话 ID：{target_session_id}")
        await self._check_target(target_session_id, sender_id)
        return await self._send_operation(
            "send", {**media, "target_session_id": target_session_id}, operation_id=operation_id
        )

    async def send_voice_text(
        self,
        target_session_id: str,
        text: str,
        *,
        sender_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict:
        """由 Driver 合成并发送语音，返回原生结果，不调用宿主 TTS。

        Args:
            target_session_id: 明确的原生会话 ID。
            text: 要朗读的非空文字。
            sender_id: 回复群消息时保留的原始员工 UID，用于名单复查。
            operation_id: 同一发送意图的稳定 ID；未知结果只查询，不重发。

        Returns:
            含 operationId 的 sent/failed/unknown 原生发送结果。
        """
        if (
            not target_session_id.isascii()
            or not target_session_id.isdecimal()
            or target_session_id.startswith("0")
        ):
            raise ValueError(f"需要原生 KK9 会话 ID：{target_session_id}")
        if not text.strip():
            raise ValueError("语音正文不能为空")
        await self._check_target(target_session_id, sender_id)
        # Driver 合成最多30秒、AMR编码最多30秒、原生提交及回执最多20秒。
        return await self._send_operation(
            "send",
            {"kind": "voice_text", "target_session_id": target_session_id, "text": text},
            operation_id=operation_id,
            timeout=90,
        )

    async def send_card(
        self,
        target_session_id: str,
        card: dict,
        *,
        sender_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict:
        """发送一张 Kairo Json 卡片，返回含稳定操作 ID 的原生结果。

        card 使用 kairo.app/kairo.url/kairo.biz 的既有 Json 字段；名单和
        完整卡片预检与消息链一致。调用方可在等待取消后查询同一 operation_id。
        """
        if (
            not target_session_id.isascii()
            or not target_session_id.isdecimal()
            or target_session_id.startswith("0")
        ):
            raise ValueError(f"需要原生 KK9 会话 ID：{target_session_id}")
        params = self._card_params(card)
        await self._check_target(target_session_id, sender_id)
        return await self._send_operation(
            "send",
            {**params, "target_session_id": target_session_id},
            operation_id=operation_id,
        )

    async def get_send_status(self, operation_id: str) -> dict:
        """Query an existing intent without resubmitting it."""
        return await self._server.request("get_send_status", {"operation_id": operation_id})

    async def get_sessions(self) -> list[dict]:
        """Read native session IDs for routing and group-list configuration."""
        response = await self._server.request("get_sessions", {})
        return response["sessions"]

    @staticmethod
    def _card_params(data: dict) -> dict:
        """Validate the complete card against the wire contract before sending."""
        card = dict(data)
        card_type = card.pop("type", None)
        shapes = {
            "kairo.app": ("app_card", ("title", "content"), ("linkUrl", "pcAppCode")),
            "kairo.url": ("url_card", ("title", "summary", "linkUrl"), ("picUrl",)),
            "kairo.biz": ("biz_card", ("title", "content", "bizUrl"), ()),
        }
        if not isinstance(card_type, str) or card_type not in shapes:
            raise BridgeError("UNSUPPORTED_CARD", f"不支持的 Kairo 卡片类型：{card_type}")
        kind, required, optional = shapes[card_type]
        allowed = set(required + optional)
        if kind == "biz_card":
            allowed.update(("bizType", "summary"))
        extra = card.keys() - allowed
        if extra:
            raise BridgeError("INVALID_CARD", f"卡片包含不支持的字段：{', '.join(sorted(extra))}")
        for key in (*required, *(key for key in optional if key in card)):
            value = card.get(key)
            if not isinstance(value, str) or not value.strip():
                raise BridgeError("INVALID_CARD", f"卡片字段 {key} 必须是非空文字")
            # JavaScript string.length counts UTF-16 units, not Unicode points.
            if len(value.encode("utf-16-le", "surrogatepass")) // 2 > 128_000:
                raise BridgeError("INVALID_CARD", f"卡片字段 {key} 超过 128000 UTF-16 单位")
        if kind == "biz_card":
            if (
                type(card.get("bizType")) is not int
                or card["bizType"] not in {1, 2}
                or not card["bizUrl"].startswith("/")
                or card["bizUrl"].startswith("//")
            ):
                raise BridgeError("INVALID_CARD", "业务卡片需要 bizType=1/2 和相对 bizUrl 路径")
            if "summary" in card and (
                not isinstance(card["summary"], list)
                or any(not isinstance(item, str) for item in card["summary"])
            ):
                raise BridgeError("INVALID_CARD", "业务卡片 summary 必须是字符串数组")
        return {"kind": kind, "card": card}

    def _plan_chain(self, message: MessageChain) -> list[tuple[dict, object | None]]:
        """Validate component combinations before any part is submitted."""
        planned: list[tuple[dict, object | None]] = []
        text_parts: list[str] = []
        mentions: list[dict] = []
        reply_to: str | None = None

        def flush_text() -> None:
            nonlocal text_parts, mentions, reply_to
            text = "".join(text_parts)
            if text.strip() or mentions:
                if self.reply_format == "card":
                    if reply_to or mentions:
                        raise BridgeError(
                            "UNSUPPORTED_COMBINATION",
                            "卡片回复不支持引用或提及，请关闭引用/提及或改用文字回复",
                        )
                    params = self._card_params(
                        {
                            "type": "kairo.app",
                            "title": "回复",
                            "content": escape(text).replace("\n", "<br>"),
                        }
                    )
                else:
                    params = {"kind": "text", "text": text}
                    if mentions:
                        params["mentions"] = mentions
                    if reply_to:
                        params["reply_to"] = reply_to
                planned.append((params, None))
                text_parts, mentions, reply_to = [], [], None

        for component in message.chain:
            if isinstance(component, Plain):
                text_parts.append(component.text)
            elif isinstance(component, AtAll):
                mentions.append({"uid": "all", "name": "所有人"})
            elif isinstance(component, At):
                uid = str(component.qq)
                if uid in {"all", "-1"}:
                    mentions.append({"uid": "all", "name": "所有人"})
                else:
                    mentions.append({"uid": uid, "name": component.name or uid})
            elif isinstance(component, Reply):
                if reply_to is not None:
                    raise BridgeError("UNSUPPORTED_COMBINATION", "一段文字不能引用多个消息")
                reply_to = str(component.id)
            elif isinstance(component, (Image, File, Record, Json)):
                if (reply_to or mentions) and not "".join(text_parts).strip():
                    raise BridgeError(
                        "UNSUPPORTED_COMBINATION",
                        "KK9 媒体和卡片不支持引用或提及，请先提供要引用/提及的文字",
                    )
                flush_text()
                if isinstance(component, Json):
                    planned.append((self._card_params(component.data), None))
                else:
                    kind = (
                        "image"
                        if isinstance(component, Image)
                        else ("voice" if isinstance(component, Record) else "file")
                    )
                    planned.append(({"kind": kind}, component))
            else:
                raise BridgeError(
                    "UNSUPPORTED_COMPONENT", f"Kairo 暂不支持发送 {type(component).__name__} 消息段"
                )
        flush_text()
        if reply_to:
            raise BridgeError("UNSUPPORTED_COMBINATION", "引用回复缺少正文")
        if not planned:
            raise BridgeError("EMPTY_MESSAGE", "消息没有可发送的内容")
        return planned

    async def send_chain(
        self, target_session_id: str, message: MessageChain, *, sender_id: str | None = None
    ) -> None:
        """Send in chain order; preserve an incoming group actor for policy rechecks.

        Args:
            target_session_id: Native KK9 session ID, never a UID or window identifier.
            message: Ordered supported AstrBot components.
            sender_id: Original group sender UID when replying to that employee.

        Raises:
            BridgeError: Access denied, unsupported content, failed or uncertain send.
            ValueError: The native target ID is invalid.
        """
        if (
            not target_session_id.isascii()
            or not target_session_id.isdecimal()
            or target_session_id.startswith("0")
        ):
            raise ValueError(f"需要原生 KK9 会话 ID：{target_session_id}")
        planned = self._plan_chain(message)
        await self._check_target(target_session_id, sender_id)
        for params, media in planned:
            if media is not None:
                if isinstance(media, File):
                    resolved = await media.get_file()
                    if not resolved:
                        raise BridgeError("FILE_UNAVAILABLE", "待发送文件无法读取")
                    path = Path(resolved)
                    name = media.name or path.name
                else:
                    path = Path(await media.convert_to_file_path())
                    name = path.name
                descriptor = await self._server.add_file(path, name=name)
                params = {**params, "file_id": descriptor["file_id"], "name": descriptor["name"]}
            result = await self._send_operation(
                "send", {**params, "target_session_id": target_session_id}
            )
            if result["status"] != "sent":
                code = "SEND_FAILED" if result["status"] == "failed" else "SEND_UNKNOWN"
                error = result.get("error") or "KK9 发送结果未知；未自动重发"
                raise BridgeError(
                    code, f"{error}；operation_id={result['operationId']}", result=result
                )
