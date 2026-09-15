"""Kairo 的 WebSocket 调用通道和受鉴权的附件传输。

aiohttp API: https://docs.aiohttp.org/en/stable/web_reference.html
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
import shutil
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import quote

from aiohttp import WSMsgType, web

logger = logging.getLogger(__name__)
FILE_ID = re.compile(r"^[a-f0-9]{32}$")


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class BridgeServer:
    def __init__(
        self,
        *,
        token: str,
        expected_self_id: str,
        on_event: Callable[[dict], Awaitable[None]],
        storage_dir: Path,
        on_status: Callable[[bool], None] | None = None,
        request_timeout: float = 30,
        max_file_size: int = 100 * 1024 * 1024,
    ):
        if len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
            raise ValueError("桥接 token 至少需要 32 个无空白的 ASCII 字符")
        if not str(expected_self_id).strip():
            raise ValueError("请配置 KK9 机器人 UID")
        if request_timeout <= 0:
            raise ValueError("请求超时必须大于 0")
        self.token = token
        self.expected_self_id = str(expected_self_id).strip()
        self.on_event = on_event
        self.on_status = on_status
        self.storage_dir = Path(storage_dir).resolve()
        self.request_timeout = request_timeout
        self.max_file_size = max_file_size
        self.max_cache_size = 1024 * 1024 * 1024
        self.file_ttl = 24 * 60 * 60
        self.bound_port: int | None = None
        self.connected = False
        self._runner: web.AppRunner | None = None
        self._ws: web.WebSocketResponse | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._events: asyncio.Queue[tuple[str, dict]] = asyncio.Queue(maxsize=256)
        self._queued: set[str] = set()
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._worker: asyncio.Task | None = None
        self._janitor: asyncio.Task | None = None
        self._file_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
        self._closing = False

    async def start(self, host: str, port: int) -> None:
        if self._runner is not None:
            raise RuntimeError("桥接服务已经启动")
        self.storage_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._cleanup_files()
        app = web.Application(client_max_size=self.max_file_size)
        app.router.add_get("/ws", self._websocket)
        app.router.add_post("/files", self._upload)
        app.router.add_get("/files/{file_id}", self._download)
        app.router.add_get("/health", self._health)
        self._runner = web.AppRunner(app, access_log=None)
        try:
            await self._runner.setup()
            site = web.TCPSite(self._runner, host, port)
            await site.start()
            self.bound_port = self._runner.addresses[0][1]
            self._worker = asyncio.create_task(self._event_worker())
            self._janitor = asyncio.create_task(self._clean_loop())
        except BaseException:
            await self._runner.cleanup()
            self._runner = None
            raise

    async def close(self) -> None:
        # AstrBot 的 terminate() 和 run() finally 可能同时到达这里。
        async with self._close_lock:
            self._closing = True
            self.connected = False
            self._fail_pending()
            if self._ws is not None:
                await self._ws.close(code=1001, message=b"server stopping")
            for task in (self._worker, self._janitor):
                if task is not None:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
            if self._runner is not None:
                await self._runner.cleanup()
                self._runner = None
            self._notify_status(False)

    def _authorize(self, request: web.Request) -> None:
        value = request.headers.get("Authorization", "")
        if not secrets.compare_digest(value.encode(), f"Bearer {self.token}".encode()):
            raise web.HTTPUnauthorized(text="需要有效的桥接凭据")

    def _notify_status(self, connected: bool) -> None:
        if self.on_status is not None:
            try:
                self.on_status(connected)
            except Exception:
                logger.exception("更新桥接状态失败")

    def _fail_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(
                    BridgeError("CONNECTION_LOST", "桥接连接断开，已提交的发送结果未知")
                )

    async def _websocket(self, request: web.Request) -> web.StreamResponse:
        self._authorize(request)
        if self._closing:
            raise web.HTTPServiceUnavailable(text="服务正在停止")
        if self._ws is not None:
            raise web.HTTPConflict(text="此平台已经有一个桥接连接")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=2 * 1024 * 1024)
        self._ws = ws
        try:
            await ws.prepare(request)
            try:
                hello = await ws.receive_json(timeout=10)
            except (ValueError, TypeError, TimeoutError):
                await ws.close(code=1008, message=b"hello required")
                return ws
            if (
                not isinstance(hello, dict)
                or hello.get("type") != "hello"
                or hello.get("version") != 1
                or hello.get("self_id") != self.expected_self_id
            ):
                logger.warning("拒绝协议版本或机器人 UID 不匹配的桥接连接")
                await ws.close(code=1008, message=b"version or identity mismatch")
                return ws
            self.connected = True
            await ws.send_json({"type": "ready", "version": 1})
            self._notify_status(True)
            async for frame in ws:
                if frame.type != WSMsgType.TEXT:
                    if frame.type == WSMsgType.ERROR:
                        break
                    continue
                try:
                    data = json.loads(frame.data)
                    if not isinstance(data, dict):
                        raise ValueError("消息必须是对象")
                    if data.get("type") == "response":
                        self._response(data)
                    elif data.get("type") == "event":
                        event_id, message = data.get("event_id"), data.get("message")
                        if (
                            not isinstance(event_id, str)
                            or not 0 < len(event_id) <= 1024
                            or not isinstance(message, dict)
                        ):
                            raise ValueError("无效的入站事件")
                        if event_id in self._seen:
                            await ws.send_json({"type": "ack", "event_id": event_id})
                        elif event_id not in self._queued:
                            self._events.put_nowait((event_id, message))
                            self._queued.add(event_id)
                    else:
                        raise ValueError("未知的协议消息类型")
                except asyncio.QueueFull:
                    logger.error("入站队列已满，断开桥接等待未确认事件重发")
                    await ws.close(code=1013, message=b"event queue full")
                except (ValueError, TypeError):
                    logger.warning("拒绝格式错误的桥接消息")
                    await ws.close(code=1008, message=b"invalid message")
        except (ConnectionError, RuntimeError):
            logger.info("桥接连接已关闭")
        finally:
            if self._ws is ws:
                self._ws = None
                self.connected = False
                self._fail_pending()
                self._notify_status(False)
        return ws

    def _response(self, data: dict) -> None:
        request_id = data.get("id")
        if not isinstance(request_id, str):
            raise ValueError("响应缺少请求 ID")
        future = self._pending.get(request_id)
        if future is None or future.done():
            return
        if data.get("ok") is True and isinstance(data.get("result"), dict):
            future.set_result(data["result"])
        elif data.get("ok") is False and isinstance(data.get("error"), dict):
            error = data["error"]
            future.set_exception(
                BridgeError(
                    str(error.get("code", "REMOTE_ERROR")),
                    str(error.get("message", "桥接请求失败")),
                )
            )
        else:
            raise ValueError("无效的请求响应")

    async def _event_worker(self) -> None:
        # 与 WS 读取分开，否则事件处理中的异步请求会等待自己的接收循环。
        while True:
            event_id, message = await self._events.get()
            try:
                await self.on_event(message)
                self._seen[event_id] = None
                if len(self._seen) > 10000:
                    self._seen.popitem(last=False)
                ws = self._ws
                if self.connected and ws is not None:
                    with contextlib.suppress(ConnectionError, RuntimeError):
                        await ws.send_json({"type": "ack", "event_id": event_id})
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("入站事件处理失败，保留未确认状态")
                ws = self._ws
                if ws is not None:
                    await ws.close(code=1011, message=b"event processing failed")
            finally:
                self._queued.discard(event_id)
                self._events.task_done()

    async def request(self, action: str, params: dict) -> dict:
        if action not in {"send", "get_send_status"}:
            raise BridgeError("INVALID_ACTION", "不支持的桥接操作")
        ws = self._ws
        if not self.connected or ws is None or ws.closed:
            raise BridgeError("DISCONNECTED", "KK9 桥接未连接，发送未提交")
        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await ws.send_json(
                {"type": "request", "id": request_id, "action": action, "params": params}
            )
            return await asyncio.wait_for(future, timeout=self.request_timeout)
        except TimeoutError as exc:
            raise BridgeError("TIMEOUT", "桥接请求超时，发送可能已经完成，请查询原操作 ID") from exc
        except (ConnectionError, RuntimeError) as exc:
            raise BridgeError("CONNECTION_LOST", "桥接连接断开，发送结果未知") from exc
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # send_json 失败和断线通知可能同时发生；读取异常避免悬空 Future。
                future.exception()

    async def _health(self, request: web.Request) -> web.Response:
        self._authorize(request)
        return web.json_response({"version": 1, "connected": self.connected})

    def get_file_path(self, file_id: str) -> Path:
        if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
            raise BridgeError("FILE_UNAVAILABLE", "无效的附件 ID")
        folder = self.storage_dir / file_id
        if folder.is_symlink() or not folder.is_dir():
            raise BridgeError("FILE_UNAVAILABLE", "附件不存在或已过期")
        files = list(folder.iterdir())
        if len(files) != 1 or files[0].is_symlink() or not files[0].is_file():
            raise BridgeError("FILE_UNAVAILABLE", "附件尚未写入完成或不可读")
        if time.time() - files[0].stat().st_mtime > self.file_ttl:
            raise BridgeError("FILE_UNAVAILABLE", "附件已过期")
        return files[0]

    def _allocate_file(self, name: str) -> tuple[str, Path]:
        # 同时处理来自 Linux 和 Windows 的文件名，不允许请求指定缓存目录。
        safe_name = Path(PureWindowsPath(name).name).name
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", safe_name).strip(" .")[:180]
        if not safe_name or safe_name.upper().split(".")[0] in {
            "CON",
            "PRN",
            "AUX",
            "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10)),
        }:
            safe_name = "attachment"
        # Linux 文件名上限按字节计算，保留扩展名并避免截断 UTF-8 字符。
        if len(safe_name.encode("utf-8")) > 240:
            suffix = Path(safe_name).suffix
            if len(suffix.encode("utf-8")) > 40:
                suffix = ""
            stem = safe_name[: -len(suffix)] if suffix else safe_name
            stem = stem.encode("utf-8")[: 240 - len(suffix.encode("utf-8"))].decode(
                "utf-8", errors="ignore"
            )
            safe_name = stem + suffix
        file_id = uuid.uuid4().hex
        folder = self.storage_dir / file_id
        folder.mkdir(mode=0o700)
        return file_id, folder / safe_name

    def _cache_size(self) -> int:
        return sum(
            p.stat().st_size
            for p in self.storage_dir.glob("*/*")
            if p.is_file() and not p.is_symlink()
        )

    async def _upload(self, request: web.Request) -> web.Response:
        self._authorize(request)
        if request.content_length is not None and request.content_length > self.max_file_size:
            raise web.HTTPRequestEntityTooLarge(
                max_size=self.max_file_size, actual_size=request.content_length
            )
        async with self._file_lock:
            self._cleanup_files()
            used = self._cache_size()
            file_id, path = self._allocate_file(request.query.get("name", "attachment"))
            size = 0
            complete = False
            try:
                async with asyncio.timeout(120):
                    with path.open("xb") as output:
                        async for chunk in request.content.iter_chunked(64 * 1024):
                            size += len(chunk)
                            if size > self.max_file_size:
                                raise web.HTTPRequestEntityTooLarge(
                                    max_size=self.max_file_size, actual_size=size
                                )
                            if used + size > self.max_cache_size:
                                raise web.HTTPInsufficientStorage(text="附件缓存已满")
                            output.write(chunk)
                complete = True
                return web.json_response({"file_id": file_id, "name": path.name, "size": size})
            except TimeoutError as exc:
                raise web.HTTPRequestTimeout(text="附件上传超时") from exc
            finally:
                if not complete:
                    shutil.rmtree(path.parent, ignore_errors=True)

    async def _download(self, request: web.Request) -> web.FileResponse:
        self._authorize(request)
        try:
            path = self.get_file_path(request.match_info["file_id"])
        except BridgeError as exc:
            raise web.HTTPNotFound(text=exc.message) from exc
        return web.FileResponse(
            path,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(path.name)}",
            },
        )

    async def add_file(self, path: Path, name: str | None = None) -> dict[str, Any]:
        source = Path(path)
        if not source.is_file():
            raise BridgeError("FILE_UNAVAILABLE", "待发送附件不存在")
        size = source.stat().st_size
        if size > self.max_file_size:
            raise BridgeError("FILE_TOO_LARGE", "附件超过 100 MiB 限制")
        async with self._file_lock:
            self._cleanup_files()
            if self._cache_size() + size > self.max_cache_size:
                raise BridgeError("CACHE_FULL", "附件缓存已满")
            file_id, target = self._allocate_file(name or source.name)
            copy = asyncio.create_task(asyncio.to_thread(shutil.copyfile, source, target))
            try:
                await asyncio.shield(copy)
            except BaseException:
                with contextlib.suppress(Exception):
                    await copy
                shutil.rmtree(target.parent, ignore_errors=True)
                raise
            return {"file_id": file_id, "name": target.name, "size": size}

    def _cleanup_files(self) -> None:
        now = time.time()
        for folder in self.storage_dir.iterdir():
            if FILE_ID.fullmatch(folder.name) and folder.is_dir() and not folder.is_symlink():
                if now - folder.stat().st_mtime > self.file_ttl:
                    shutil.rmtree(folder, ignore_errors=True)

    async def _clean_loop(self) -> None:
        while True:
            await asyncio.sleep(3600)
            async with self._file_lock:
                self._cleanup_files()
