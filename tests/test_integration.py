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
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from astrbot.api.event import MessageChain
from astrbot.api.message_components import At, File, Image, Json, Plain, Record, Reply
from astrbot.api.platform import MessageType
from astrbot.api.star import Context
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.astr_agent_context import AstrAgentContext
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.provider.func_tool_manager import FunctionToolManager
from astrbot.core.utils.metrics import Metric
from astrbot_plugin_kairo.adapter import KairoPlatformAdapter
from astrbot_plugin_kairo.main import KairoPlugin
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
    remote_image = r"R:\KK9\收到的图片.png"
    remote_file = r"R:\KK9\收到的文件.txt"
    await command(
        "cached_file", file_path=remote_image, bytes_base64=base64.b64encode(PNG).decode()
    )
    await command(
        "cached_file",
        file_path=remote_file,
        bytes_base64=base64.b64encode(document.read_bytes()).decode(),
    )
    original = incoming(
        content="帮我看附件",
        mentions={"isAtMe": True, "isAtAll": False, "mentionedUsers": ["100"]},
        images=[{"originalFilePath": remote_image, "filePath": r"R:\KK9\缩略图.png"}],
        fileInfo={"fileName": "收到的文件.txt", "filePath": remote_file},
    )
    await command("emit", message=original)
    event = await receive(adapter)
    assert event.get_sender_id() == "42"
    assert event.get_group_id() == "793803"
    assert any(isinstance(part, At) and str(part.qq) == "100" for part in event.get_messages())
    image = next((part for part in event.get_messages() if isinstance(part, Image)), None)
    assert image is not None, event.message_obj.raw_message
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
async def test_text_voice_preserves_intent_and_native_target(connection, native_id):
    adapter, command, _, _ = connection
    client = adapter.get_client()
    result = await client.send_voice_text(
        native_id, "直接由 Driver 朗读", operation_id="text-voice"
    )
    assert result["status"] == "sent" and result["messageId"]
    assert result["operationId"] == "text-voice"
    assert (
        await client.send_voice_text(native_id, "直接由 Driver 朗读", operation_id="text-voice")
        == result
    )
    calls = await command("calls")
    assert len(calls) == 1
    assert calls[0]["type"] == "voice"
    assert calls[0]["payload"] == {"text": "直接由 Driver 朗读"}
    assert calls[0]["options"]["targetSessionId"] == native_id
    with pytest.raises(BridgeError, match="fingerprint"):
        await client.send_voice_text(native_id, "不同的正文", operation_id="text-voice")
    assert await client.get_send_status("text-voice") == result
    assert len(await command("calls")) == 1


async def test_text_voice_unknown_survives_recreation_without_resubmission(connection):
    adapter, command, _, _ = connection
    client = adapter.get_client()
    await command("behavior", behavior={"mode": "post_trigger_timeout"})
    result = await client.send_voice_text("716791", "可能已发出", operation_id="voice-unknown")
    assert result["status"] == "unknown"
    assert result["operationId"] == "voice-unknown"
    await command("health")
    async with asyncio.timeout(10):
        while await command("generations") < 2 or not adapter.server.connected:
            await asyncio.sleep(0.02)
    assert (
        await client.send_voice_text("716791", "可能已发出", operation_id="voice-unknown") == result
    )
    assert await client.get_send_status("voice-unknown") == result
    assert len(await command("calls")) == 1
    next_result = await client.send_voice_text("716791", "恢复后的新语音")
    assert next_result["status"] == "sent"
    assert (await command("calls"))[-1]["payload"] == {"text": "恢复后的新语音"}
    assert len(await command("calls")) == 2


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


async def test_uri_only_image_uses_driver_resource_not_bridge_local_cache(connection):
    adapter, command, cache, _ = connection
    (cache / "resource.png").write_bytes(b"wrong-local-image")
    await command(
        "image_resource",
        uri="groupc7/M00/7B/6A/resource",
        bytes_base64=base64.b64encode(PNG).decode(),
    )
    await command(
        "emit",
        message=incoming(
            "uri-cached-image",
            sessionId="716791",
            sessionType="private",
            content="这张图片内容是什么",
            images=[{"uri": "groupc7/M00/7B/6A/resource", "mimeType": "image/png"}],
        ),
    )
    event = await asyncio.wait_for(adapter._event_queue.get(), 10)
    image = next(component for component in event.get_messages() if isinstance(component, Image))
    assert Path(await image.convert_to_file_path()).read_bytes() == PNG


@pytest.mark.parametrize("stale_path", [False, True])
async def test_native_original_download_reaches_astrbot_not_thumbnail(connection, stale_path):
    adapter, command, cache, _ = connection
    thumbnail = cache / "thumbnail.png"
    thumbnail.write_bytes(b"thumbnail-not-the-original")
    await command(
        "image_resource", uri="server/original", bytes_base64=base64.b64encode(PNG).decode()
    )
    image_info = {
        "filePath": str(thumbnail),
        "uri": "server/thumbnail",
        "originalUri": "server/original",
        "mimeType": "image/png",
    }
    if stale_path:
        image_info["originalFilePath"] = str(cache / "expired-original.png")
    await command(
        "emit",
        message=incoming("native-original", content="原图正文", images=[image_info]),
    )
    event = await receive(adapter)
    image = next(component for component in event.get_messages() if isinstance(component, Image))
    assert Path(await image.convert_to_file_path()).read_bytes() == PNG
    assert "原图正文" in event.message_obj.message_str
    cached = list((cache.parent / "bridge" / "attachments").glob("*/*"))
    assert len(cached) == 1
    assert cached[0].read_bytes() == PNG
    assert len(cached[0].parent.name) == 32
    assert await command("calls") == []


async def test_native_original_download_failure_keeps_text_without_thumbnail(connection):
    adapter, command, cache, _ = connection
    thumbnail = cache / "thumbnail.png"
    thumbnail.write_bytes(PNG)
    await command(
        "emit",
        message=incoming(
            "native-original-failure",
            content="下载失败也保留正文",
            images=[
                {
                    "filePath": str(thumbnail),
                    "uri": "server/thumbnail",
                    "originalUri": "server/not-injected",
                }
            ],
        ),
    )
    event = await receive(adapter)
    assert not any(isinstance(component, Image) for component in event.get_messages())
    assert "下载失败也保留正文" in event.message_obj.message_str
    assert "not-injected" in str(event.message_obj.raw_message)
    assert "attachment_error" in str(event.message_obj.raw_message)
    assert await command("calls") == []


async def test_uri_only_uncached_image_downloads_original_over_real_http(connection):
    adapter, command, _, _ = connection
    await command(
        "image_resource", uri="server/legacy", bytes_base64=base64.b64encode(PNG).decode()
    )
    await command(
        "emit",
        message=incoming("native-legacy-image", images=[{"uri": "server/legacy"}]),
    )
    event = await receive(adapter)
    image = next(component for component in event.get_messages() if isinstance(component, Image))
    assert Path(await image.convert_to_file_path()).read_bytes() == PNG
    assert await command("calls") == []


@pytest.fixture
def kairo_tools():
    context = Context.__new__(Context)
    context.platform_manager = SimpleNamespace(platform_insts=[])
    context.provider_manager = SimpleNamespace(llm_tools=FunctionToolManager())
    KairoPlugin(context)
    registered = {tool.name: tool for tool in context.provider_manager.llm_tools.func_list}

    def wrap(event):
        event.role = "admin"
        return ContextWrapper(AstrAgentContext(context=context, event=event))

    return registered, wrap


@pytest.fixture
def notification_tools(kairo_tools):
    registered, wrap = kairo_tools
    return registered["kairo_notify_employee"], registered["kairo_select_employee"], wrap


async def test_name_notification_requires_user_choice_and_binds_original_uid_and_body(
    connection, notification_tools
):
    adapter, command, _, _ = connection
    notify, select, wrap = notification_tools
    candidates = [
        {"id": "42", "name": "张三", "loginName": "E042", "departmentPaths": ["公司 / 研发"]},
        {
            "id": "44",
            "name": "张三",
            "loginName": "E044",
            "departmentPaths": ["公司 / 财务", "公司 / 项目组"],
        },
    ]
    await command("search_employees", employees=candidates)
    body = "通知正文  保留空格\n以及换行"
    await command("emit", message=incoming("name-request", content="给张三发一条通知"))
    request_event = await receive(adapter)
    listing = await notify.call(wrap(request_event), name="张三", text=body)
    assert "E042" in listing and "E044" in listing
    assert "公司 / 研发" in listing and "公司 / 财务" in listing and "公司 / 项目组" in listing
    assert await command("calls") == []

    # 模型不能在搜索的同一条用户消息中自行决定重名对象。
    await select.call(wrap(request_event), choice=2)
    await command("emit", message=incoming("other-actor-choice", senderId="43", content="2"))
    await select.call(wrap(await receive(adapter)), choice=2)
    assert await command("calls") == []

    # 搜索源排序变化不能改变已展示的序号到 UID 映射。
    await command("search_employees", employees=list(reversed(candidates)))
    await command("emit", message=incoming("name-choice", content="选第2个"))
    choice_event = await receive(adapter)
    choice_event.session_id = "rewritten-context"
    choice_event.unified_msg_origin = "other:GroupMessage:99999"
    result = await select.call(wrap(choice_event), choice=2)
    assert "sent" in result and "operationId=" in result
    assert await select.call(wrap(choice_event), choice=2) == result
    calls = await command("calls")
    assert [(call["type"], call["targetLoginName"], call["payload"]) for call in calls] == [
        ("textToUser", "E044", body)
    ]


async def test_name_notification_rechecks_policy_after_candidates_are_shown(
    connection, notification_tools
):
    adapter, command, _, config = connection
    notify, select, wrap = notification_tools
    # 单个模糊结果也不能自动发出。
    await command(
        "search_employees",
        employees=[
            {"id": "44", "name": "未联系员工", "loginName": "E044", "departmentPaths": None}
        ],
    )
    await command("emit", message=incoming("fuzzy-request", content="给未联系的人发通知"))
    listing = await notify.call(wrap(await receive(adapter)), name="未联系", text="不得发出")
    assert "E044" in listing
    assert await command("calls") == []
    config["user_blacklist"] = ["E044"]
    await command("emit", message=incoming("blocked-choice", content="选择1"))
    result = await select.call(wrap(await receive(adapter)), choice=1)
    assert "ACCESS_DENIED" in result
    assert await command("calls") == []


async def test_exact_name_unknown_result_never_replays_native_notification(
    connection, notification_tools
):
    adapter, command, _, _ = connection
    notify, _, wrap = notification_tools
    await command(
        "search_employees",
        employees=[
            {"id": "44", "name": "未联系员工", "loginName": "E044", "departmentPaths": None}
        ],
    )
    await command("behavior", behavior={"mode": "post_trigger_timeout"})
    await command("emit", message=incoming("exact-name-request", content="给未联系员工发通知"))
    event = await receive(adapter)
    first, duplicate = await asyncio.gather(
        notify.call(wrap(event), name="未联系员工", text="可能已经发送"),
        notify.call(wrap(event), name="未联系员工", text="可能已经发送"),
    )
    assert first == duplicate and "unknown" in first
    assert "operationId=" in first
    assert await notify.call(wrap(event), name="未联系员工", text="可能已经发送") == first
    calls = await command("calls")
    assert [(call["type"], call["targetLoginName"], call["payload"]) for call in calls] == [
        ("textToUser", "E044", "可能已经发送")
    ]


async def test_exact_name_notification_accepts_native_numeric_profile_uid(
    connection, notification_tools
):
    adapter, command, _, _ = connection
    notify, _, wrap = notification_tools
    await command(
        "employees",
        employees=[
            {
                "id": 7783,
                "name": "陈鹏",
                "loginName": "e07783",
                "updatedAt": 0,
                "raw": {"id": 7783, "login_name": "e07783"},
            }
        ],
    )
    await command(
        "search_employees",
        employees=[{"id": "7783", "name": "陈鹏", "loginName": "e07783", "departmentPaths": None}],
    )
    body = "明天上午九点开会。"
    await command(
        "emit", message=incoming("numeric-profile-request", content=f"给陈鹏发消息：{body}")
    )
    event = await receive(adapter)
    result = await notify.call(wrap(event), name="陈鹏", text=body)
    assert "sent" in result
    assert await notify.call(wrap(event), name="陈鹏", text=body) == result
    calls = await command("calls")
    assert [(call["type"], call["targetLoginName"], call["payload"]) for call in calls] == [
        ("textToUser", "e07783", body)
    ]


@pytest.mark.parametrize("first_contact", [False, True])
@pytest.mark.parametrize("ambiguous", [False, True])
@pytest.mark.parametrize(
    "tool_name,args,call_type,payload",
    [
        (
            "kairo_send_app_card",
            {"title": "公告", "text": "<正文>\n第二行"},
            "appMessage",
            {"title": "公告", "content": "&lt;正文&gt;<br>第二行"},
        ),
        (
            "kairo_send_url_card",
            {"title": "链接", "summary": "摘要", "linkUrl": "https://example.org"},
            "urlCard",
            {"title": "链接", "summary": "摘要", "linkUrl": "https://example.org"},
        ),
        (
            "kairo_send_biz_card",
            {
                "title": "任务",
                "text": "正文",
                "bizType": 1,
                "bizUrl": "/task/42",
                "summary": ["摘要"],
            },
            "bizMessage",
            {
                "title": "任务",
                "content": "正文",
                "bizType": 1,
                "bizUrl": "/task/42",
                "summary": ["摘要"],
            },
        ),
    ],
)
async def test_registered_cards_push_to_employee_private_chat_without_source_post(
    connection, kairo_tools, first_contact, ambiguous, tool_name, args, call_type, payload
):
    adapter, command, _, _ = connection
    registered, wrap = kairo_tools
    tool, select = registered[tool_name], registered["kairo_select_employee"]
    uid, login = ("44", "E044") if first_contact else ("43", "E043")
    recipient = {
        "id": uid,
        "name": "目标员工",
        "loginName": login,
        "departmentPaths": ["公司 / 研发"],
    }
    candidates = ([{**recipient, "id": "42", "loginName": "E042"}] if ambiguous else []) + [
        recipient
    ]
    await command("search_employees", employees=candidates)
    await command("emit", message=incoming("card-request", content="给目标员工推送卡片"))
    event = await receive(adapter)
    event.session_id = "rewritten-context"
    result = await tool.call(wrap(event), name="目标员工", **args)
    if ambiguous:
        assert "尚未发送" in result and await command("calls") == []
        assert "错误" in await select.call(wrap(event), choice=2)
        await command("emit", message=incoming("card-choice", content="选择第二个"))
        result = await select.call(wrap(await receive(adapter)), choice=2)
    else:
        assert await tool.call(wrap(event), name="目标员工", **args) == result
    assert "sent" in result and "sessionId=" in result
    calls = await command("calls")
    assert [(call["type"], call["targetLoginName"], call["payload"]) for call in calls] == [
        (call_type, login, payload)
    ]
    assert "targetSessionId" not in calls[0]["options"]
    sessions = await adapter.get_client().get_sessions()
    private = next(
        session
        for session in sessions
        if session["type"] == "private" and session["receiverId"] == uid
    )
    assert f"sessionId={private['id']}" in result
    assert private["id"] != event.target_session_id


@pytest.mark.parametrize("kind", ["image", "file"])
@pytest.mark.parametrize("first_contact", [False, True])
@pytest.mark.parametrize("ambiguous", [False, True])
async def test_registered_media_pushes_cached_bytes_to_selected_employee(
    connection, kairo_tools, kind, first_contact, ambiguous
):
    adapter, command, _, _ = connection
    registered, wrap = kairo_tools
    tool, select = registered[f"kairo_send_{kind}"], registered["kairo_select_employee"]
    uid, login = ("44", "E044") if first_contact else ("43", "E043")
    recipient = {"id": uid, "name": "目标员工", "loginName": login, "departmentPaths": None}
    candidates = ([{**recipient, "id": "42", "loginName": "E042"}] if ambiguous else []) + [
        recipient
    ]
    await command("search_employees", employees=candidates)
    body = PNG if kind == "image" else "完整原始报告\n第二行".encode()
    remote = r"R:\KK9\跨会话.png" if kind == "image" else r"R:\KK9\跨会话.txt"
    await command("cached_file", file_path=remote, bytes_base64=base64.b64encode(body).decode())
    fields = (
        {"images": [{"originalFilePath": remote}]}
        if kind == "image"
        else {"fileInfo": {"fileName": "原始报告.txt", "filePath": remote}, "messageType": "file"}
    )
    await command("emit", message=incoming("media-request", content="给目标员工发附件", **fields))
    event = await receive(adapter)
    result = await tool.call(wrap(event), name="目标员工")
    if ambiguous:
        assert "尚未发送" in result and await command("calls") == []
        # 删除入站缓存，证明选择使用发起时的快照，不依赖后续原文件。
        attachment = next(
            item
            for item in event.get_messages()
            if isinstance(item, Image if kind == "image" else File)
        )
        original = (
            await attachment.convert_to_file_path()
            if kind == "image"
            else await attachment.get_file()
        )
        Path(original).unlink()
        await command("emit", message=incoming("media-choice", content="选第2个"))
        choice = await receive(adapter)
        result = await select.call(wrap(choice), choice=2)
        assert await select.call(wrap(choice), choice=2) == result
    else:
        assert await tool.call(wrap(event), name="目标员工") == result
    assert "sent" in result
    calls = await command("calls")
    assert [
        (call["type"], call["targetLoginName"], base64.b64decode(call["bytes_base64"]))
        for call in calls
    ] == [(kind, login, body)]
    assert "targetSessionId" not in calls[0]["options"]
    if kind == "file":
        assert Path(calls[0]["payload"]).name == "原始报告.txt"
    sessions = await adapter.get_client().get_sessions()
    private = next(
        session
        for session in sessions
        if session["type"] == "private" and session["receiverId"] == uid
    )
    assert f"sessionId={private['id']}" in result
    assert private["id"] != event.target_session_id


async def test_group_members_tool_reads_full_original_group_without_sending(
    connection, kairo_tools
):
    adapter, command, _, _ = connection
    tools, wrap = kairo_tools
    members = [
        {
            "id": str(uid),
            "name": "同名员工" if uid <= 2 else f"员工{uid}",
            "loginName": f"{uid:06}",
            "departmentPaths": ["研发 / 后端", "项目"],
            "position": "工程师",
        }
        for uid in range(1, 202)
    ]
    members[2] = {
        "id": "3",
        "name": None,
        "loginName": None,
        "departmentPaths": None,
        "position": None,
    }
    await command("group_members", session_id="793803", members=[*members, members[0]])
    await command(
        "group_members",
        session_id="793804",
        members=[
            {
                "id": "999",
                "name": "别群员工",
                "loginName": None,
                "departmentPaths": None,
                "position": None,
            }
        ],
    )
    await command("emit", message=incoming("group-read", content="列出本群全员资料"))
    event = await receive(adapter)
    context = wrap(event)
    event.role = "member"
    # 宿主上下文可被隔离或改写，读取目标必须始终来自原消息的群会话。
    event.session_id = "another-conversation"
    event.message_obj.group_id = "793804"
    result = json.loads(await tools["kairo_get_group_members"].call(context))
    assert result == {"session_id": "793803", "total": 201, "members": members}
    assert await command("calls") == []
    assert not event._has_send_oper
    assert event.get_result() is None


async def test_group_members_unknown_native_session_preserves_error_not_empty_list(
    connection, kairo_tools
):
    adapter, command, _, _ = connection
    tools, wrap = kairo_tools
    await command("emit", message=incoming("missing-group-read"))
    event = await receive(adapter)
    await command("sessions", sessions=SESSIONS[:2])
    result = await tools["kairo_get_group_members"].call(wrap(event))
    assert "IPC_INVALID_RESPONSE" in result
    assert "793803" in result
    assert await command("calls") == []
    assert not event._has_send_oper


@pytest.mark.parametrize("first_contact", [False, True])
@pytest.mark.parametrize("ambiguous", [False, True])
async def test_directed_text_voice_crosses_real_bridge_without_posting_to_source_group(
    connection, kairo_tools, first_contact, ambiguous
):
    adapter, command, _, _ = connection
    registered, wrap = kairo_tools
    uid, login, name = ("44", "E044", "未联系员工") if first_contact else ("43", "E043", "员工乙")
    selected = {"id": uid, "name": name, "loginName": login, "departmentPaths": ["公司 / 财务"]}
    candidates = (
        [
            {"id": "42", "name": name, "loginName": "E042", "departmentPaths": ["公司 / 研发"]},
            selected,
        ]
        if ambiguous
        else [selected]
    )
    await command("search_employees", employees=candidates)
    await command("emit", message=incoming("voice-name-request", content=f"给{name}私聊发语音"))
    event = await receive(adapter)
    body = "  原始语音正文\n保留空格  "
    voice, choose = registered["kairo_send_voice"], registered["kairo_select_employee"]
    result = await voice.call(wrap(event), name=name, text=body)
    if ambiguous:
        assert login in result and "E042" in result
        assert await command("calls") == []
        assert "错误" in await choose.call(wrap(event), choice=2)
        await command("search_employees", employees=list(reversed(candidates)))
        await command("emit", message=incoming("voice-name-choice", content="选第2个"))
        selection = await receive(adapter)
        result = await choose.call(wrap(selection), choice=2)
        assert await choose.call(wrap(selection), choice=2) == result
    else:
        assert await voice.call(wrap(event), name=name, text="不得改变正文") == result
    assert "sent" in result and "operationId=" in result
    calls = await command("calls")
    assert len(calls) == 1
    assert calls[0]["type"] == "voice" and calls[0]["payload"] == {"text": body}
    assert calls[0]["options"]["targetLoginName"] == login
    assert "targetSessionId" not in calls[0]["options"]
    assert calls[0]["options"]["operationId"] in result
    private = next(
        item for item in await adapter.get_client().get_sessions() if item["receiverId"] == uid
    )
    assert private["type"] == "private" and private["id"] != event.target_session_id


async def test_directed_text_voice_unknown_reconciles_without_duplicate_native_send(
    connection, kairo_tools
):
    adapter, command, _, _ = connection
    registered, wrap = kairo_tools
    await command(
        "search_employees",
        employees=[
            {"id": "44", "name": "未联系员工", "loginName": "E044", "departmentPaths": None}
        ],
    )
    await command("behavior", behavior={"mode": "post_trigger_timeout"})
    await command("emit", message=incoming("voice-unknown-request", content="给未联系员工发语音"))
    event = await receive(adapter)
    voice = registered["kairo_send_voice"]
    first, duplicate = await asyncio.gather(
        voice.call(wrap(event), name="未联系员工", text="可能已经发送"),
        voice.call(wrap(event), name="未联系员工", text="可能已经发送"),
    )
    assert first == duplicate and "unknown" in first
    assert await voice.call(wrap(event), name="未联系员工", text="不应重发") == first
    calls = await command("calls")
    assert len(calls) == 1
    assert calls[0]["type"] == "voice"
    assert calls[0]["payload"] == {"text": "可能已经发送"}
    operation_id = calls[0]["options"]["operationId"]
    assert operation_id in first
    result = await adapter.get_client().get_send_status(operation_id)
    assert result["status"] == "unknown" and result["operationId"] == operation_id
    assert len(await command("calls")) == 1
