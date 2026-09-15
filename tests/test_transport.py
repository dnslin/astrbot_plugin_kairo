import asyncio
import os
import time

import aiohttp
import pytest
import pytest_asyncio

from transport import BridgeError, BridgeServer

TOKEN = "test-bridge-token-not-a-real-secret-123456"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


@pytest_asyncio.fixture
async def server(tmp_path):
    received = []

    async def on_event(message):
        received.append(message)

    bridge = BridgeServer(
        token=TOKEN,
        expected_self_id="100",
        on_event=on_event,
        storage_dir=tmp_path / "files",
        request_timeout=0.2,
    )
    bridge.received = received
    await bridge.start("127.0.0.1", 0)
    bridge.test_url = f"http://127.0.0.1:{bridge.bound_port}"
    yield bridge
    await bridge.close()


async def connect(client, server, uid="100"):
    ws = await client.ws_connect(server.test_url + "/ws", headers=HEADERS)
    await ws.send_json({"type": "hello", "version": 1, "self_id": uid})
    return ws


async def test_auth_identity_and_one_connection(server):
    async with aiohttp.ClientSession() as client:
        async with client.get(server.test_url + "/health") as response:
            assert response.status == 401
        bad = await connect(client, server, "wrong-bot")
        assert (await bad.receive()).type == aiohttp.WSMsgType.CLOSE
        assert not server.connected
        await bad.close()
        ws = await connect(client, server)
        assert await ws.receive_json() == {"type": "ready", "version": 1}
        with pytest.raises(aiohttp.WSServerHandshakeError) as exc:
            await client.ws_connect(server.test_url + "/ws", headers=HEADERS)
        assert exc.value.status == 409
        assert server.connected
        await ws.close()


async def test_ack_and_replay_deduplicate(server):
    event = {
        "type": "event",
        "event_id": "0-42:7",
        "message": {"id": "7", "sessionId": "0-42", "direction": "inbound"},
    }
    async with aiohttp.ClientSession() as client:
        ws = await connect(client, server)
        await ws.receive_json()
        for _ in range(2):
            await ws.send_json(event)
            assert await ws.receive_json() == {"type": "ack", "event_id": "0-42:7"}
        await ws.close()
        # 确认处理函数退出后，再模拟新连接。
        for _ in range(100):
            if not server.connected:
                break
            await asyncio.sleep(0.001)
        ws = await connect(client, server)
        await ws.receive_json()
        await ws.send_json(event)
        assert await ws.receive_json() == {"type": "ack", "event_id": "0-42:7"}
        assert len(server.received) == 1
        await ws.close()


async def test_event_can_await_request_without_blocking_reader(server):
    async def on_event(message):
        response = await server.request("get_send_status", {"operation_id": "op"})
        server.received.append(response)

    server.on_event = on_event
    async with aiohttp.ClientSession() as client:
        ws = await connect(client, server)
        await ws.receive_json()
        await ws.send_json({"type": "event", "event_id": "a", "message": {}})
        request = await ws.receive_json()
        assert request["action"] == "get_send_status"
        await ws.send_json(
            {"type": "response", "id": request["id"], "ok": True, "result": {"status": "delivered"}}
        )
        assert await ws.receive_json() == {"type": "ack", "event_id": "a"}
        assert server.received == [{"status": "delivered"}]
        await ws.close()


async def test_timeout_never_reissues_send(server):
    async with aiohttp.ClientSession() as client:
        ws = await connect(client, server)
        await ws.receive_json()
        task = asyncio.create_task(server.request("send", {"operation_id": "one"}))
        request = await ws.receive_json()
        assert request["params"]["operation_id"] == "one"
        with pytest.raises(BridgeError, match="超时") as exc:
            await task
        assert exc.value.code == "TIMEOUT"
        assert not server._pending
        # 迟到的结果不产生新请求，也不会损坏连接。
        await ws.send_json(
            {"type": "response", "id": request["id"], "ok": True, "result": {"status": "delivered"}}
        )
        await ws.send_json({"type": "event", "event_id": "still-live", "message": {}})
        assert (await ws.receive_json())["type"] == "ack"
        await ws.close()


async def test_disconnect_fails_pending_as_unknown(server):
    async with aiohttp.ClientSession() as client:
        ws = await connect(client, server)
        await ws.receive_json()
        task = asyncio.create_task(server.request("send", {"operation_id": "one"}))
        await ws.receive_json()
        await ws.close()
        with pytest.raises(BridgeError) as exc:
            await task
        assert exc.value.code == "CONNECTION_LOST"


async def test_upload_download_size_and_expiry(server):
    server.max_file_size = 8
    async with aiohttp.ClientSession() as client:
        async with client.post(
            server.test_url + "/files",
            params={"name": r"C:\outside\报告.txt"},
            headers=HEADERS,
            data=b"hello",
        ) as response:
            assert response.status == 200
            descriptor = await response.json()
        file_id = descriptor["file_id"]
        path = server.get_file_path(file_id)
        assert path.name == "报告.txt"
        assert path.is_relative_to(server.storage_dir)
        async with client.get(server.test_url + "/files/" + file_id) as response:
            assert response.status == 401
        async with client.get(server.test_url + "/files/" + file_id, headers=HEADERS) as response:
            assert response.status == 200
            assert await response.read() == b"hello"
        async with client.post(
            server.test_url + "/files", headers=HEADERS, data=b"a" * 9
        ) as response:
            assert response.status == 413
        os.utime(path, (time.time() - 90000, time.time() - 90000))
        async with client.get(server.test_url + "/files/" + file_id, headers=HEADERS) as response:
            assert response.status == 404
        with pytest.raises(BridgeError):
            server.get_file_path("../../etc/passwd")


async def test_chunked_overflow_leaves_no_partial_file(server):
    server.max_file_size = 4

    async def chunks():
        yield b"123"
        yield b"456"

    async with aiohttp.ClientSession() as client:
        async with client.post(
            server.test_url + "/files", headers=HEADERS, data=chunks()
        ) as response:
            assert response.status == 413
    assert not list(server.storage_dir.iterdir())


async def test_long_chinese_filename_survives_linux_transfer(server):
    async with aiohttp.ClientSession() as client:
        async with client.post(
            server.test_url + "/files",
            params={"name": "报" * 90 + ".pdf"},
            headers=HEADERS,
            data=b"sample",
        ) as response:
            assert response.status == 200
            descriptor = await response.json()
        assert len(descriptor["name"].encode("utf-8")) <= 240
        assert descriptor["name"].endswith(".pdf")
        async with client.get(
            server.test_url + "/files/" + descriptor["file_id"], headers=HEADERS
        ) as response:
            assert await response.read() == b"sample"


async def test_local_copy_cache_limit_and_restart(tmp_path, server):
    source = tmp_path / "test.txt"
    source.write_bytes(b"copied")
    descriptor = await server.add_file(source)
    assert server.get_file_path(descriptor["file_id"]).read_bytes() == b"copied"
    restored = BridgeServer(
        token=TOKEN,
        expected_self_id="100",
        on_event=server.on_event,
        storage_dir=server.storage_dir,
    )
    assert restored.get_file_path(descriptor["file_id"]).read_bytes() == b"copied"
    server.max_cache_size = 7
    with pytest.raises(BridgeError) as exc:
        await server.add_file(source)
    assert exc.value.code == "CACHE_FULL"


async def test_concurrent_close_is_safe(server):
    await asyncio.gather(server.close(), server.close())
    assert server._runner is None
    assert not server.connected
