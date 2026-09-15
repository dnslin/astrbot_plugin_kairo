"""以真实 AstrBot SDK 加可控桥接端验证路由与发送行为。"""

import asyncio
from unittest.mock import AsyncMock

import pytest
from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.message_components import At, AtAll, File, Image, Plain, Reply
from astrbot.api.platform import MessageType, Platform
from astrbot.core.platform.message_session import MessageSession
from astrbot_plugin_kairo.adapter import KairoPlatformAdapter
from astrbot_plugin_kairo.mapping import encode_group_session
from astrbot_plugin_kairo.transport import BridgeError


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    monkeypatch.setattr("astrbot_plugin_kairo.adapter.StarTools.get_data_dir", lambda _: tmp_path)
    value = KairoPlatformAdapter(
        {"id": "kairo-test", "token": "x" * 32, "bot_uid": "bot"},
        {},
        asyncio.Queue(),
    )
    value.server.request = AsyncMock(return_value={"status": "delivered", "success": True})
    value.server.add_file = AsyncMock(
        return_value={"file_id": "a" * 32, "name": "sample.txt", "size": 3}
    )
    return value


def test_platform_explicitly_disables_streaming(adapter):
    assert adapter.meta().support_streaming_message is False


async def test_outbound_at_all_component(adapter):
    await adapter.send_chain("1-team", MessageChain([AtAll(), Plain("群通知")]))
    assert adapter.server.request.call_args.args[1]["mentions"] == [
        {"uid": "all", "name": "所有人"}
    ]


@pytest.mark.asyncio
async def test_complete_text_mentions_and_reply_are_one_send(adapter):
    await adapter.send_chain(
        "1-team",
        MessageChain(
            [Reply(id="original"), Plain("完整"), At(qq="employee", name="员工"), Plain("回复")]
        ),
    )
    adapter.server.request.assert_awaited_once()
    action, params = adapter.server.request.call_args.args
    assert action == "send"
    assert params["text"] == "完整回复"
    assert params["target_session_id"] == "1-team"
    assert params["reply_to"] == "original"
    assert params["mentions"] == [{"uid": "employee", "name": "员工"}]
    assert len(params["operation_id"]) == 32


@pytest.mark.asyncio
async def test_unknown_send_only_queries_same_operation_without_resending(adapter):
    adapter.server.request.side_effect = [{"status": "unknown"}, {"status": "unknown"}]
    with pytest.raises(BridgeError) as error:
        await adapter.send_chain("0-user", MessageChain([Plain("只有一次")]))
    assert error.value.code == "SEND_UNKNOWN"
    calls = adapter.server.request.call_args_list
    assert [call.args[0] for call in calls] == ["send", "get_send_status"]
    assert calls[0].args[1]["operation_id"] == calls[1].args[1]["operation_id"]


@pytest.mark.asyncio
async def test_timeout_is_reconciled_without_retry(adapter):
    adapter.server.request.side_effect = [
        BridgeError("TIMEOUT", "响应超时"),
        {"status": "delivered"},
    ]
    await adapter.send_chain("0-user", MessageChain([Plain("只提交一次")]))
    assert adapter.server.request.await_count == 2
    assert adapter.server.request.call_args_list[1].args[0] == "get_send_status"


@pytest.mark.asyncio
async def test_known_failure_does_not_query_or_retry(adapter):
    adapter.server.request.return_value = {"status": "failed", "error": "输入框已有内容"}
    with pytest.raises(BridgeError, match="输入框已有内容"):
        await adapter.send_chain("0-user", MessageChain([Plain("回复")]))
    adapter.server.request.assert_awaited_once()


@pytest.mark.asyncio
async def test_active_send_decodes_saved_session_without_event(adapter, monkeypatch):
    parent_send = AsyncMock()
    monkeypatch.setattr(Platform, "send_by_session", parent_send)
    session = MessageSession(
        "kairo-test", MessageType.GROUP_MESSAGE, encode_group_session("1-team", "employee")
    )
    await adapter.send_by_session(session, MessageChain([Plain("定时提醒")]))
    assert adapter.server.request.call_args.args[1]["target_session_id"] == "1-team"
    parent_send.assert_awaited_once()
    with pytest.raises(ValueError, match="平台实例"):
        await adapter.send_by_session(
            MessageSession("another-bot", MessageType.FRIEND_MESSAGE, "0-user"),
            MessageChain([Plain("不能串到另一个账号")]),
        )


@pytest.mark.asyncio
async def test_media_copied_to_bridge_in_chain_order(adapter, tmp_path):
    file_path = tmp_path / "sample.txt"
    file_path.write_text("abc")
    await adapter.send_chain(
        "0-user",
        MessageChain([Plain("前文"), File(name="sample.txt", file=str(file_path)), Plain("后文")]),
    )
    assert [call.args[1]["kind"] for call in adapter.server.request.call_args_list] == [
        "text",
        "file",
        "text",
    ]
    adapter.server.add_file.assert_awaited_once_with(file_path, name="sample.txt")
    assert "filePath" not in adapter.server.request.call_args_list[1].args[1]


@pytest.mark.asyncio
async def test_unsupported_component_fails_before_partial_send(adapter):
    with pytest.raises(BridgeError, match="暂不支持"):
        await adapter.send_chain("0-user", MessageChain([Plain("前文"), object()]))
    adapter.server.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_image_only_reply_is_explicitly_unsupported(adapter, tmp_path):
    with pytest.raises(BridgeError, match="不支持引用"):
        await adapter.send_chain(
            "0-user", MessageChain([Reply(id="original"), Image.fromFileSystem(tmp_path / "a.png")])
        )
    adapter.server.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_event_routes_by_raw_target_and_buffers_stream(adapter, monkeypatch):
    parent_send = AsyncMock()
    monkeypatch.setattr(AstrMessageEvent, "send", parent_send)
    await adapter.on_event(
        {
            "id": "native-1",
            "sessionId": "1-team",
            "sessionType": "group",
            "senderId": "employee",
            "content": "你好",
            "direction": "inbound",
        }
    )
    event = adapter._event_queue.get_nowait()
    assert event.session_id == encode_group_session("1-team", "employee")
    event.session_id = "rewritten-context"

    async def chunks():
        yield MessageChain([Plain("完整")])
        adapter.server.request.assert_not_awaited()
        yield MessageChain([Plain("回复")])
        adapter.server.request.assert_not_awaited()

    await event.send_streaming(chunks())
    adapter.server.request.assert_awaited_once()
    params = adapter.server.request.call_args.args[1]
    assert params["text"] == "完整回复"
    assert params["target_session_id"] == "1-team"
    parent_send.assert_awaited_once()


@pytest.mark.asyncio
async def test_event_not_marked_sent_on_failure(adapter, monkeypatch):
    parent_send = AsyncMock()
    monkeypatch.setattr(AstrMessageEvent, "send", parent_send)
    await adapter.on_event(
        {
            "id": "native-1",
            "sessionId": "0-user",
            "sessionType": "private",
            "senderId": "user",
            "content": "你好",
            "direction": "inbound",
        }
    )
    event = adapter._event_queue.get_nowait()
    adapter.server.request.return_value = {"status": "failed", "error": "发送失败"}
    with pytest.raises(BridgeError):
        await event.send(MessageChain([Plain("回复")]))
    parent_send.assert_not_awaited()
