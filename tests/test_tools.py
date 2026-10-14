"""按需工具经真实框架 schema、事件和 KairoClient 策略发送。"""

import asyncio
from types import SimpleNamespace

import jsonschema
import pytest
from astrbot.api.event import AstrMessageEvent
from astrbot.api.platform import PlatformMetadata
from astrbot.api.star import Context
from astrbot.core.agent.hooks import BaseAgentRunHooks
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.runners.base import AgentState
from astrbot.core.agent.runners.tool_loop_agent_runner import ToolLoopAgentRunner
from astrbot.core.agent.tool import FunctionTool, ToolSet
from astrbot.core.astr_agent_context import AstrAgentContext
from astrbot.core.astr_agent_tool_exec import FunctionToolExecutor
from astrbot.core.provider.entities import LLMResponse, ProviderRequest
from astrbot.core.provider.func_tool_manager import FunctionToolManager
from astrbot.core.star.star_manager import PluginManager
from astrbot_plugin_kairo.client import KairoClient
from astrbot_plugin_kairo.event import KairoMessageEvent
from astrbot_plugin_kairo.main import KairoPlugin
from astrbot_plugin_kairo.mapping import convert_message
from astrbot_plugin_kairo.policy import KairoAccessPolicy
from astrbot_plugin_kairo.tools import (
    KAIRO_ADMIN_TOOL_NAMES,
    KAIRO_TOOL_NAMES,
    KairoSendAppCardTool,
    KairoSendBizCardTool,
    KairoSendUrlCardTool,
    KairoSendVoiceTool,
)
from astrbot_plugin_kairo.transport import BridgeError

CASES = [
    (KairoSendVoiceTool, {"text": "请听这段话"}, "voice_text"),
    (KairoSendAppCardTool, {"title": "公告", "text": "正文"}, "app_card"),
    (
        KairoSendUrlCardTool,
        {"title": "链接", "summary": "说明", "linkUrl": "https://example.org"},
        "url_card",
    ),
    (
        KairoSendBizCardTool,
        {"title": "任务", "text": "已存在的任务", "bizType": 1, "bizUrl": "/task/42"},
        "biz_card",
    ),
]


class NativeBoundary:
    """只替代原生外部边界：接收真实 client 的已授权 wire 参数。"""

    def __init__(self, *, status="sent", error=None, block=False):
        self.status = status
        self.error = error
        self.sends = []
        self.lookups = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        if not block:
            self.release.set()
        self.last_result = None

    async def request(self, action, params, *, timeout=None):
        if action == "get_sessions":
            self.lookups.append(action)
            return {"sessions": [{"id": "12345", "type": "group"}]}
        if action == "get_user_profile":
            self.lookups.append((action, params["user_id"]))
            return {"profile": {"loginName": "EmployeeA"}}
        if action == "get_send_status":
            return self.last_result
        assert action == "send", f"工具不能执行额外原生操作：{action}"
        self.sends.append(dict(params))
        self.started.set()
        await self.release.wait()
        if self.error:
            raise self.error
        self.last_result = {
            "status": self.status,
            "operationId": params["operation_id"],
            "messageId": "native-message-1",
        }
        if self.status != "sent":
            self.last_result.update(error="原生拒绝或回执超时", nativeCode=403)
        return self.last_result


class EventAdapter:
    def __init__(self, client):
        self.client = client

    def get_client(self):
        return self.client

    async def send_chain(self, target_session_id, message, *, sender_id=None):
        await self.client.send_chain(target_session_id, message, sender_id=sender_id)


def make_context():
    context = Context.__new__(Context)
    context.platform_manager = SimpleNamespace(platform_insts=[])
    context.provider_manager = SimpleNamespace(llm_tools=FunctionToolManager())
    return context


def make_event(boundary, config=None, *, name="kairo", native=True):
    message = convert_message(
        {
            "direction": "inbound",
            "sessionId": "12345",
            "sessionType": "group",
            "messageId": "request-1",
            "senderId": "sender-uid",
            "content": "按用户要求输出",
        },
        self_id="bot",
        isolate_group_users=True,
        get_file_path=lambda _: None,
    )
    metadata = PlatformMetadata(name=name, description="test", id="instance")
    client = KairoClient(boundary, KairoAccessPolicy(config if config is not None else {}))
    if native:
        event = KairoMessageEvent(message, metadata, EventAdapter(client))
    else:
        event = AstrMessageEvent(message.message_str, message, metadata, message.session_id)
        # 同名平台和伪造属性不能代替真实的 Kairo 事件。
        event.adapter = EventAdapter(client)
        event.target_session_id = "12345"
        event.sender_id = "sender-uid"
    return event


def wrap(event, context=None):
    return ContextWrapper(AstrAgentContext(context=context or make_context(), event=event))


def test_real_tools_register_once_with_plugin_lifecycle_ownership():
    context = make_context()
    KairoPlugin(context)
    tools = context.provider_manager.llm_tools.func_list
    assert {tool.name for tool in tools} == KAIRO_TOOL_NAMES
    for tool in tools:
        assert isinstance(tool, FunctionTool)
        assert PluginManager._is_plugin_llm_tool(tool, KairoPlugin.__module__)
    KairoPlugin(context)
    schemas = ToolSet(context.provider_manager.llm_tools.func_list).openai_schema()
    for schema in schemas:
        parameters = schema["function"]["parameters"]
        jsonschema.Draft202012Validator.check_schema(parameters)
        assert parameters["additionalProperties"] is False
        assert not (
            {"target", "session", "path", "target_session_id"} & parameters["properties"].keys()
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
async def test_real_client_sends_only_requested_output_to_original_event_target(
    tool_type, args, kind
):
    boundary = NativeBoundary()
    event = make_event(boundary)
    event.session_id = "rewritten-context-session"
    event.unified_msg_origin = "other:GroupMessage:99999"
    assert await tool_type().call(wrap(event), **args) is None
    assert len(boundary.sends) == 1
    assert boundary.sends[0]["kind"] == kind
    assert boundary.sends[0]["target_session_id"] == "12345"
    assert event.get_result() is None
    assert not event.is_stopped()
    if kind == "voice_text":
        assert boundary.sends[0]["text"] == args["text"]
        assert "file_id" not in boundary.sends[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
@pytest.mark.parametrize("name,native", [("other", True), ("kairo", False)])
async def test_wrong_platform_or_forged_native_event_is_rejected(
    tool_type, args, kind, name, native
):
    boundary = NativeBoundary()
    result = await tool_type().call(wrap(make_event(boundary, name=name, native=native)), **args)
    assert "Kairo" in result and "错误" in result
    assert boundary.sends == []


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
async def test_same_event_duplicate_and_concurrent_calls_submit_once(tool_type, args, kind):
    boundary = NativeBoundary(block=True)
    event = make_event(boundary)
    first = asyncio.create_task(tool_type().call(wrap(event), **args))
    await boundary.started.wait()
    # 不同工具实例也必须共享当前事件的尝试记录。
    second = asyncio.create_task(tool_type().call(wrap(event), **args))
    await asyncio.sleep(0)
    assert len(boundary.sends) == 1
    boundary.release.set()
    assert await asyncio.gather(first, second) == [None, None]
    assert await tool_type().call(wrap(event), **args) is None
    assert len(boundary.sends) == 1


@pytest.mark.asyncio
async def test_tool_state_is_independent_across_events_and_capabilities():
    boundary = NativeBoundary()
    voice = KairoSendVoiceTool()
    first, second = make_event(boundary), make_event(boundary)
    assert await voice.call(wrap(first), text="一") is None
    assert await voice.call(wrap(second), text="二") is None
    assert await KairoSendAppCardTool().call(wrap(first), title="卡片", text="三") is None
    assert [send["kind"] for send in boundary.sends] == ["voice_text", "voice_text", "app_card"]
    assert len({send["operation_id"] for send in boundary.sends}) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
@pytest.mark.parametrize("status", ["failed", "unknown"])
async def test_native_failures_preserve_operation_id_and_never_resubmit(
    tool_type, args, kind, status
):
    boundary = NativeBoundary(status=status)
    event = make_event(boundary)
    tool = tool_type()
    result = await tool.call(wrap(event), **args)
    assert status in result
    assert "原生拒绝或回执超时" in result
    assert "403" in result
    assert f"operationId={boundary.sends[0]['operation_id']}" in result
    if status == "unknown":
        assert "不重发" in result
    assert await tool.call(wrap(event), **args) == result
    assert len(boundary.sends) == 1
    assert event.get_result() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
async def test_runtime_blacklist_change_is_rechecked_and_denial_is_not_retried(
    tool_type, args, kind
):
    config = {"group_blacklist": [], "user_blacklist": []}
    boundary = NativeBoundary()
    event = make_event(boundary, config)
    config["user_blacklist"].append("EmployeeA")
    tool = tool_type()
    result = await tool.call(wrap(event), **args)
    assert "ACCESS_DENIED" in result
    assert "黑名单" in result
    assert ("get_user_profile", "sender-uid") in boundary.lookups
    config["user_blacklist"].clear()
    assert await tool.call(wrap(event), **args) == result
    assert boundary.sends == []
    assert await tool.call(wrap(make_event(boundary, config)), **args) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
async def test_bridge_errors_remain_errors_and_do_not_retry(tool_type, args, kind):
    boundary = NativeBoundary(error=BridgeError("DISCONNECTED", "桥接连接已断开"))
    event = make_event(boundary)
    tool = tool_type()
    result = await tool.call(wrap(event), **args)
    assert "DISCONNECTED" in result and "桥接连接已断开" in result
    assert await tool.call(wrap(event), **args) == result
    assert len(boundary.sends) == 1


@pytest.mark.asyncio
async def test_app_card_escapes_html_and_preserves_line_breaks_and_plain_title():
    boundary = NativeBoundary()
    args = {
        "title": '<公告>&"',
        "text": "<b>&\"'\r\n下一行\n末行",
        "linkUrl": "https://example.org?a=1&b=2",
    }
    assert await KairoSendAppCardTool().call(wrap(make_event(boundary)), **args) is None
    assert boundary.sends[0]["card"] == {
        "title": args["title"],
        "content": "&lt;b&gt;&amp;&quot;&#x27;<br>下一行<br>末行",
        "linkUrl": args["linkUrl"],
    }


@pytest.mark.asyncio
async def test_url_and_biz_cards_preserve_plain_contract_and_existing_target():
    boundary = NativeBoundary()
    event = make_event(boundary)
    assert (
        await KairoSendUrlCardTool().call(
            wrap(event),
            title="链接",
            summary="<纯文本>\n说明",
            linkUrl="https://example.org",
            picUrl="https://example.org/a.png",
        )
        is None
    )
    assert (
        await KairoSendBizCardTool().call(
            wrap(event),
            title="日程",
            text="<纯文本>\n正文",
            bizType=2,
            bizUrl="/schedule/42",
            summary=["甲", "乙"],
        )
        is None
    )
    assert boundary.sends[0]["card"]["summary"] == "<纯文本>\n说明"
    assert boundary.sends[1]["card"] == {
        "title": "日程",
        "content": "<纯文本>\n正文",
        "bizType": 2,
        "bizUrl": "/schedule/42",
        "summary": ["甲", "乙"],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool,args",
    [
        (KairoSendVoiceTool, {"text": " "}),
        (KairoSendVoiceTool, {"text": "😀" * 64_001}),
        (KairoSendVoiceTool, {"text": "你好", "voice": "someone"}),
        (KairoSendVoiceTool, {"text": "你好", "target_session_id": "99999"}),
        (KairoSendAppCardTool, {"title": "公告", "text": 123}),
        (KairoSendAppCardTool, {"title": "公告", "text": "正文", "linkUrl": " "}),
        (KairoSendUrlCardTool, {"title": "链接", "summary": "说明"}),
        (
            KairoSendBizCardTool,
            {"title": "任务", "text": "正文", "bizType": True, "bizUrl": "/task/42"},
        ),
        (
            KairoSendBizCardTool,
            {"title": "任务", "text": "正文", "bizType": 3, "bizUrl": "/task/42"},
        ),
        (
            KairoSendBizCardTool,
            {"title": "任务", "text": "正文", "bizType": 1, "bizUrl": "//example.org"},
        ),
        (
            KairoSendBizCardTool,
            {"title": "任务", "text": "正文", "bizType": 1, "bizUrl": "/task/42", "summary": [1]},
        ),
    ],
)
async def test_local_invalid_arguments_fail_without_native_submission(tool, args):
    boundary = NativeBoundary()
    result = await tool().call(wrap(make_event(boundary)), **args)
    assert "错误" in result
    assert boundary.sends == []


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [True, False])
@pytest.mark.parametrize("admin", [True, False])
async def test_request_filter_only_removes_own_tools_without_reenabling_persona_tools(
    native, admin
):
    context = make_context()
    plugin = KairoPlugin(context)
    registered = context.provider_manager.llm_tools.func_list
    unrelated = FunctionTool(name="other_tool", description="other", parameters={"type": "object"})
    # 人格已移除语音工具，且用户关闭另一工具；不得重新补回或改写 active。
    voice = next(tool for tool in registered if tool.name == "kairo_send_voice")
    app = next(tool for tool in registered if tool.name == "kairo_send_app_card")
    app.active = False
    available = [tool for tool in registered if tool not in (voice, app)]
    request = ProviderRequest(func_tool=ToolSet([*available, unrelated]))
    event = make_event(NativeBoundary(), native=native, name="kairo" if native else "other")
    event.role = "admin" if admin else "member"
    await plugin.filter_kairo_tools(event, request)
    assert request.func_tool.get_tool("other_tool") is unrelated
    assert request.func_tool.get_tool(voice.name) is None
    assert request.func_tool.get_tool(app.name) is None
    assert not app.active
    expected = {tool.name for tool in available} | {"other_tool"}
    if not native:
        expected -= KAIRO_TOOL_NAMES
    elif not admin:
        expected -= KAIRO_ADMIN_TOOL_NAMES
    assert {tool.name for tool in request.func_tool.tools} == expected
    disabled_request = ProviderRequest(func_tool=None)
    await plugin.filter_kairo_tools(event, disabled_request)
    assert disabled_request.func_tool is None


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES[:2])
@pytest.mark.parametrize("status", ["sent", "failed", "unknown"])
async def test_default_agent_stops_after_confirmed_send_but_explains_failure(
    tool_type, args, kind, status
):
    boundary = NativeBoundary(status=status)
    event = make_event(boundary)
    tool = tool_type()
    model_calls = 0

    async def text_chat(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls == 1:
            return LLMResponse(
                role="assistant",
                tools_call_name=[tool.name, tool.name],
                tools_call_ids=["first", "duplicate"],
                tools_call_args=[args, args],
            )
        return LLMResponse(role="assistant", completion_text="原生发送未确认，请核查原操作。")

    runner = ToolLoopAgentRunner()
    await runner.reset(
        provider=SimpleNamespace(provider_config={"id": "controlled-model"}, text_chat=text_chat),
        request=ProviderRequest(prompt="按需输出", func_tool=ToolSet([tool])),
        run_context=wrap(event),
        tool_executor=FunctionToolExecutor(),
        agent_hooks=BaseAgentRunHooks(),
    )
    async for _ in runner.step_until_done(max_step=3):
        pass
    assert runner.state == AgentState.DONE
    assert model_calls == (1 if status == "sent" else 2)
    assert len(boundary.sends) == 1
    assert boundary.sends[0]["kind"] == kind
    assert event.get_result() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES[:2])
async def test_cancelled_tool_wait_retains_original_intent_without_resubmission(
    tool_type, args, kind
):
    boundary = NativeBoundary(block=True)
    event = make_event(boundary)
    tool = tool_type()
    pending = asyncio.create_task(tool.call(wrap(event), **args))
    await boundary.started.wait()
    operation_id = boundary.sends[0]["operation_id"]
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    result = await tool.call(wrap(event), **args)
    assert "unknown" in result and "不重发" in result
    assert f"operationId={operation_id}" in result
    assert len(boundary.sends) == 1


@pytest.mark.asyncio
async def test_voice_accepts_exact_utf16_limit_without_host_tts_or_file_upload():
    boundary = NativeBoundary()
    text = "😀" * 64_000
    assert await KairoSendVoiceTool().call(wrap(make_event(boundary)), text=text) is None
    assert boundary.sends[0]["text"] == text
    assert boundary.sends[0]["kind"] == "voice_text"


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_type,args,kind", CASES)
async def test_group_whitelist_change_before_tool_execution_blocks_output(tool_type, args, kind):
    config = {"enable_group_whitelist": False, "group_whitelist": []}
    boundary = NativeBoundary()
    event = make_event(boundary, config)
    config["enable_group_whitelist"] = True
    result = await tool_type().call(wrap(event), **args)
    assert "ACCESS_DENIED" in result and "白名单" in result
    assert boundary.sends == []


@pytest.mark.asyncio
async def test_filter_rejects_other_platform_even_when_request_claims_kairo_name():
    context = make_context()
    plugin = KairoPlugin(context)
    request = ProviderRequest(func_tool=ToolSet(list(context.provider_manager.llm_tools.func_list)))
    await plugin.filter_kairo_tools(
        make_event(NativeBoundary(), name="kairo", native=False), request
    )
    assert request.func_tool.empty()


@pytest.mark.asyncio
async def test_driver_tts_failure_remains_native_error_without_success_or_fallback():
    boundary = NativeBoundary(status="failed")
    boundary.last_result = None

    # 真实 Driver 的外部合成错误经 bridge 返回失败结果，不使用宿主 TTS 重试。
    async def request(action, params, *, timeout=None):
        assert action == "send"
        boundary.sends.append(dict(params))
        return {
            "status": "failed",
            "operationId": params["operation_id"],
            "error": "VOICE_TTS_FAILED: Edge websocket handshake returned 403",
        }

    boundary.request = request
    event = make_event(boundary)
    tool = KairoSendVoiceTool()
    result = await tool.call(wrap(event), text="朗读")
    assert "VOICE_TTS_FAILED" in result and "403" in result
    assert f"operationId={boundary.sends[0]['operation_id']}" in result
    assert await tool.call(wrap(event), text="朗读") == result
    assert len(boundary.sends) == 1
