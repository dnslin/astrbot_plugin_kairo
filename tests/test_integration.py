"""实际 AstrBot 类、Python 服务和 Node 桥接之间的联调；不连接真实 KK9。"""

import asyncio
import base64
import contextlib
import json
import shutil
import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from astrbot.api.event import MessageChain
from astrbot.api.message_components import At, File, Image, Plain, Reply
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.utils.metrics import Metric
from astrbot_plugin_kairo.adapter import KairoPlatformAdapter
from astrbot_plugin_kairo.transport import BridgeError

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "integration-token-not-a-secret-123456789"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII="
)


async def wait_for(predicate, timeout=8):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.02)


@pytest_asyncio.fixture
async def connection(tmp_path, monkeypatch):
    if not (ROOT / "bridge/node_modules/tsx/dist/cli.mjs").is_file() or not shutil.which("node"):
        pytest.skip("先准备 bridge 依赖，才能运行跨语言联调")
    monkeypatch.setattr(
        "astrbot_plugin_kairo.adapter.StarTools.get_data_dir", lambda _: tmp_path / "astrbot"
    )
    monkeypatch.setattr(Metric, "upload", AsyncMock())
    adapter = KairoPlatformAdapter(
        {"id": "kairo-test", "token": TOKEN, "bot_uid": "100"}, {}, asyncio.Queue()
    )
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
        str(ROOT / "bridge/node_modules/tsx/dist/loader.mjs"),
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
        yield adapter, command, cache
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


async def test_real_bridge_roundtrip_and_media(connection):
    adapter, command, cache = connection
    image_path = cache / "收到的图片.png"
    image_path.write_bytes(PNG)
    incoming_file = cache / "收到的文件.txt"
    incoming_file.write_text("从 KK9 上传的内容")
    incoming = {
        "id": "m-1",
        "messageId": "m-1",
        "sessionId": "1-200",
        "sessionName": "测试群",
        "sessionType": "group",
        "senderId": "42",
        "sender": "员工",
        "content": "帮我看附件",
        "direction": "inbound",
        "timestamp": 1700000000000,
        "mentions": {"isAtMe": True, "isAtAll": False, "mentionedUsers": ["100"]},
        "images": [{"filePath": str(image_path)}],
        "fileInfo": {"fileName": "收到的文件.txt", "filePath": str(incoming_file)},
    }
    await command("emit", message=incoming)
    event = await asyncio.wait_for(adapter._event_queue.get(), 10)
    assert event.get_sender_id() == "42"
    assert event.get_group_id() == "1-200"
    assert any(isinstance(part, At) and str(part.qq) == "100" for part in event.message_obj.message)
    image = next(part for part in event.message_obj.message if isinstance(part, Image))
    attachment = next(part for part in event.message_obj.message if isinstance(part, File))
    assert Path(await image.convert_to_file_path()).read_bytes() == PNG
    assert Path(await attachment.get_file()).read_text() == "从 KK9 上传的内容"

    await command("emit", message=incoming)
    await command(
        "emit",
        message={
            **incoming,
            "id": "echo",
            "messageId": "echo",
            "direction": "outbound",
            "isMe": True,
        },
    )
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(adapter._event_queue.get(), 0.2)

    await event.send(
        MessageChain([Reply(id="m-1"), At(qq="42", name="员工"), Plain("完整"), Plain("回复")])
    )
    calls = await command("calls")
    assert len(calls) == 1
    assert calls[0]["payload"] == "完整回复"
    assert calls[0]["options"]["targetSessionId"] == "1-200"
    assert calls[0]["options"]["replyTo"] == "m-1"
    assert calls[0]["options"]["mentions"] == [{"uid": "42", "name": "员工"}]

    await event.send(
        MessageChain(
            [
                Image.fromFileSystem(str(image_path)),
                File(name="生成的文件.txt", file=str(incoming_file)),
            ]
        )
    )
    calls = await command("calls")
    assert [call["type"] for call in calls] == ["text", "image", "file"]
    assert base64.b64decode(calls[1]["bytes_base64"]) == PNG
    assert base64.b64decode(calls[2]["bytes_base64"]).decode() == "从 KK9 上传的内容"
    # 重新解析持久会话后主动发送，仍能还原群目标。
    await adapter.send_by_session(
        MessageSession.from_str(event.unified_msg_origin), MessageChain([Plain("主动通知")])
    )
    assert (await command("calls"))[-1]["options"]["targetSessionId"] == "1-200"


async def test_unknown_send_is_not_retried_and_driver_recovers(connection):
    adapter, command, _ = connection
    await command("behavior", behavior={"mode": "post_trigger_timeout"})
    with pytest.raises(BridgeError) as exc:
        await adapter.send_chain("0-42", MessageChain([Plain("可能已经发出")]))
    assert exc.value.code == "SEND_UNKNOWN"
    calls = await command("calls")
    assert len(calls) == 1
    operation_id = calls[0]["options"]["operationId"]
    result = await adapter.server.request("get_send_status", {"operation_id": operation_id})
    assert result["status"] == "unknown"
    await command("health")
    async with asyncio.timeout(10):
        while await command("generations") < 2 or not adapter.server.connected:
            await asyncio.sleep(0.02)
    # 新 Driver 实例复用同一发送状态存储。
    result = await adapter.server.request("get_send_status", {"operation_id": operation_id})
    assert result["status"] == "unknown"
    await adapter.send_chain("0-42", MessageChain([Plain("恢复后的新消息")]))
    calls = await command("calls")
    assert len(calls) == 2
    assert calls[1]["payload"] == "恢复后的新消息"
