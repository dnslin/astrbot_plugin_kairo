"""Voice notification paths use real host events, agents, client and native-boundary fixtures."""

import asyncio
from types import SimpleNamespace

import pytest
from astrbot.core.agent.hooks import BaseAgentRunHooks
from astrbot.core.agent.runners.base import AgentState
from astrbot.core.agent.runners.tool_loop_agent_runner import ToolLoopAgentRunner
from astrbot.core.agent.tool import ToolSet
from astrbot.core.astr_agent_tool_exec import FunctionToolExecutor
from astrbot.core.provider.entities import LLMResponse, ProviderRequest
from astrbot_plugin_kairo.client import KairoClient
from astrbot_plugin_kairo.notifications import KairoNotifications, KairoSelectEmployeeTool
from astrbot_plugin_kairo.policy import KairoAccessPolicy
from astrbot_plugin_kairo.tools import _ATTEMPTS_KEY, KairoSendVoiceTool
from astrbot_plugin_kairo.transport import BridgeError
from test_notifications import NativeBoundary, employee, make_event, wrap


async def test_directed_voice_exact_name_uses_private_login_and_preserves_text_and_budget():
    boundary = NativeBoundary([employee(login="e00042")])
    manager = KairoNotifications()
    event = make_event(boundary, "请给张三私聊发语音")
    event.session_id = "rewritten-context"
    body = "  原始语音正文\n保留空格  "
    result = await KairoSendVoiceTool(manager).call(wrap(event), name=" 张三 ", text=body)
    assert result is None
    assert len(boundary.sends) == 1
    sent = boundary.sends[0]
    assert sent == {"login_name": "e00042", "text": body, "operation_id": sent["operation_id"]}
    assert [call[0] for call in boundary.calls] == [
        "search_employees",
        "get_user_profile",
        "send_voice_to_user",
    ]
    assert boundary.calls[-1][2] == 90
    assert (
        event.get_extra(_ATTEMPTS_KEY)["kairo_send_voice"]["operation_id"] == sent["operation_id"]
    )
    assert event._has_send_oper and not event.is_stopped()
    assert event.get_result() is None


async def test_directed_voice_ambiguous_name_requires_native_next_choice_and_text_snapshot():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    manager = KairoNotifications()
    voice, choose = KairoSendVoiceTool(manager), KairoSelectEmployeeTool(manager)
    source = make_event(boundary)
    args = {"name": "张三", "text": "原始语音\n下一行"}
    listing = await voice.call(wrap(source), **args)
    assert "EmployeeA" in listing and "EmployeeB" in listing
    assert not boundary.sends
    operation_id = source.get_extra(_ATTEMPTS_KEY)[voice.name]["operation_id"]
    assert "错误" in await choose.call(wrap(source), choice=2)
    fabricated = make_event(boundary, "不是选择", message_id="fabricated")
    fabricated.message_str = "2"
    assert "INVALID_ARGUMENT" in await choose.call(wrap(fabricated), choice=2)
    args["text"] = "选择时不得替换原正文"
    assert await voice.call(wrap(source), **args) == listing
    boundary.employees.reverse()
    choice = make_event(boundary, "选第2个", message_id="voice-choice")
    result = await choose.call(wrap(choice), choice=2)
    assert result is None
    assert [(send["login_name"], send["text"]) for send in boundary.sends] == [
        ("EmployeeB", "原始语音\n下一行")
    ]
    assert boundary.calls[-1][0] == "send_voice_to_user"
    assert boundary.sends[0]["operation_id"] == operation_id
    assert choice.get_extra(_ATTEMPTS_KEY)[choose.name]["operation_id"] == operation_id
    assert choice._has_send_oper and not choice.is_stopped()
    assert choice.get_result() is None


async def test_member_cannot_direct_voice_but_can_send_to_current_conversation():
    boundary = NativeBoundary()
    voice = KairoSendVoiceTool(KairoNotifications())
    event = make_event(boundary, admin=False)
    assert "ACCESS_DENIED" in await voice.call(wrap(event), name="张三", text="拒绝")
    assert not boundary.calls
    assert await voice.call(wrap(event), text="当前会话朗读") is None
    assert boundary.sends[0]["target_session_id"] == "12345"
    assert boundary.sends[0]["kind"] == "voice_text"
    assert boundary.calls[-1][0] == "send" and boundary.calls[-1][2] == 90


@pytest.mark.parametrize("failure", ["uid", "login", "missing", "policy", "actor", "group"])
async def test_directed_voice_rechecks_identity_and_lists_after_selection(failure):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    manager = KairoNotifications()
    config = {}
    await KairoSendVoiceTool(manager).call(
        wrap(make_event(boundary, config=config)), name="张三", text="不得发送"
    )
    if failure == "uid":
        boundary.profiles["uid-b"]["id"] = "changed-uid"
    elif failure == "login":
        boundary.profiles["uid-b"]["loginName"] = "Changed"
    elif failure == "missing":
        del boundary.profiles["uid-b"]
    elif failure == "policy":
        config["user_blacklist"] = ["EmployeeB"]
    elif failure == "actor":
        config["user_blacklist"] = ["SenderA"]
    else:
        config["group_blacklist"] = ["12345"]
    result = await KairoSelectEmployeeTool(manager).call(
        wrap(make_event(boundary, "2", message_id="choice", config=config)), choice=2
    )
    assert ("IDENTITY" if failure in {"uid", "login", "missing"} else "ACCESS_DENIED") in result
    assert not boundary.sends


@pytest.mark.parametrize("directed_first", [False, True])
@pytest.mark.parametrize("status", ["sent", "failed", "unknown"])
async def test_current_and_directed_voice_share_one_event_capability_attempt(
    directed_first, status
):
    boundary = NativeBoundary(status=status, block_send=True)
    manager = KairoNotifications()
    event = make_event(boundary)
    first_args = {"text": "首次正文", **({"name": "张三"} if directed_first else {})}
    second_args = {"text": "第二正文", **({} if directed_first else {"name": "张三"})}
    first = asyncio.create_task(KairoSendVoiceTool(manager).call(wrap(event), **first_args))
    await boundary.started.wait()
    duplicate = asyncio.create_task(KairoSendVoiceTool(manager).call(wrap(event), **second_args))
    await asyncio.sleep(0)
    assert len(boundary.sends) == 1
    boundary.release.set()
    first_result, second_result = await asyncio.gather(first, duplicate)
    assert first_result == second_result
    assert boundary.sends[0]["text"] == "首次正文"
    assert [call[0] for call in boundary.calls].count("search_employees") == int(directed_first)
    assert boundary.sends[0].get("login_name") == ("EmployeeA" if directed_first else None)
    assert boundary.sends[0].get("target_session_id") == (None if directed_first else "12345")
    if status == "sent":
        assert first_result is None
    else:
        assert status in first_result and boundary.sends[0]["operation_id"] in first_result
    assert await KairoSendVoiceTool(manager).call(wrap(event), **second_args) == first_result


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"text": "text", "voice_text": "voice"},
        {"card": {"type": "kairo.app"}, "voice_text": "voice"},
        {"media": {"kind": "image"}, "voice_text": "voice"},
    ],
)
async def test_notify_employee_uid_voice_is_exclusive_with_text_card_and_media(arguments):
    boundary = NativeBoundary()
    client = KairoClient(boundary, KairoAccessPolicy({}))
    with pytest.raises(ValueError):
        await client.notify_employee_uid("uid-a", "EmployeeA", **arguments)
    assert not boundary.calls


@pytest.mark.parametrize("login,text", [(" ", "正文"), ("e00042", " ")])
async def test_notify_employee_voice_rejects_empty_login_or_body_before_native(login, text):
    boundary = NativeBoundary()
    client = KairoClient(boundary, KairoAccessPolicy({}))
    with pytest.raises(ValueError):
        await client.notify_employee_voice(login, text, operation_id="voice")
    assert not boundary.calls


async def test_notify_employee_voice_normalizes_only_outer_login_spaces_and_checks_policy():
    boundary = NativeBoundary()
    config = {"enable_user_whitelist": True, "user_whitelist": ["e00042"]}
    client = KairoClient(boundary, KairoAccessPolicy(config))
    result = await client.notify_employee_voice(" e00042 ", " 原始正文 ", operation_id="voice")
    assert result["operationId"] == "voice"
    assert boundary.calls == [
        (
            "send_voice_to_user",
            {"login_name": "e00042", "text": " 原始正文 ", "operation_id": "voice"},
            90,
        )
    ]
    with pytest.raises(BridgeError) as error:
        await client.notify_employee_voice("E00042", "不得发送", operation_id="blocked")
    assert error.value.code == "ACCESS_DENIED" and len(boundary.sends) == 1


@pytest.mark.parametrize(
    "arguments",
    [
        {"name": " ", "text": "正文"},
        {"name": "张三", "text": " "},
        {"name": "张三", "text": "😀" * 64001},
        {"name": "张三", "text": "正文", "login_name": "EmployeeB"},
    ],
)
async def test_directed_voice_schema_rejects_before_search(arguments):
    boundary = NativeBoundary()
    result = await KairoSendVoiceTool(KairoNotifications()).call(
        wrap(make_event(boundary)), **arguments
    )
    assert "INVALID_ARGUMENT" in result and not boundary.calls


@pytest.mark.parametrize("code", ["TIMEOUT", "CONNECTION_LOST"])
async def test_directed_voice_transport_uncertainty_queries_same_operation_without_retry(code):
    boundary = NativeBoundary(error=BridgeError(code, "native acknowledgement missing"))
    client = KairoClient(boundary, KairoAccessPolicy({}))
    result = await client.notify_employee_voice(
        "EmployeeA", "原始正文", operation_id="stable-voice"
    )
    assert result["status"] == "unknown" and result["operationId"] == "stable-voice"
    assert result["code"] == code
    assert boundary.calls == [
        (
            "send_voice_to_user",
            {"login_name": "EmployeeA", "text": "原始正文", "operation_id": "stable-voice"},
            90,
        ),
        ("get_send_status", {"operation_id": "stable-voice"}, None),
    ]
    assert len(boundary.sends) == 1


@pytest.mark.parametrize("route", ["directed", "selected"])
@pytest.mark.parametrize("status", ["sent", "failed", "unknown"])
async def test_real_agent_voice_stops_only_after_native_confirmation(route, status):
    candidates = (
        [employee(), employee("uid-b", "张三", "EmployeeB")]
        if route == "selected"
        else [employee()]
    )
    boundary = NativeBoundary(candidates, status=status)
    manager = KairoNotifications()
    voice = KairoSendVoiceTool(manager)
    body = "  Agent 原始语音\n保留内容  "
    original_operation_id = None
    if route == "selected":
        source = make_event(boundary)
        listing = await voice.call(wrap(source), name="张三", text=body)
        assert "EmployeeA" in listing and "EmployeeB" in listing
        assert boundary.sends == []
        original_operation_id = source.get_extra(_ATTEMPTS_KEY)[voice.name]["operation_id"]
        boundary.employees.reverse()
        event = make_event(boundary, "选择第二个", message_id="agent-choice")
        tool, args = KairoSelectEmployeeTool(manager), {"choice": 2}
    else:
        event = make_event(boundary)
        tool, args = voice, {"name": "张三", "text": body}
    event.session_id = "rewritten-agent-context"
    event.unified_msg_origin = "other:GroupMessage:99999"
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
        assert status != "sent", "Confirmed voice must not ask the model to continue"
        tool_messages = [item for item in kwargs["contexts"] if item.role == "tool"]
        assert len(tool_messages) == 2
        for message in tool_messages:
            assert status in message.content
            assert "native result uncertain or rejected" in message.content
            assert boundary.sends[0]["operation_id"] in message.content
        return LLMResponse(role="assistant", completion_text="原生发送未确认，请核查原操作。")

    runner = ToolLoopAgentRunner()
    await runner.reset(
        provider=SimpleNamespace(provider_config={"id": "controlled-model"}, text_chat=text_chat),
        request=ProviderRequest(prompt="按要求发语音", func_tool=ToolSet([tool])),
        run_context=wrap(event),
        tool_executor=FunctionToolExecutor(),
        agent_hooks=BaseAgentRunHooks(),
    )
    async for _ in runner.step_until_done(max_step=3):
        pass
    assert runner.state == AgentState.DONE
    assert model_calls == (1 if status == "sent" else 2)
    assert len(boundary.sends) == 1
    sent = boundary.sends[0]
    assert sent["text"] == body
    assert event.get_extra(_ATTEMPTS_KEY)[tool.name]["operation_id"] == sent["operation_id"]
    assert sent["login_name"] == ("EmployeeB" if route == "selected" else "EmployeeA")
    assert "target_session_id" not in sent and "kind" not in sent
    if original_operation_id is not None:
        assert sent["operation_id"] == original_operation_id
    status_calls = [call for call in boundary.calls if call[0] == "get_send_status"]
    assert len(status_calls) == int(status == "unknown")
    if status_calls:
        assert status_calls[0][1] == {"operation_id": sent["operation_id"]}
    assert event._has_send_oper == (status == "sent")
    assert event.get_result() is None and not event.is_stopped()


@pytest.mark.parametrize("directed_first", [False, True])
@pytest.mark.parametrize("cancel_original", [False, True])
async def test_current_and_directed_voice_cancellation_retains_first_intent(
    directed_first, cancel_original
):
    boundary = NativeBoundary(block_send=True)
    manager = KairoNotifications()
    voice = KairoSendVoiceTool(manager)
    event = make_event(boundary)
    first_args = {"text": "首次正文", **({"name": "张三"} if directed_first else {})}
    changed_route = {"text": "不能替换原文", **({} if directed_first else {"name": "张三"})}
    original = asyncio.create_task(voice.call(wrap(event), **first_args))
    await asyncio.wait_for(boundary.started.wait(), 5)
    duplicate = asyncio.create_task(voice.call(wrap(event), **changed_route))
    await asyncio.sleep(0)
    canceled = original if cancel_original else duplicate
    canceled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await canceled
    if cancel_original:
        with pytest.raises(asyncio.CancelledError):
            await duplicate
        result = await voice.call(wrap(event), **changed_route)
        assert "unknown" in result and "不重发" in result
        assert f"operationId={boundary.sends[0]['operation_id']}" in result
    else:
        boundary.release.set()
        assert await original is None
        assert await voice.call(wrap(event), **changed_route) is None
    assert len(boundary.sends) == 1 and boundary.sends[0]["text"] == "首次正文"
    assert boundary.sends[0].get("login_name") == ("EmployeeA" if directed_first else None)
    assert boundary.sends[0].get("target_session_id") == (None if directed_first else "12345")
    assert [call[0] for call in boundary.calls].count("search_employees") == int(directed_first)
