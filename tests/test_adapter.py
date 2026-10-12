"""Behavior at the AstrBot boundary; real HTTP/WS roundtrips live in integration tests."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.message_components import At, AtAll, File, Image, Json, Plain, Reply
from astrbot.api.platform import MessageType
from astrbot.core.platform.message_session import MessageSession
from astrbot_plugin_kairo.adapter import KairoPlatformAdapter
from astrbot_plugin_kairo.mapping import encode_group_session
from astrbot_plugin_kairo.transport import BridgeError


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    monkeypatch.setattr("astrbot_plugin_kairo.adapter.StarTools.get_data_dir", lambda _: tmp_path)
    value = KairoPlatformAdapter(
        {"id": "kairo-test", "token": "x" * 32, "bot_uid": "100"}, {}, asyncio.Queue()
    )
    value.server.request = AsyncMock(return_value={"status": "sent", "messageId": "900"})
    value.server.add_file = AsyncMock(
        return_value={"file_id": "a" * 32, "name": "sample.txt", "size": 3}
    )
    return value


async def test_complete_text_mentions_and_reply_are_one_native_send(adapter):
    await adapter.send_chain(
        "793803",
        MessageChain([Reply(id="800"), Plain("完整"), At(qq="42", name="员工"), Plain("回复")]),
    )
    action, params = adapter.server.request.call_args.args
    assert action == "send"
    assert params["text"] == "完整回复"
    assert params["target_session_id"] == "793803"
    assert params["reply_to"] == "800"
    assert params["mentions"] == [{"uid": "42", "name": "员工"}]
    assert adapter.server.request.await_count == 1


async def test_outbound_at_all_is_explicit(adapter):
    await adapter.send_chain("793803", MessageChain([AtAll(), Plain("群通知")]))
    assert adapter.server.request.call_args.args[1]["mentions"] == [
        {"uid": "all", "name": "所有人"}
    ]


async def test_unknown_send_queries_original_intent_and_does_not_resend(adapter):
    adapter.server.request.side_effect = [{"status": "unknown"}, {"status": "unknown"}]
    with pytest.raises(BridgeError) as error:
        await adapter.send_chain("716791", MessageChain([Plain("只有一次")]))
    assert error.value.code == "SEND_UNKNOWN"
    calls = adapter.server.request.call_args_list
    assert [call.args[0] for call in calls] == ["send", "get_send_status"]
    assert calls[0].args[1]["operation_id"] == calls[1].args[1]["operation_id"]
    assert error.value.result["operationId"] == calls[0].args[1]["operation_id"]


async def test_timeout_is_reconciled_without_new_submission(adapter):
    adapter.server.request.side_effect = [
        BridgeError("TIMEOUT", "响应超时"),
        {"status": "sent", "messageId": "900"},
    ]
    await adapter.send_chain("716791", MessageChain([Plain("只提交一次")]))
    assert [call.args[0] for call in adapter.server.request.call_args_list] == [
        "send",
        "get_send_status",
    ]


async def test_disconnected_before_submission_is_not_an_unknown_send(adapter):
    adapter.server.request.side_effect = BridgeError("DISCONNECTED", "桥接未连接，发送未提交")
    with pytest.raises(BridgeError) as error:
        await adapter.send_chain("716791", MessageChain([Plain("未提交")]))
    assert error.value.code == "DISCONNECTED"
    assert adapter.server.request.await_count == 1


async def test_known_failure_preserves_native_diagnostics(adapter):
    outcome = {
        "status": "failed",
        "error": "业务拒绝",
        "nativeCode": 617,
        "receipt": {"code": 0, "businessCode": 617},
    }
    adapter.server.request.return_value = outcome
    with pytest.raises(BridgeError, match="业务拒绝") as error:
        await adapter.send_chain("716791", MessageChain([Plain("回复")]))
    assert error.value.result["nativeCode"] == 617
    assert error.value.result["receipt"] == outcome["receipt"]
    assert adapter.server.request.await_count == 1


async def test_active_send_restores_group_target_and_rejects_another_instance(adapter):
    await adapter.send_by_session(
        MessageSession(
            "kairo-test", MessageType.GROUP_MESSAGE, encode_group_session("793803", "42")
        ),
        MessageChain([Plain("定时提醒")]),
    )
    assert adapter.server.request.call_args.args[1]["target_session_id"] == "793803"
    with pytest.raises(ValueError, match="平台实例"):
        await adapter.send_by_session(
            MessageSession("another-bot", MessageType.FRIEND_MESSAGE, "716791"),
            MessageChain([Plain("不串号")]),
        )
    assert adapter.server.request.await_count == 1


async def test_text_on_both_sides_of_file_keeps_chain_order(adapter, tmp_path):
    path = tmp_path / "sample.txt"
    path.write_text("abc")
    await adapter.send_chain(
        "716791",
        MessageChain([Plain("前文"), File(name="sample.txt", file=str(path)), Plain("后文")]),
    )
    messages = [call.args[1] for call in adapter.server.request.call_args_list]
    assert [(m["kind"], m.get("text")) for m in messages] == [
        ("text", "前文"),
        ("file", None),
        ("text", "后文"),
    ]
    assert messages[1]["file_id"] == "a" * 32


async def test_unsupported_later_component_does_not_partially_send(adapter):
    with pytest.raises(BridgeError, match="暂不支持"):
        await adapter.send_chain("716791", MessageChain([Plain("前文"), object()]))
    adapter.server.request.assert_not_awaited()


async def test_media_reference_without_text_does_not_partially_send(adapter, tmp_path):
    with pytest.raises(BridgeError, match="不支持引用"):
        await adapter.send_chain(
            "716791", MessageChain([Reply(id="800"), Image.fromFileSystem(tmp_path / "a.png")])
        )
    adapter.server.request.assert_not_awaited()


async def test_invalid_later_card_does_not_send_earlier_text(adapter):
    with pytest.raises(BridgeError, match="bizType"):
        await adapter.send_chain(
            "793803",
            MessageChain(
                [
                    Plain("前文"),
                    Json(
                        {
                            "type": "kairo.biz",
                            "title": "任务",
                            "content": "内容",
                            "bizType": 3,
                            "bizUrl": "/task",
                        }
                    ),
                ]
            ),
        )
    adapter.server.request.assert_not_awaited()


async def test_auto_card_escapes_text_and_does_not_drop_media(adapter, tmp_path):
    adapter.get_client().reply_format = "card"
    path = tmp_path / "sample.txt"
    path.write_text("abc")
    await adapter.send_chain(
        "716791",
        MessageChain(
            [Plain("<script>\n第二行 &"), File(name="sample.txt", file=str(path)), Plain("后文")]
        ),
    )
    messages = [call.args[1] for call in adapter.server.request.call_args_list]
    assert [m["kind"] for m in messages] == ["app_card", "file", "app_card"]
    assert messages[0]["card"]["content"] == "&lt;script&gt;<br>第二行 &amp;"
    assert messages[2]["card"]["content"] == "后文"


async def make_event(adapter):
    await adapter.on_event(
        {
            "id": "800",
            "sessionId": "793803",
            "sessionType": "group",
            "senderId": "42",
            "content": "你好",
            "direction": "inbound",
        }
    )
    return adapter._event_queue.get_nowait()


async def test_stream_copies_mutable_deltas_and_keeps_original_reply_target(adapter):
    event = await make_event(adapter)
    event.session_id = "rewritten-context"
    shared = MessageChain([Plain("第一")])

    async def chunks():
        yield MessageChain([Plain("不应发送的思考")], type="reasoning")
        yield shared
        shared.chain[0].text = "第二"
        yield MessageChain(type="break")
        yield shared
        shared.chain.clear()
        adapter.server.request.assert_not_awaited()

    await event.send_streaming(chunks())
    assert adapter.server.request.await_count == 1
    params = adapter.server.request.call_args.args[1]
    assert params["text"] == "第一第二"
    assert params["target_session_id"] == "793803"
    assert event._has_send_oper


async def test_failed_stream_generator_does_not_send_partial_buffer(adapter):
    event = await make_event(adapter)

    async def chunks():
        yield MessageChain([Plain("不完整")])
        raise RuntimeError("生成失败")

    with pytest.raises(RuntimeError, match="生成失败"):
        await event.send_streaming(chunks())
    adapter.server.request.assert_not_awaited()
    assert not event._has_send_oper


async def test_failed_event_is_not_marked_as_sent(adapter, monkeypatch):
    parent_send = AsyncMock()
    monkeypatch.setattr(AstrMessageEvent, "send", parent_send)
    event = await make_event(adapter)
    adapter.server.request.return_value = {"status": "failed", "error": "发送失败"}
    with pytest.raises(BridgeError):
        await event.send(MessageChain([Plain("回复")]))
    parent_send.assert_not_awaited()
