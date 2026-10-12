"""通知入口经真实 AstrBot 指令解析器及权限过滤器执行。"""

from types import SimpleNamespace

import pytest
from astrbot.api.event import AstrMessageEvent
from astrbot.api.star import Context
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.star.star_handler import star_handlers_registry
from astrbot_plugin_kairo.main import KairoPlugin
from astrbot_plugin_kairo.mapping import convert_message
from astrbot_plugin_kairo.policy import KairoAccessPolicy
from astrbot_plugin_kairo.transport import BridgeError


class NotificationClient:
    """外部原生发送边界；只记录被实际授权提交的通知。"""

    def __init__(self, result, config=None, error=None):
        self.result = result
        self.error = error
        self.policy = KairoAccessPolicy(config or {})
        self.notifications = []

    async def notify_employee(self, login_name, text):
        self.policy.check_employee(login_name)
        if self.error:
            raise self.error
        self.notifications.append((login_name, text))
        return self.result


class NotificationPlatform:
    def __init__(self, platform_id, client, name="kairo"):
        self._meta = PlatformMetadata(name=name, description="test", id=platform_id)
        self._client = client

    def meta(self):
        return self._meta

    def get_client(self):
        return self._client


def make_plugin(*platforms):
    context = Context.__new__(Context)
    context.platform_manager = SimpleNamespace(platform_insts=list(platforms))
    return KairoPlugin(context)


def make_event(command, *, admin=True, awake=True):
    # WakingStage 在调用这些过滤器前去掉配置的唤醒前缀；不伪造指令参数。
    text = command.removeprefix("/")
    message = convert_message(
        {
            "direction": "inbound",
            "sessionId": "12345",
            "sessionType": "private",
            "messageId": "command-1",
            "senderId": "admin-uid",
            "content": text,
        },
        self_id="bot",
        isolate_group_users=True,
        get_file_path=lambda _: None,
    )
    event = AstrMessageEvent(
        text,
        message,
        PlatformMetadata(name="other", description="command source", id="source"),
        message.session_id,
    )
    event.role = "admin" if admin else "member"
    event.is_at_or_wake_command = awake
    return event


async def dispatch(plugin, event):
    handler = next(
        metadata
        for metadata in star_handlers_registry.get_handlers_by_module_name(KairoPlugin.__module__)
        if metadata.handler_name == "notify"
    )
    if not all(event_filter.filter(event, {}) for event_filter in handler.event_filters):
        return []
    params = event.get_extra("parsed_params")
    return [result async for result in handler.handler(plugin, event, **params)]


def reply_text(results):
    return "\n".join(component.text for result in results for component in result.chain)


@pytest.mark.asyncio
async def test_real_parser_preserves_spaced_body_and_selects_exact_platform_instance():
    first = NotificationClient({"status": "sent", "operationId": "not-selected"})
    second = NotificationClient({"status": "sent", "operationId": "intent-42"})
    plugin = make_plugin(
        NotificationPlatform("first", first), NotificationPlatform("second", second)
    )
    replies = await dispatch(
        plugin, make_event("/kairo notify second EmployeeA 正文  保留空格\n以及换行")
    )
    assert first.notifications == []
    assert second.notifications == [("EmployeeA", "正文  保留空格\n以及换行")]
    text = reply_text(replies)
    assert "sent" in text
    assert "不代表" in text
    assert "intent-42" in text


@pytest.mark.asyncio
@pytest.mark.parametrize("admin,awake", [(False, True), (True, False)])
async def test_actual_permission_and_wake_filters_block_notifications(admin, awake):
    client = NotificationClient({"status": "sent", "operationId": "not-sent"})
    plugin = make_plugin(NotificationPlatform("one", client))
    assert (
        await dispatch(
            plugin, make_event("/kairo notify one EmployeeA hello world", admin=admin, awake=awake)
        )
        == []
    )
    assert client.notifications == []


@pytest.mark.asyncio
async def test_admin_does_not_bypass_shared_employee_policy():
    client = NotificationClient(
        {"status": "sent", "operationId": "not-sent"},
        config={"user_blacklist": ["EmployeeA"]},
    )
    replies = await dispatch(
        make_plugin(NotificationPlatform("one", client)),
        make_event("/kairo notify one EmployeeA hello world"),
    )
    assert client.notifications == []
    assert "ACCESS_DENIED" in reply_text(replies)
    assert "黑名单" in reply_text(replies)


@pytest.mark.asyncio
@pytest.mark.parametrize("platform_name", [None, "other"])
async def test_missing_or_wrong_platform_type_never_submits(platform_name):
    client = NotificationClient({"status": "sent", "operationId": "not-sent"})
    platforms = (
        [] if platform_name is None else [NotificationPlatform("one", client, platform_name)]
    )
    replies = await dispatch(
        make_plugin(*platforms), make_event("/kairo notify one EmployeeA hello world")
    )
    assert client.notifications == []
    assert "平台" in reply_text(replies)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result,expected",
    [
        (
            {
                "status": "failed",
                "operationId": "failed-1",
                "error": "无私聊权限",
                "nativeCode": 403,
            },
            "无私聊权限",
        ),
        ({"status": "unknown", "operationId": "unknown-1", "error": "回执超时"}, "不会自动重发"),
    ],
)
async def test_native_failure_and_unknown_are_reported_without_retry(result, expected):
    client = NotificationClient(result)
    replies = await dispatch(
        make_plugin(NotificationPlatform("one", client)),
        make_event("/kairo notify one EmployeeA hello world"),
    )
    assert client.notifications == [("EmployeeA", "hello world")]
    assert expected in reply_text(replies)
    assert result["operationId"] in reply_text(replies)
    if "nativeCode" in result:
        assert "403" in reply_text(replies)


@pytest.mark.asyncio
async def test_transport_error_preserves_code_and_reason():
    client = NotificationClient({}, error=BridgeError("DISCONNECTED", "桥接连接已断开"))
    replies = await dispatch(
        make_plugin(NotificationPlatform("one", client)),
        make_event("/kairo notify one EmployeeA hello world"),
    )
    assert client.notifications == []
    assert "DISCONNECTED" in reply_text(replies)
    assert "桥接连接已断开" in reply_text(replies)


@pytest.mark.asyncio
async def test_empty_body_shows_usage_without_submission():
    client = NotificationClient({"status": "sent", "operationId": "not-sent"})
    replies = await dispatch(
        make_plugin(NotificationPlatform("one", client)),
        make_event("/kairo notify one EmployeeA"),
    )
    assert client.notifications == []
    assert "正文" in reply_text(replies)
