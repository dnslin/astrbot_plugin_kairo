"""使用实际 AstrBot 消息组件验证平台转换，不替换 SDK。"""

from pathlib import Path

import pytest
from astrbot.api.message_components import At, AtAll, File, Image, Reply
from astrbot.api.platform import MessageType
from astrbot_plugin_kairo.mapping import (
    convert_message,
    encode_group_session,
    target_from_session,
)


def incoming(**changes):
    return {
        "id": "native-1",
        "messageId": "native-1",
        "sessionId": "0-employee",
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
    assert message.session_id == "0-employee"
    assert message.message_id == "native-1"
    assert message.sender.user_id == "employee"
    assert message.self_id == "bot"
    assert message.group is None
    assert message.timestamp == 1_789_430_400


def test_group_mentions_and_context_isolation():
    message = convert(
        incoming(
            sessionId="1-team",
            sessionType="group",
            mentions={"mentionedUsers": ["bot", "other", "bot"], "isAtMe": True},
            atAll=True,
        )
    )
    assert message.type == MessageType.GROUP_MESSAGE
    assert message.group.group_id == "1-team"
    assert target_from_session(message.session_id) == "1-team"
    assert message.session_id != encode_group_session("1-team", "other")
    assert [str(c.qq) for c in message.message if isinstance(c, At)] == ["bot", "other", "all"]
    assert any(isinstance(c, AtAll) for c in message.message)


def test_group_can_explicitly_share_context():
    message = convert_message(
        incoming(sessionId="1-team", sessionType="group"),
        self_id="bot",
        isolate_group_users=False,
        get_file_path=lambda _: Path("/cache"),
    )
    assert message.session_id == "1-team"


@pytest.mark.parametrize(
    "changes",
    [
        {"direction": "outbound"},
        {"direction": "unknown"},
        {"isRecalled": True},
        {"messageType": "system"},
        {"senderId": "bot"},
        {"isMe": True},
        {"origin": "operator"},
        {"senderId": ""},
        {"id": "", "messageId": ""},
        {"sessionId": ""},
    ],
)
def test_non_user_or_unroutable_messages_are_filtered(changes):
    assert convert(incoming(**changes)) is None


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
                "replyToSender": "员工乙",
                "replyToContent": "帮我看一下",
            },
        ),
        get_file_path=paths.__getitem__,
    )
    assert isinstance(message.message[0], Reply)
    assert message.message[0].id == "original"
    image = next(c for c in message.message if isinstance(c, Image))
    file = next(c for c in message.message if isinstance(c, File))
    assert image.file == image_path.as_uri()
    assert file.file_ == str(file_path)
    assert message.message_str == "[图片]\n[文件：报告.pdf]"


def test_uncached_or_expired_files_never_become_readable_components():
    def missing(_):
        raise FileNotFoundError

    message = convert(
        incoming(
            content="",
            images=[{"url": "https://internal/image.png"}, {"file_id": "expired"}],
            fileInfo={"filePath": r"C:\cache\a.pdf", "fileName": "a.pdf"},
        ),
        get_file_path=missing,
    )
    assert not any(isinstance(c, (Image, File)) for c in message.message)
    assert "内容尚未取得" in message.message_str


def test_private_message_session_id_pointing_to_self_is_corrected_to_sender():
    msg = convert_message(
        incoming(
            sessionId="0-5761",
            senderId="7783",
            sessionType="private",
            content="你好",
        ),
        self_id="5761",
        isolate_group_users=True,
        get_file_path=lambda file_id: Path("/cache") / file_id,
    )
    assert msg is not None
    assert msg.session_id == "0-7783"
    assert msg.raw_message["sessionId"] == "0-7783"


def test_group_session_round_trip_and_malformed_session():
    session = encode_group_session("1-team:会议_室", "user_name:%")
    assert target_from_session(session) == "1-team:会议_室"
    assert target_from_session("0-employee") == "0-employee"
    with pytest.raises(ValueError):
        target_from_session("kairo:g:not-a-valid-session!")


def test_empty_at_keeps_component_for_astrbot_waking():
    message = convert(incoming(content="", sessionType="group", atMe=True))
    assert any(isinstance(c, At) and c.qq == "bot" for c in message.message)


def test_voice_is_explicitly_described_as_unreadable():
    message = convert(incoming(content="", messageType="voice"))
    assert "尚不支持读取音频" in message.message_str
