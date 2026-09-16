"""KK9 消息与 AstrBot 消息之间的转换。"""

import base64
import json
import time
from collections.abc import Callable
from pathlib import Path

from astrbot.api.message_components import At, AtAll, File, Image, Plain, Reply
from astrbot.api.platform import AstrBotMessage, Group, MessageMember, MessageType

_GROUP_SESSION_PREFIX = "kairo:g:"


def encode_group_session(group_id: str, sender_id: str) -> str:
    """上下文按群成员隔离，编码中保留主动发送所需的真实群 ID。"""
    payload = json.dumps([group_id, sender_id], ensure_ascii=False, separators=(",", ":"))
    encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return _GROUP_SESSION_PREFIX + encoded


def target_from_session(session_id: str) -> str:
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("KK9 目标会话 ID 不能为空")
    if not session_id.startswith(_GROUP_SESSION_PREFIX):
        return session_id
    encoded = session_id[len(_GROUP_SESSION_PREFIX) :]
    try:
        decoded = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
        value = json.loads(decoded)
        if not (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, str) and item for item in value)
        ):
            raise ValueError
        return value[0]
    except (ValueError, UnicodeError, TypeError) as exc:
        raise ValueError("无效的 Kairo 群成员会话 ID") from exc


def convert_message(
    data: dict,
    *,
    self_id: str,
    isolate_group_users: bool,
    get_file_path: Callable[[str], Path],
) -> AstrBotMessage | None:
    """只接收身份明确的员工消息，文件只使用已上传的服务端路径。"""
    if (
        data.get("direction") != "inbound"
        or data.get("isMe")
        or data.get("isRecalled")
        or data.get("origin") in {"system", "bot_echo", "operator"}
        or data.get("messageType") == "system"
    ):
        return None

    session_id = str(data.get("sessionId") or "")
    sender_id = str(data.get("senderId") or "")
    message_id = str(data.get("messageId") or data.get("id") or "")
    session_type = data.get("sessionType")
    if (
        not session_id
        or not sender_id
        or sender_id == self_id
        or not message_id
        or session_type not in {"private", "group"}
    ):
        return None

    is_group = session_type == "group"
    if not is_group and (session_id in {f"0-{self_id}", self_id} or not session_id):
        session_id = f"0-{sender_id}"
        data["sessionId"] = session_id

    message = AstrBotMessage()
    message.type = MessageType.GROUP_MESSAGE if is_group else MessageType.FRIEND_MESSAGE
    message.self_id = self_id
    message.sender = MessageMember(sender_id, str(data.get("sender") or sender_id))
    message.session_id = (
        encode_group_session(session_id, sender_id)
        if is_group and isolate_group_users
        else session_id
    )
    if is_group:
        message.group = Group(session_id, str(data.get("sessionName") or session_id))
    message.message_id = message_id
    message.raw_message = data
    timestamp = data.get("timestamp")
    if isinstance(timestamp, (float, int)) and timestamp > 0:
        message.timestamp = int(timestamp / 1000 if timestamp > 10**11 else timestamp)
    else:
        message.timestamp = int(time.time())

    components = []
    reply = data.get("replyTo")
    if isinstance(reply, dict) and reply.get("replyToId"):
        reply_text = str(reply.get("replyToContent") or "")
        components.append(
            Reply(
                id=str(reply["replyToId"]),
                sender_nickname=str(reply.get("replyToSender") or ""),
                message_str=reply_text,
                chain=[Plain(reply_text)] if reply_text else [],
            )
        )

    if is_group:
        mention_info = data.get("mentions") or {}
        mentioned = mention_info.get("mentionedUsers", [])
        ids = list(dict.fromkeys(str(uid) for uid in mentioned if uid))
        if (data.get("atMe") or mention_info.get("isAtMe")) and self_id not in ids:
            ids.append(self_id)
        components.extend(At(qq=uid) for uid in ids if uid != "all")
        if data.get("atAll") or mention_info.get("isAtAll") or "all" in ids:
            components.append(AtAll())

    content = str(data.get("content") or "")
    if content:
        components.append(Plain(content))
    text_parts = [content] if content else []

    def attachment_path(info: dict) -> Path | None:
        file_id = info.get("file_id")
        if not isinstance(file_id, str):
            return None
        try:
            return get_file_path(file_id)
        except Exception:
            # 已清理或传输失败的附件不能伪装为可读取的图片/文件。
            return None

    images = data.get("images") or []
    for info in images:
        path = attachment_path(info)
        if path is not None:
            components.append(Image.fromFileSystem(str(path)))
            text_parts.append("[图片]")
        else:
            notice = "[图片内容尚未取得，请在 KK9 中下载后重新发送]"
            components.append(Plain(notice))
            text_parts.append(notice)

    file_info = data.get("fileInfo")
    if isinstance(file_info, dict):
        name = str(file_info.get("fileName") or file_info.get("name") or "附件")
        path = attachment_path(file_info)
        if path is not None:
            components.append(File(name=name, file=str(path)))
            text_parts.append(f"[文件：{name}]")
        else:
            notice = f"[文件“{name}”的内容尚未取得，请在 KK9 中下载后重新发送]"
            components.append(Plain(notice))
            text_parts.append(notice)

    if data.get("messageType") == "image" and not images:
        notice = "[图片内容尚未取得，请在 KK9 中下载后重新发送]"
        components.append(Plain(notice))
        text_parts.append(notice)
    elif data.get("messageType") == "file" and not file_info:
        notice = "[文件内容尚未取得，请在 KK9 中下载后重新发送]"
        components.append(Plain(notice))
        text_parts.append(notice)
    elif data.get("messageType") == "voice":
        notice = "[收到语音，当前 Kairo 接入尚不支持读取音频，请发送文字]"
        components.append(Plain(notice))
        text_parts.append(notice)

    if not components:
        return None
    message.message = components
    message.message_str = "\n".join(text_parts).strip()
    return message
