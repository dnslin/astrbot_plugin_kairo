"""使用实际 AstrBot 消息组件验证平台转换，不替换 SDK。"""

from pathlib import Path

import pytest
from astrbot.api.message_components import At, AtAll, File, Image, Reply
from astrbot.api.platform import MessageType
from astrbot_plugin_kairo.mapping import (
    convert_message,
    decode_session,
    encode_group_session,
)
from astrbot_plugin_kairo.transport import BridgeError


def incoming(**changes):
    return {
        "id": "native-1",
        "messageId": "native-1",
        "sessionId": "12345",
        "sessionType": "private",
        "senderId": "employee",
        "sender": "员工甲",
        "content": "你好",
        "direction": "inbound",
        "timestamp": 1_789_430_400_000,
        **changes,
    }


def convert(data, get_file_path=lambda file_id: Path("/cache") / file_id):
    return convert_message(
        data,
        self_id="bot",
        isolate_group_users=True,
        get_file_path=get_file_path,
    )


def test_private_message_preserves_native_ids():
    message = convert(incoming())
    assert message.type == MessageType.FRIEND_MESSAGE
    assert message.session_id == "12345"
    assert decode_session(message.session_id) == ("12345", None)
    assert message.raw_message["sessionId"] == "12345"
    assert message.message_id == "native-1"
    assert message.sender.user_id == "employee"
    assert message.self_id == "bot"
    assert message.group is None
    assert message.timestamp == 1_789_430_400


def test_group_mentions_and_context_isolation():
    message = convert(
        incoming(
            sessionId="20001",
            sessionType="group",
            mentions={
                "mentionedUsers": ["bot", "other", "bot", "all", "-1", -1],
                "isAtMe": True,
            },
            atAll=True,
        )
    )
    assert message.type == MessageType.GROUP_MESSAGE
    assert message.group.group_id == "20001"
    assert decode_session(message.session_id) == ("20001", "employee")
    assert [str(c.qq) for c in message.message if type(c) is At] == ["bot", "other"]
    assert sum(isinstance(c, AtAll) for c in message.message) == 1


@pytest.mark.parametrize("all_uid", ["all", "-1", -1])
def test_all_mention_never_becomes_a_person_mention(all_uid):
    message = convert(incoming(sessionType="group", mentions={"mentionedUsers": [all_uid]}))
    assert sum(isinstance(c, AtAll) for c in message.message) == 1
    assert not any(type(c) is At for c in message.message)


def test_context_separates_both_groups_and_members():
    first = convert(incoming(sessionType="group", sessionId="20001"))
    second_group = convert(incoming(sessionType="group", sessionId="20002"))
    second_member = convert(incoming(sessionType="group", sessionId="20001", senderId="other"))
    assert len({first.session_id, second_group.session_id, second_member.session_id}) == 3
    assert decode_session(first.session_id) == ("20001", "employee")
    assert decode_session(second_group.session_id) == ("20002", "employee")
    assert decode_session(second_member.session_id) == ("20001", "other")


def test_group_can_explicitly_share_context():
    message = convert_message(
        incoming(sessionId="20001", sessionType="group"),
        self_id="bot",
        isolate_group_users=False,
        get_file_path=lambda _: Path("/cache"),
    )
    assert message.session_id == "20001"
    assert decode_session(message.session_id) == ("20001", None)


@pytest.mark.parametrize(
    "changes",
    [
        {"direction": "outbound"},
        {"direction": "unknown"},
        {"isRecalled": True},
        {"messageType": "system"},
        {"origin": "system"},
        {"senderId": "bot"},
        {"isMe": True},
        {"senderId": ""},
        {"id": "", "messageId": ""},
        {"sessionType": "service"},
    ],
)
def test_non_user_or_unroutable_messages_are_filtered(changes):
    assert convert(incoming(**changes)) is None


@pytest.mark.parametrize("session_id", ["", "0-5761", "1-team", "0", "-1", "01", "1.0", " 12 "])
def test_invalid_native_routes_are_diagnosed_without_mutating_input(session_id, caplog):
    data = incoming(sessionId=session_id, senderId="7783")
    assert convert(data) is None
    assert data["sessionId"] == session_id
    assert "原生会话 ID" in caplog.text
    assert repr(session_id) in caplog.text


def test_native_private_session_is_not_inferred_from_sender_or_self():
    message = convert_message(
        incoming(sessionId="5761", senderId="7783"),
        self_id="5761",
        isolate_group_users=True,
        get_file_path=lambda _: Path("/cache"),
    )
    assert message.session_id == "5761"
    assert message.raw_message["sessionId"] == "5761"


def test_real_uploaded_media_paths_and_reply(tmp_path):
    image_path = tmp_path / "image.png"
    image_path.write_bytes(b"sample")
    file_path = tmp_path / "document.pdf"
    file_path.write_bytes(b"document")
    paths = {"image": image_path, "file": file_path}
    message = convert(
        incoming(
            content="",
            images=[{"file_id": "image", "filePath": r"C:\secret.png"}],
            fileInfo={"file_id": "file", "fileName": "报告.pdf"},
            replyTo={
                "replyToId": "original",
                "replyToSenderId": "bot",
                "replyToSender": "机器人",
                "replyToMsgIdx": 42,
                "replyToContent": "帮我看一下",
            },
        ),
        get_file_path=paths.__getitem__,
    )
    reply = message.message[0]
    assert isinstance(reply, Reply)
    assert reply.id == "original"
    assert reply.sender_id == "bot"
    assert reply.sender_nickname == "机器人"
    assert reply.seq == 42
    assert reply.message_str == "帮我看一下"
    assert message.raw_message["replyTo"]["replyToMsgIdx"] == 42
    image = next(c for c in message.message if isinstance(c, Image))
    file = next(c for c in message.message if isinstance(c, File))
    assert image.file == image_path.as_uri()
    assert file.file_ == str(file_path)
    assert message.message_str == "[图片]\n[文件：报告.pdf]"


def test_reply_without_author_does_not_guess_from_nickname():
    message = convert(incoming(replyTo={"replyToId": "m", "replyToSender": "bot"}))
    reply = next(c for c in message.message if isinstance(c, Reply))
    assert reply.sender_id in (None, "")


def test_uncached_or_expired_files_show_actual_failure_reasons():
    def missing(_):
        raise BridgeError("FILE_UNAVAILABLE", "附件已过期")

    message = convert(
        incoming(
            content="",
            images=[
                {"url": "https://internal/image.png", "attachment_error": "尚未在 KK9 下载"},
                {"file_id": "expired"},
            ],
            fileInfo={"fileName": "a.pdf", "attachment_error": "文件超过 100 MiB"},
        ),
        get_file_path=missing,
    )
    assert not any(isinstance(c, (Image, File)) for c in message.message)
    assert "尚未在 KK9 下载" in message.message_str
    assert "附件已过期" in message.message_str
    assert "文件超过 100 MiB" in message.message_str


def test_file_system_attachment_errors_remain_visible():
    def missing(_):
        raise FileNotFoundError("缓存文件不存在")

    message = convert(incoming(images=[{"file_id": "expired"}]), get_file_path=missing)
    assert "缓存文件不存在" in message.message_str


def test_unexpected_attachment_resolver_errors_are_not_swallowed():
    def broken(_):
        raise RuntimeError("resolver bug")

    with pytest.raises(RuntimeError, match="resolver bug"):
        convert(incoming(images=[{"file_id": "image"}]), get_file_path=broken)


def test_group_session_round_trip_and_malformed_session():
    session = encode_group_session("20001", "user_name:%会议")
    assert decode_session(session) == ("20001", "user_name:%会议")
    assert decode_session("12345") == ("12345", None)
    for invalid in ("kairo:g:not-a-valid-session!", "0-employee", "kairo:g:WyIxLXRlYW0iLCJ1Il0"):
        with pytest.raises(ValueError):
            decode_session(invalid)


def test_empty_at_keeps_component_for_astrbot_waking():
    message = convert(incoming(content="", sessionType="group", atMe=True))
    assert any(isinstance(c, At) and c.qq == "bot" for c in message.message)


def test_voice_is_explicitly_described_as_unreadable():
    message = convert(incoming(content="", messageType="voice"))
    assert "尚不支持读取音频" in message.message_str
