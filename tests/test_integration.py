"""Real AstrBot, Python HTTP/WS and Node bridge; only KK9 itself uses the upstream Fake."""

import asyncio
import base64
import contextlib
import io
import json
import shutil
import uuid
import wave
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from astrbot.api.event import MessageChain
from astrbot.api.message_components import At, File, Image, Json, Plain, Record, Reply
from astrbot.api.platform import MessageType
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.utils.metrics import Metric
from astrbot_plugin_kairo.adapter import KairoPlatformAdapter
from astrbot_plugin_kairo.transport import BridgeError

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "integration-token-not-a-secret-123456789"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII="
)
SESSIONS = [
    {
        "id": "716791",
        "name": "员工甲",
        "type": "private",
        "nativeType": 0,
        "receiverId": "42",
        "unread": False,
    },
    {
        "id": "716792",
        "name": "员工乙",
        "type": "private",
        "nativeType": 0,
        "receiverId": "43",
        "unread": False,
    },
    {
        "id": "793803",
        "name": "测试群",
        "type": "group",
        "nativeType": 1,
        "receiverId": "200",
        "unread": False,
    },
    {
        "id": "793804",
        "name": "另一个群",
        "type": "group",
        "nativeType": 1,
        "receiverId": "201",
        "unread": False,
    },
]
EMPLOYEES = [
    {
        "id": "42",
        "loginName": "E042",
        "name": "员工甲",
        "updatedAt": 0,
        "raw": {"id": "42", "login_name": "E042"},
    },
    {
        "id": "43",
        "loginName": "E043",
        "name": "员工乙",
        "updatedAt": 0,
        "raw": {"id": "43", "login_name": "E043"},
    },
    {
        "id": "44",
        "loginName": "E044",
        "name": "未联系员工",
        "updatedAt": 0,
        "raw": {"id": "44", "login_name": "E044"},
    },
]


def incoming(message_id="800", **changes):
    return {
        "id": message_id,
        "messageId": message_id,
        "msgIdx": 1,
        "sessionId": "793803",
        "sessionName": "测试群",
        "sessionType": "group",
        "senderId": "42",
        "sender": "员工甲",
        "content": "你好",
        "direction": "inbound",
        "timestamp": 1700000000000,
        **changes,
    }


async def wait_for(predicate, timeout=10):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.02)


@pytest_asyncio.fixture
async def connection(tmp_path, monkeypatch, request):
    if not (ROOT / "bridge/node_modules/tsx/dist/cli.mjs").is_file() or not shutil.which("node"):
        pytest.fail("先准备 bridge 依赖，才能运行完整跨语言联调")
    monkeypatch.setattr(
        "astrbot_plugin_kairo.adapter.StarTools.get_data_dir", lambda _: tmp_path / "astrbot"
    )
    monkeypatch.setattr(Metric, "upload", AsyncMock())
    platform_config = {
        "id": "kairo-test",
        "token": TOKEN,
        "bot_uid": "100",
        **getattr(request, "param", {}),
    }
    adapter = KairoPlatformAdapter(platform_config, {}, asyncio.Queue())
    await adapter.server.start("127.0.0.1", 0)
    cache = tmp_path / "kk9-cache"
    cache.mkdir()
    config = {
        "serverUrl": f"http://127.0.0.1:{adapter.server.bound_port}",
        "token": TOKEN,
        "expectedUserId": "100",
        "attachmentRoots": [str(cache)],
        "dataDir": str(tmp_path / "bridge"),
        "reconnectDelayMs": 100,
    }
    process = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        (ROOT / "bridge/node_modules/tsx/dist/loader.mjs").as_uri(),
        str(ROOT / "tests/node_fixture.mts"),
        json.dumps(config),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    diagnostics = []

    async def read_stderr():
        async for line in process.stderr:
            diagnostics.append(line.decode())

    stderr_task = asyncio.create_task(read_stderr())

    async def command(cmd, **values):
        request_id = uuid.uuid4().hex
        process.stdin.write((json.dumps({"id": request_id, "cmd": cmd, **values}) + "\n").encode())
        await process.stdin.drain()
        line = await asyncio.wait_for(process.stdout.readline(), 10)
        assert line, "".join(diagnostics)
        result = json.loads(line)
        assert result["id"] == request_id
        return result["result"]

    try:
        try:
            await wait_for(lambda: adapter.server.connected)
        except TimeoutError:
            pytest.fail("Node 桥接未连接：" + "".join(diagnostics))
        await command("sessions", sessions=SESSIONS)
        await command("employees", employees=EMPLOYEES)
        yield adapter, command, cache, platform_config
    finally:
        if process.returncode is None:
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                await command("stop")
            try:
                await asyncio.wait_for(process.wait(), 10)
            except TimeoutError:
                process.kill()
                await process.wait()
        await stderr_task
        await adapter.server.close()
        assert process.returncode == 0, "".join(diagnostics)


async def receive(adapter):
    return await asyncio.wait_for(adapter._event_queue.get(), 10)


async def test_real_bridge_roundtrip_media_and_saved_group_route(connection):
    adapter, command, cache, _ = connection
    image_path = cache / "收到的图片.png"
    image_path.write_bytes(PNG)
    document = cache / "收到的文件.txt"
    document.write_text("从 KK9 上传的内容", encoding="utf-8")
    original = incoming(
        content="帮我看附件",
        mentions={"isAtMe": True, "isAtAll": False, "mentionedUsers": ["100"]},
        images=[{"filePath": str(image_path)}],
        fileInfo={"fileName": "收到的文件.txt", "filePath": str(document)},
    )
    await command("emit", message=original)
    event = await receive(adapter)
    assert event.get_sender_id() == "42"
    assert event.get_group_id() == "793803"
    assert any(isinstance(part, At) and str(part.qq) == "100" for part in event.get_messages())
    image = next(part for part in event.get_messages() if isinstance(part, Image))
    attachment = next(part for part in event.get_messages() if isinstance(part, File))
    assert Path(await image.convert_to_file_path()).read_bytes() == PNG
    assert Path(await attachment.get_file()).read_text(encoding="utf-8") == "从 KK9 上传的内容"

    await command("emit", message=original)
    await command("emit", message=incoming("801", direction="outbound", isMe=True))
    await command("emit", message=incoming("802", content="顺序屏障"))
    assert (await receive(adapter)).message_obj.message_id == "802"
    assert adapter._event_queue.empty()

    await event.send(
        MessageChain([Reply(id="800"), At(qq="42", name="员工"), Plain("完整"), Plain("回复")])
    )
    calls = await command("calls")
    assert [(call["type"], call["payload"]) for call in calls] == [("reply", "完整回复")]
    assert calls[0]["options"]["targetSessionId"] == "793803"
    assert calls[0]["options"]["replyTo"] == "800"
    assert calls[0]["options"]["mentions"] == [{"uid": "42", "name": "员工"}]

    await event.send(
        MessageChain(
            [
                Plain("图前"),
                Image.fromFileSystem(str(image_path)),
                File(name="生成的文件.txt", file=str(document)),
                Plain("文件后"),
            ]
        )
    )
    calls = await command("calls")
    assert [call["type"] for call in calls] == ["reply", "text", "image", "file", "text"]
    assert calls[1]["payload"] == "图前" and calls[4]["payload"] == "文件后"
    assert base64.b64decode(calls[2]["bytes_base64"]) == PNG
    assert base64.b64decode(calls[3]["bytes_base64"]).decode() == "从 KK9 上传的内容"
    await adapter.send_by_session(
        MessageSession.from_str(event.unified_msg_origin), MessageChain([Plain("主动通知")])
    )
    assert (await command("calls"))[-1]["options"]["targetSessionId"] == "793803"


@pytest.mark.parametrize(
    "connection",
    [
        {
            "user_blacklist": ["E043"],
            "enable_user_whitelist": True,
            "user_whitelist": ["E042", "E043", "E044"],
            "group_blacklist": ["793804"],
            "enable_group_whitelist": True,
            "group_whitelist": ["793803", "793804"],
        }
    ],
    indirect=True,
)
async def test_shared_lists_guard_inbound_reply_saved_route_and_notifications(connection):
    adapter, command, _, config = connection
    await command("emit", message=incoming("810", senderId="43"))
    await command("emit", message=incoming("811", sessionId="793804"))
    await command("emit", message=incoming("812"))
    event = await receive(adapter)
    assert event.message_obj.message_id == "812"
    assert adapter._event_queue.empty()
    assert await command("calls") == []

    blocked_private = MessageSession("kairo-test", MessageType.FRIEND_MESSAGE, "716792")
    with pytest.raises(BridgeError) as error:
        await adapter.send_by_session(blocked_private, MessageChain([Plain("禁止主动通知")]))
    assert error.value.code == "ACCESS_DENIED"
    # An invented MessageSession type cannot disguise a blocked native group.
    with pytest.raises(BridgeError):
        await adapter.send_by_session(
            MessageSession("kairo-test", MessageType.FRIEND_MESSAGE, "793804"),
            MessageChain([Plain("禁止群通知")]),
        )
    with pytest.raises(BridgeError):
        await adapter.get_client().notify_employee("E043", "管理员也不能绕过")
    config["user_blacklist"].append("E042")
    for send in (
        lambda: event.send(MessageChain([Plain("触发后被拉黑")])),
        lambda: adapter.send_by_session(
            MessageSession.from_str(event.unified_msg_origin),
            MessageChain([Plain("持久目标也重检")]),
        ),
    ):
        with pytest.raises(BridgeError) as error:
            await send()
        assert error.value.code == "ACCESS_DENIED"
    assert await command("calls") == []
    # A permitted group broadcast is not hidden from individual blocked members.
    await adapter.get_client().send_chain("793803", MessageChain([Plain("已许可群广播")]))
    assert (await command("calls"))[0]["options"]["targetSessionId"] == "793803"


@pytest.mark.parametrize("connection", [{"enable_user_whitelist": True}], indirect=True)
async def test_enabled_empty_employee_list_blocks_existing_and_first_private_sends(connection):
    adapter, command, _, _ = connection
    with pytest.raises(BridgeError) as error:
        await adapter.get_client().notify_employee("E044", "不应发出")
    assert error.value.code == "ACCESS_DENIED"
    with pytest.raises(BridgeError):
        await adapter.get_client().send_chain("716791", MessageChain([Plain("不应发出")]))
    assert await command("calls") == []


@pytest.mark.parametrize("native_id", ["716791", "793803"])
async def test_voice_file_transfer_uses_actual_wav_in_both_session_types(connection, native_id):
    adapter, command, cache, _ = connection
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00\x01\x00" * 800)
    data = buffer.getvalue()
    path = cache / "语音.wav"
    path.write_bytes(data)
    await adapter.get_client().send_chain(
        native_id,
        MessageChain([Plain("语音前"), Record.fromFileSystem(str(path)), Plain("语音后")]),
    )
    calls = await command("calls")
    assert [call["type"] for call in calls] == ["text", "voice", "text"]
    assert base64.b64decode(calls[1]["bytes_base64"]) == data
    assert all(call["options"]["targetSessionId"] == native_id for call in calls)
    assert Path(calls[1]["payload"]["filePath"]) != path


@pytest.mark.parametrize("native_id", ["716791", "793803"])
@pytest.mark.parametrize(
    "payload,call_type",
    [
        ({"type": "kairo.app", "title": "通知", "content": "<p>正文</p>"}, "appMessage"),
        (
            {
                "type": "kairo.url",
                "title": "链接",
                "summary": "摘要",
                "linkUrl": "https://example.com/",
            },
            "urlCard",
        ),
        (
            {
                "type": "kairo.biz",
                "title": "任务",
                "content": "正文",
                "bizType": 1,
                "bizUrl": "/task/42",
            },
            "bizMessage",
        ),
    ],
)
async def test_cards_use_exact_native_payload_and_target(connection, native_id, payload, call_type):
    adapter, command, _, _ = connection
    await adapter.get_client().send_chain(native_id, MessageChain([Json(payload)]))
    calls = await command("calls")
    assert len(calls) == 1
    assert calls[0]["type"] == call_type
    assert calls[0]["payload"] == {key: value for key, value in payload.items() if key != "type"}
    assert calls[0]["options"]["targetSessionId"] == native_id


@pytest.mark.parametrize("connection", [{"reply_format": "card"}], indirect=True)
async def test_regular_event_reply_can_use_native_card(connection):
    adapter, command, _, _ = connection
    await command("emit", message=incoming("820", sessionId="716791", sessionType="private"))
    event = await receive(adapter)
    await event.send(MessageChain([Plain("<b>不是HTML</b>\n第二行")]))
    calls = await command("calls")
    assert calls[0]["type"] == "appMessage"
    assert calls[0]["payload"]["content"] == "&lt;b&gt;不是HTML&lt;/b&gt;<br>第二行"
    assert calls[0]["options"]["targetSessionId"] == "716791"


async def test_first_employee_notification_returns_native_route_and_never_replays_intent(
    connection,
):
    adapter, command, _, config = connection
    client = adapter.get_client()
    assert not any(item["receiverId"] == "44" for item in await client.get_sessions())
    result = await client.notify_employee(" E044 ", "首次通知", operation_id="notify-44")
    assert result["status"] == "sent" and result["messageId"]
    assert result["sessionId"].isdigit() and int(result["sessionId"]) > 0
    repeated = await client.notify_employee("E044", "首次通知", operation_id="notify-44")
    assert repeated == result
    assert (await client.get_send_status("notify-44"))["messageId"] == result["messageId"]
    assert len(await command("calls")) == 1
    with pytest.raises(BridgeError, match="fingerprint"):
        await client.notify_employee("E042", "首次通知", operation_id="notify-44")
    await client.send_chain(result["sessionId"], MessageChain([Plain("已有正式会话后续消息")]))
    calls = await command("calls")
    assert [call["type"] for call in calls] == ["textToUser", "text"]
    assert calls[0]["targetLoginName"] == "E044"
    assert calls[1]["options"]["targetSessionId"] == result["sessionId"]
    missing = await client.notify_employee("e044", "大小写不匹配", operation_id="wrong-case")
    assert missing["status"] == "failed" and "e044" in missing["error"]
    config["user_blacklist"] = ["E044"]
    with pytest.raises(BridgeError):
        await client.notify_employee("E044", "名单即时重检", operation_id="blocked-44")
    assert len(await command("calls")) == 2


async def test_unknown_send_remains_once_and_survives_driver_recreation(connection):
    adapter, command, _, _ = connection
    await command("behavior", behavior={"mode": "post_trigger_timeout"})
    with pytest.raises(BridgeError) as error:
        await adapter.get_client().send_chain("716791", MessageChain([Plain("可能已经发出")]))
    assert error.value.code == "SEND_UNKNOWN"
    operation_id = error.value.result["operationId"]
    assert (await adapter.get_client().get_send_status(operation_id))["status"] == "unknown"
    assert len(await command("calls")) == 1
    await command("health")
    async with asyncio.timeout(10):
        while await command("generations") < 2 or not adapter.server.connected:
            await asyncio.sleep(0.02)
    assert (await adapter.get_client().get_send_status(operation_id))["status"] == "unknown"
    await adapter.get_client().send_chain("716791", MessageChain([Plain("恢复后的新消息")]))
    calls = await command("calls")
    assert len(calls) == 2 and calls[1]["payload"] == "恢复后的新消息"


@pytest.mark.parametrize("connection", [{"user_blacklist": ["E043"]}], indirect=True)
async def test_missing_or_fallback_identity_is_rejected_without_disconnect_replay(connection):
    adapter, command, _, _ = connection
    await command(
        "employees",
        employees=[
            EMPLOYEES[0],
            {
                "id": "43",
                "loginName": "43",
                "name": "缺少原生工号",
                "updatedAt": 0,
                "raw": {"id": "43"},
            },
        ],
    )
    await command("emit", message=incoming("901", senderId="43"))
    await command("emit", message=incoming("902", senderId="45"))
    await command("emit", message=incoming("903"))
    assert (await receive(adapter)).message_obj.message_id == "903"
    assert adapter._event_queue.empty()
    assert adapter.server.connected and await command("generations") == 1
    with pytest.raises(BridgeError) as error:
        await adapter.get_client().send_chain(
            "716792", MessageChain([Plain("不能使用 UID 代替工号")])
        )
    assert error.value.code == "IDENTITY_UNAVAILABLE"
    assert await command("calls") == []


@pytest.mark.parametrize(
    "connection", [{"enable_user_whitelist": True, "user_whitelist": ["43"]}], indirect=True
)
async def test_confirmed_numeric_login_name_remains_a_valid_employee_identity(connection):
    adapter, command, _, _ = connection
    await command(
        "employees",
        employees=[
            {
                "id": "43",
                "loginName": "43",
                "name": "数字工号",
                "updatedAt": 0,
                "raw": {"id": "43", "login_name": "43"},
            }
        ],
    )
    await command("emit", message=incoming("904", senderId="43"))
    event = await receive(adapter)
    await event.send(MessageChain([Plain("数字工号可以回复")]))
    assert (await command("calls"))[0]["payload"] == "数字工号可以回复"


@pytest.mark.parametrize(
    "card",
    [
        {
            "type": "kairo.biz",
            "title": "任务",
            "content": "正文",
            "bizType": 1,
            "bizUrl": "/task",
            "summary": "不是数组",
        },
        {"type": "kairo.app", "title": "通知", "content": "正文", "linkUrl": ""},
        {
            "type": "kairo.url",
            "title": "链接",
            "summary": "摘要",
            "linkUrl": "https://example.com",
            "unexpected": True,
        },
        {"type": "kairo.app", "title": "通知", "content": "😀" * 64_001},
    ],
)
async def test_entire_card_is_validated_before_preceding_text_is_submitted(connection, card):
    adapter, command, _, _ = connection
    with pytest.raises(BridgeError) as error:
        await adapter.get_client().send_chain(
            "716791", MessageChain([Plain("不能先发半条"), Json(card)])
        )
    assert error.value.code == "INVALID_CARD"
    assert await command("calls") == []
