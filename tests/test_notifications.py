"""Employee notifications exercise real framework events, policy and client boundaries."""

import asyncio
from types import SimpleNamespace

import pytest
from astrbot.api.event import AstrMessageEvent
from astrbot.api.platform import PlatformMetadata
from astrbot.api.star import Context
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.astr_agent_context import AstrAgentContext
from astrbot_plugin_kairo.client import KairoClient
from astrbot_plugin_kairo.event import KairoMessageEvent
from astrbot_plugin_kairo.mapping import convert_message
from astrbot_plugin_kairo.notifications import (
    KairoNotifications,
    KairoNotifyEmployeeTool,
    KairoSelectEmployeeTool,
)
from astrbot_plugin_kairo.policy import KairoAccessPolicy
from astrbot_plugin_kairo.transport import BridgeError


def employee(uid="uid-a", name="张三", login="EmployeeA", departments=None):
    return {
        "id": uid,
        "name": name,
        "loginName": login,
        "departmentPaths": departments,
    }


class NativeBoundary:
    """Only the native request boundary is replaced; no client or policy mocks."""

    def __init__(self, employees=None, *, status="sent", error=None, block_send=False):
        self.employees = [employee()] if employees is None else employees
        self.profiles = {
            item["id"]: {"id": item["id"], "loginName": item["loginName"]}
            for item in self.employees
        }
        self.profiles["sender-a"] = {"id": "sender-a", "loginName": "SenderA"}
        self.search_results = {}
        self.search_gates = {}
        self.search_started = asyncio.Queue()
        self.status = status
        self.error = error
        self.calls = []
        self.sends = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        if not block_send:
            self.release.set()
        self.last_result = None

    async def request(self, action, params, *, timeout=None):
        self.calls.append((action, dict(params), timeout))
        if action == "search_employees":
            keyword = params["keyword"]
            self.search_started.put_nowait(keyword)
            if gate := self.search_gates.get(keyword):
                await gate.wait()
            result = self.search_results.get(
                keyword, {"employees": self.employees, "hasMore": False}
            )
            if isinstance(result, Exception):
                raise result
            return result
        if action == "get_user_profile":
            return {"profile": self.profiles.get(params["user_id"])}
        if action == "get_send_status":
            return self.last_result or {
                "status": "unknown",
                "operationId": params["operation_id"],
                "error": "native acknowledgement missing",
                "nativeCode": 408,
            }
        assert action == "send_to_user", f"unexpected native action: {action}"
        self.sends.append(dict(params))
        self.started.set()
        await self.release.wait()
        if self.error:
            raise self.error
        self.last_result = {
            "status": self.status,
            "operationId": params["operation_id"],
            "messageId": "native-message",
            "sessionId": "98765",
        }
        if self.status != "sent":
            self.last_result.update(error="native result uncertain or rejected", nativeCode=408)
        return self.last_result


def make_event(
    boundary,
    content="请通知张三开会",
    *,
    message_id="request-1",
    sender="sender-a",
    session="12345",
    platform="instance-a",
    name="kairo",
    native=True,
    admin=True,
    config=None,
    timestamp=None,
):
    data = {
        "direction": "inbound",
        "sessionId": session,
        "sessionType": "group",
        "messageId": message_id,
        "senderId": sender,
        "content": content,
    }
    if timestamp is not None:
        data["timestamp"] = timestamp
    message = convert_message(
        data, self_id="bot", isolate_group_users=True, get_file_path=lambda _: None
    )
    metadata = PlatformMetadata(name=name, description="test", id=platform)
    client = KairoClient(boundary, KairoAccessPolicy(config if config is not None else {}))
    adapter = SimpleNamespace(get_client=lambda: client)
    if native:
        event = KairoMessageEvent(message, metadata, adapter)
    else:
        event = AstrMessageEvent(message.message_str, message, metadata, message.session_id)
        event.adapter = adapter
        event.target_session_id = session
        event.sender_id = sender
    event.role = "admin" if admin else "member"
    return event


def wrap(event):
    context = Context.__new__(Context)
    context.platform_manager = SimpleNamespace(platform_insts=[])
    return ContextWrapper(AstrAgentContext(context=context, event=event))


def tools():
    manager = KairoNotifications()
    return KairoNotifyEmployeeTool(manager), KairoSelectEmployeeTool(manager)


@pytest.mark.parametrize("keyword", ["", "   "])
async def test_search_empty_keyword_does_not_reach_native_boundary(keyword):
    boundary = NativeBoundary()
    client = KairoClient(boundary, KairoAccessPolicy({}))
    with pytest.raises(ValueError):
        await client.search_employees(keyword)
    assert boundary.calls == []


@pytest.mark.parametrize(
    "response",
    [
        None,
        [],
        {},
        {"employees": [], "hasMore": True},
        {"employees": [], "hasMore": 0},
        {"employees": "not-a-list", "hasMore": False},
        {"employees": [None], "hasMore": False},
        {"employees": [{"id": "uid"}], "hasMore": False},
        {"employees": [employee(uid=42)], "hasMore": False},
        {"employees": [employee(uid=" ")], "hasMore": False},
        {"employees": [employee(name=42)], "hasMore": False},
        {"employees": [employee(login=42)], "hasMore": False},
        {"employees": [employee(departments="总部/研发")], "hasMore": False},
        {"employees": [employee(departments=[None])], "hasMore": False},
        {"employees": [employee(), employee()], "hasMore": False},
    ],
)
async def test_invalid_or_partial_search_never_becomes_a_unique_employee(response):
    boundary = NativeBoundary()
    boundary.search_results["张三"] = response
    notify, _ = tools()
    result = await notify.call(wrap(make_event(boundary)), name="张三", text="原始正文")
    assert "INVALID_RESPONSE" in result
    assert not boundary.sends
    assert [call[0] for call in boundary.calls] == ["search_employees"]


@pytest.mark.parametrize(
    "native,name,admin", [(False, "kairo", True), (True, "other", True), (True, "kairo", False)]
)
@pytest.mark.parametrize("select", [False, True])
async def test_native_admin_role_is_required_before_any_boundary_or_pending_access(
    native, name, admin, select
):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="原始正文")
    boundary.calls.clear()
    rejected = make_event(
        boundary, "2", message_id="choice-1", native=native, name=name, admin=admin
    )
    if select:
        result = await choose.call(wrap(rejected), choice=2)
    else:
        result = await notify.call(wrap(rejected), name="张三", text="管理员身份由模型声明")
    assert "错误" in result
    assert boundary.calls == []
    # An unauthorized call must not consume or replace the genuine admin's intent.
    await choose.call(wrap(make_event(boundary, "2", message_id="choice-2")), choice=2)
    assert [(send["login_name"], send["text"]) for send in boundary.sends] == [
        ("EmployeeB", "原始正文")
    ]


@pytest.mark.parametrize(
    "arguments",
    [
        {"name": " ", "text": "body"},
        {"name": "张三", "text": " "},
        {"name": "张三", "text": "😀" * 64001},
        {"name": "张三", "text": "body", "login_name": "EmployeeB"},
    ],
)
async def test_notify_schema_and_utf16_limits_reject_before_search(arguments):
    boundary = NativeBoundary()
    notify, _ = tools()
    result = await notify.call(wrap(make_event(boundary)), **arguments)
    assert "INVALID_ARGUMENT" in result
    assert boundary.calls == []


async def test_sole_exact_name_sends_preserved_body_to_verified_uid_and_case_sensitive_login():
    boundary = NativeBoundary()
    notify, _ = tools()
    body = "  开会\n保留原始正文  "
    result = await notify.call(wrap(make_event(boundary)), name=" 张三 ", text=body)
    assert boundary.sends[0]["login_name"] == "EmployeeA"
    assert boundary.sends[0]["text"] == body
    assert "sent" in result
    assert f"operationId={boundary.sends[0]['operation_id']}" in result


@pytest.mark.parametrize(
    "candidates", [[employee(name="张三丰")], [employee(), employee("uid-b", "张三", "EmployeeB")]]
)
async def test_fuzzy_or_ambiguous_names_wait_for_real_next_message(candidates):
    boundary = NativeBoundary(candidates)
    notify, choose = tools()
    origin = make_event(boundary)
    result = await notify.call(wrap(origin), name="张三", text="原始正文")
    assert not boundary.sends
    for i, candidate in enumerate(candidates, 1):
        assert str(i) in result and candidate["name"] in result and candidate["loginName"] in result
    # Calling selection immediately in the originating event is not confirmation.
    immediate = await choose.call(wrap(origin), choice=1)
    assert "错误" in immediate
    assert not boundary.sends
    await choose.call(wrap(make_event(boundary, "1", message_id="choice-1")), choice=1)
    assert boundary.sends[0]["text"] == "原始正文"


async def test_candidate_list_displays_every_candidate_login_and_all_department_paths():
    candidates = [
        employee(str(i), f"候选{i}", f"Login{i}", [f"总部/组{i}", f"分部/组{i}"])
        for i in range(101)
    ]
    candidates.append(employee("missing", None, None, None))
    boundary = NativeBoundary(candidates)
    notify, _ = tools()
    result = await notify.call(wrap(make_event(boundary)), name="候选", text="body")
    for i, candidate in enumerate(candidates, 1):
        assert f"{i}." in result
        if candidate["loginName"]:
            assert candidate["loginName"] in result
            assert all(path in result for path in candidate["departmentPaths"])
    assert "工号未提供" in result and "部门未提供" in result
    assert not boundary.sends


async def test_no_match_replaces_previous_pending_and_cannot_send():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="旧正文")
    boundary.employees = []
    await notify.call(
        wrap(make_event(boundary, message_id="request-2")), name="不存在", text="新正文"
    )
    result = await choose.call(wrap(make_event(boundary, "1", message_id="choice-1")), choice=1)
    assert "错误" in result and not boundary.sends


@pytest.mark.parametrize("login", [None, "", "   "])
@pytest.mark.parametrize("exact", [False, True])
async def test_missing_login_never_substitutes_uid_or_sends(login, exact):
    boundary = NativeBoundary([employee(name="张三" if exact else "张三丰", login=login)])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    result = await choose.call(wrap(make_event(boundary, "1", message_id="choice-1")), choice=1)
    assert "错误" in result
    assert not boundary.sends
    assert all(call[0] != "send_to_user" for call in boundary.calls)


async def test_duplicate_names_select_by_ordered_uid_and_original_body():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB", ["总部/研发"])])
    notify, choose = tools()
    source = make_event(boundary)
    source.session_id = "rewritten-search-context"
    source.unified_msg_origin = "other:GroupMessage:9999"
    await notify.call(wrap(source), name="张三", text="第一条原文")
    # A later directory reorder must not change the presented numbered mapping.
    boundary.employees.reverse()
    selection = make_event(boundary, "选择第二个", message_id="choice-1")
    selection.session_id = "different-context"
    selection.unified_msg_origin = "untrusted:GroupMessage:1"
    await choose.call(wrap(selection), choice=2)
    assert [(item["login_name"], item["text"]) for item in boundary.sends] == [
        ("EmployeeB", "第一条原文")
    ]


@pytest.mark.parametrize(
    "other", [{"sender": "other-user"}, {"session": "54321"}, {"platform": "instance-b"}]
)
async def test_selection_is_isolated_by_native_sender_session_and_platform(other):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    result = await choose.call(
        wrap(make_event(boundary, "2", message_id="wrong-scope", **other)), choice=2
    )
    assert "错误" in result and not boundary.sends
    await choose.call(wrap(make_event(boundary, "2", message_id="right-scope")), choice=2)
    assert len(boundary.sends) == 1


@pytest.mark.parametrize(
    "content,choice",
    [
        ("1", 1),
        ("选2", 2),
        ("选择 2", 2),
        ("第一个", 1),
        ("选择第二个", 2),
        ("二", 2),
        ("选两位", 2),
        ("请选第十一位", 11),
        ("二十", 20),
    ],
)
async def test_explicit_numeric_user_selection_forms(content, choice):
    boundary = NativeBoundary([employee(str(i), "同名", f"Login{i}") for i in range(1, 21)])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="同名", text="body")
    await choose.call(wrap(make_event(boundary, content, message_id="choice-1")), choice=choice)
    assert boundary.sends[0]["login_name"] == f"Login{choice}"


@pytest.mark.parametrize(
    "content,choice",
    [
        ("你好", 1),
        ("请通知张三", 1),
        ("1 或 2", 1),
        ("2", 1),
        ("别选2", 2),
        ("选2然后修改正文", 2),
        ("0", 0),
        ("3", 3),
    ],
)
async def test_model_invented_mismatching_or_out_of_range_choices_do_not_consume_pending(
    content, choice
):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    result = await choose.call(
        wrap(make_event(boundary, content, message_id="wrong-choice")), choice=choice
    )
    assert "错误" in result and not boundary.sends
    await choose.call(wrap(make_event(boundary, "2", message_id="valid-choice")), choice=2)
    assert boundary.sends[0]["login_name"] == "EmployeeB"


async def test_selection_reads_raw_native_message_not_rewritten_model_context():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    event = make_event(boundary, "不做选择", message_id="choice-1")
    event.message_str = "2"
    event.message_obj.message_str = "2"
    assert "错误" in await choose.call(wrap(event), choice=2)
    assert not boundary.sends


async def test_next_message_can_select_when_host_wall_clock_times_are_equal():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    source = make_event(boundary)
    await notify.call(wrap(source), name="张三", text="原始正文")
    selection = make_event(boundary, "2", message_id="choice-1")
    selection.created_at = source.created_at
    result = await choose.call(wrap(selection), choice=2)
    assert "sent" in result
    assert [(item["login_name"], item["text"]) for item in boundary.sends] == [
        ("EmployeeB", "原始正文")
    ]


async def test_stale_selection_created_before_new_candidates_is_rejected():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="旧正文")
    stale = make_event(boundary, "1", message_id="stale-choice")
    await notify.call(
        wrap(make_event(boundary, message_id="request-2")), name="张三", text="新正文"
    )
    assert "错误" in await choose.call(wrap(stale), choice=1)
    assert not boundary.sends
    await choose.call(wrap(make_event(boundary, "2", message_id="new-choice")), choice=2)
    assert boundary.sends[0]["text"] == "新正文"


async def test_delayed_older_native_message_timestamp_cannot_select_new_candidates():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary, timestamp=2000)), name="张三", text="body")
    result = await choose.call(
        wrap(make_event(boundary, "1", message_id="old", timestamp=1000)), choice=1
    )
    assert "错误" in result and not boundary.sends


@pytest.mark.parametrize(
    "profile,code",
    [
        (None, "IDENTITY_UNAVAILABLE"),
        ({"id": "uid-b", "loginName": None}, "IDENTITY_UNAVAILABLE"),
        ({"id": "uid-b", "loginName": "employeeb"}, "IDENTITY_CHANGED"),
        ({"id": "other-uid", "loginName": "EmployeeB"}, "IDENTITY_CHANGED"),
        ({"loginName": "EmployeeB"}, "IDENTITY_UNAVAILABLE"),
    ],
)
async def test_selected_uid_and_login_snapshot_are_freshly_checked_before_send(profile, code):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    boundary.profiles["uid-b"] = profile
    result = await choose.call(wrap(make_event(boundary, "2", message_id="choice-1")), choice=2)
    assert code in result and "operationId=" in result
    assert not boundary.sends
    # Identity failure consumed the intent; fixing the profile cannot replay it.
    boundary.profiles["uid-b"] = {"id": "uid-b", "loginName": "EmployeeB"}
    await choose.call(wrap(make_event(boundary, "2", message_id="choice-2")), choice=2)
    assert not boundary.sends


async def test_current_employee_policy_is_applied_after_selection():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    config = {}
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary, config=config)), name="张三", text="body")
    config["user_blacklist"] = ["EmployeeB"]
    result = await choose.call(
        wrap(make_event(boundary, "2", message_id="choice-1", config=config)), choice=2
    )
    assert "ACCESS_DENIED" in result and not boundary.sends


@pytest.mark.parametrize("rules", [{"user_blacklist": ["SenderA"]}, {"group_blacklist": ["12345"]}])
async def test_originating_actor_or_group_policy_blocks_search_and_preserves_pending(rules):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    config = {}
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary, config=config)), name="张三", text="原始正文")
    config.update(rules)
    denied = await notify.call(
        wrap(make_event(boundary, message_id="denied-request", config=config)),
        name="新名字",
        text="禁止的新正文",
    )
    assert "ACCESS_DENIED" in denied
    denied_choice = await choose.call(
        wrap(make_event(boundary, "2", message_id="denied-choice", config=config)), choice=2
    )
    assert "ACCESS_DENIED" in denied_choice
    assert [call[1]["keyword"] for call in boundary.calls if call[0] == "search_employees"] == [
        "张三"
    ]
    assert not boundary.sends
    config.clear()
    await choose.call(
        wrap(make_event(boundary, "2", message_id="allowed-choice", config=config)), choice=2
    )
    assert boundary.sends[0]["text"] == "原始正文"


@pytest.mark.parametrize("rules", [{"user_blacklist": ["SenderA"]}, {"group_blacklist": ["12345"]}])
async def test_originating_policy_is_rechecked_after_search_before_auto_send(rules):
    boundary = NativeBoundary()
    boundary.search_gates["张三"] = asyncio.Event()
    config = {}
    notify, choose = tools()
    pending = asyncio.create_task(
        notify.call(wrap(make_event(boundary, config=config)), name="张三", text="body")
    )
    assert await asyncio.wait_for(boundary.search_started.get(), 5) == "张三"
    config.update(rules)
    boundary.search_gates["张三"].set()
    result = await pending
    assert "ACCESS_DENIED" in result and not boundary.sends
    config.clear()
    await choose.call(
        wrap(make_event(boundary, "1", message_id="later-choice", config=config)), choice=1
    )
    assert not boundary.sends


@pytest.mark.parametrize("select", [False, True])
async def test_duplicate_concurrent_and_repeated_event_attempts_submit_once(select):
    candidates = [employee(), employee("uid-b", "张三", "EmployeeB")] if select else [employee()]
    boundary = NativeBoundary(candidates, block_send=True)
    manager = KairoNotifications()
    notify, choose = KairoNotifyEmployeeTool(manager), KairoSelectEmployeeTool(manager)
    if select:
        await notify.call(wrap(make_event(boundary)), name="张三", text="body")
        event = make_event(boundary, "2", message_id="choice-1")
        tool, args = choose, {"choice": 2}
    else:
        event, tool, args = make_event(boundary), notify, {"name": "张三", "text": "body"}
    first = asyncio.create_task(tool.call(wrap(event), **args))
    await asyncio.wait_for(boundary.started.wait(), 5)
    second = asyncio.create_task(type(tool)(manager).call(wrap(event), **args))
    await asyncio.sleep(0)
    assert len(boundary.sends) == 1
    boundary.release.set()
    results = await asyncio.gather(first, second)
    assert results[0] == results[1]
    assert await tool.call(wrap(event), **args) == results[0]
    assert len(boundary.sends) == 1


async def test_distinct_selection_events_cannot_race_the_same_pending_send():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")], block_send=True)
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    first = asyncio.create_task(
        choose.call(wrap(make_event(boundary, "2", message_id="choice-1")), choice=2)
    )
    await asyncio.wait_for(boundary.started.wait(), 5)
    second = await choose.call(wrap(make_event(boundary, "2", message_id="choice-2")), choice=2)
    assert "错误" in second and len(boundary.sends) == 1
    boundary.release.set()
    await first


async def test_canceling_duplicate_waiter_does_not_cancel_original_native_attempt():
    boundary = NativeBoundary(block_send=True)
    notify, _ = tools()
    event = make_event(boundary)
    first = asyncio.create_task(notify.call(wrap(event), name="张三", text="body"))
    await asyncio.wait_for(boundary.started.wait(), 5)
    duplicate = asyncio.create_task(notify.call(wrap(event), name="张三", text="body"))
    await asyncio.sleep(0)
    duplicate.cancel()
    with pytest.raises(asyncio.CancelledError):
        await duplicate
    boundary.release.set()
    assert "sent" in await first
    assert len(boundary.sends) == 1


@pytest.mark.parametrize("select", [False, True])
async def test_canceled_original_attempt_is_unknown_and_never_retried(select):
    candidates = [employee(), employee("uid-b", "张三", "EmployeeB")] if select else [employee()]
    boundary = NativeBoundary(candidates, block_send=True)
    notify, choose = tools()
    if select:
        await notify.call(wrap(make_event(boundary)), name="张三", text="body")
        event = make_event(boundary, "2", message_id="choice-1")
        tool, args = choose, {"choice": 2}
    else:
        event, tool, args = make_event(boundary), notify, {"name": "张三", "text": "body"}
    first = asyncio.create_task(tool.call(wrap(event), **args))
    await asyncio.wait_for(boundary.started.wait(), 5)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    result = await tool.call(wrap(event), **args)
    assert "unknown" in result
    assert boundary.sends[0]["operation_id"] in result
    await choose.call(wrap(make_event(boundary, "2", message_id="another-choice")), choice=2)
    assert len(boundary.sends) == 1


@pytest.mark.parametrize(
    "status,error",
    [
        ("unknown", None),
        ("failed", None),
        ("unknown", BridgeError("TIMEOUT", "native acknowledgement timed out")),
        (
            "failed",
            BridgeError(
                "NATIVE_REJECTED",
                "native rejected",
                result={
                    "status": "failed",
                    "operationId": "native-op",
                    "nativeCode": 403,
                    "error": "rejected",
                },
            ),
        ),
    ],
)
async def test_uncertain_failed_and_timeout_outcomes_preserve_diagnostics_without_resend(
    status, error
):
    boundary = NativeBoundary(status=status, error=error)
    notify, choose = tools()
    event = make_event(boundary)
    result = await notify.call(wrap(event), name="张三", text="body")
    assert ("unknown" if status == "unknown" else "failed") in result
    assert "nativeCode=" in result and "operationId=" in result
    if error:
        assert error.code in result
    if error and error.code != "TIMEOUT":
        assert error.code in result and "native-op" in result and "403" in result
    else:
        assert boundary.sends[0]["operation_id"] in result
    assert await notify.call(wrap(event), name="张三", text="different retry body") == result
    await choose.call(wrap(make_event(boundary, "1", message_id="choice-1")), choice=1)
    assert len(boundary.sends) == 1


@pytest.mark.parametrize("older_exact", [False, True])
async def test_older_inflight_search_cannot_send_or_replace_newer_pending(older_exact):
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    old_candidates = (
        [employee(name="旧名")]
        if older_exact
        else [employee(name="旧名甲"), employee("uid-b", "旧名乙", "EmployeeB")]
    )
    boundary.search_results["旧名"] = {"employees": old_candidates, "hasMore": False}
    boundary.search_gates["旧名"] = asyncio.Event()
    notify, choose = tools()
    old = asyncio.create_task(notify.call(wrap(make_event(boundary)), name="旧名", text="旧正文"))
    assert await asyncio.wait_for(boundary.search_started.get(), 5) == "旧名"
    await notify.call(
        wrap(make_event(boundary, message_id="request-2")), name="张三", text="新正文"
    )
    boundary.search_gates["旧名"].set()
    await old
    assert not boundary.sends
    await choose.call(wrap(make_event(boundary, "2", message_id="choice-1")), choice=2)
    assert [(item["login_name"], item["text"]) for item in boundary.sends] == [
        ("EmployeeB", "新正文")
    ]


async def test_new_search_invalidates_previous_choices_before_its_response_arrives():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="旧正文")
    boundary.search_gates["新名"] = asyncio.Event()
    newer = asyncio.create_task(
        notify.call(wrap(make_event(boundary, message_id="request-2")), name="新名", text="新正文")
    )
    await asyncio.wait_for(boundary.search_started.get(), 5)
    assert await asyncio.wait_for(boundary.search_started.get(), 5) == "新名"
    result = await choose.call(
        wrap(make_event(boundary, "2", message_id="premature-choice")), choice=2
    )
    assert "错误" in result and not boundary.sends
    boundary.search_gates["新名"].set()
    await newer
    await choose.call(wrap(make_event(boundary, "2", message_id="valid-choice")), choice=2)
    assert boundary.sends[0]["text"] == "新正文"


@pytest.mark.parametrize("same_object", [False, True])
async def test_numeric_origin_message_itself_cannot_select_its_own_candidates(same_object):
    boundary = NativeBoundary([employee(name="张三丰")])
    notify, choose = tools()
    source = make_event(boundary, "1")
    await notify.call(wrap(source), name="张三", text="body")
    selection = source if same_object else make_event(boundary, "1")
    result = await choose.call(wrap(selection), choice=1)
    assert "错误" in result and not boundary.sends
    await choose.call(wrap(make_event(boundary, "1", message_id="next-choice")), choice=1)
    assert len(boundary.sends) == 1


@pytest.mark.parametrize(
    "arguments",
    [
        {"choice": True},
        {"choice": 1.5},
        {"choice": 1, "login_name": "EmployeeA"},
        {"choice": 1, "session": "99999"},
    ],
)
async def test_selection_schema_cannot_supply_identity_or_routing(arguments):
    boundary = NativeBoundary([employee(name="张三丰")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="body")
    result = await choose.call(
        wrap(make_event(boundary, "1", message_id="invalid-choice")), **arguments
    )
    assert "INVALID_ARGUMENT" in result and not boundary.sends
    await choose.call(wrap(make_event(boundary, "1", message_id="valid-choice")), choice=1)
    assert boundary.sends[0]["login_name"] == "EmployeeA"


async def test_two_notification_tool_types_cannot_submit_twice_on_one_native_event():
    boundary = NativeBoundary([employee(), employee("uid-b", "张三", "EmployeeB")])
    notify, choose = tools()
    await notify.call(wrap(make_event(boundary)), name="张三", text="原始正文")
    selection = make_event(boundary, "2", message_id="choice-1")
    await choose.call(wrap(selection), choice=2)
    boundary.employees = [employee()]
    await notify.call(wrap(selection), name="张三", text="模型追加的正文")
    assert [(item["login_name"], item["text"]) for item in boundary.sends] == [
        ("EmployeeB", "原始正文")
    ]


async def test_slow_older_actor_policy_lookup_cannot_resurrect_completed_newer_intent():
    class SlowActorBoundary(NativeBoundary):
        def __init__(self):
            super().__init__()
            self.actor_started = asyncio.Event()
            self.actor_release = asyncio.Event()

        async def request(self, action, params, *, timeout=None):
            if (
                action == "get_user_profile"
                and params["user_id"] == "sender-a"
                and not self.actor_started.is_set()
            ):
                self.actor_started.set()
                await self.actor_release.wait()
            return await super().request(action, params, timeout=timeout)

    boundary = SlowActorBoundary()
    config = {"user_blacklist": ["UnrelatedEmployee"]}
    notify, _ = tools()
    older = asyncio.create_task(
        notify.call(wrap(make_event(boundary, config=config)), name="张三", text="旧正文")
    )
    await asyncio.wait_for(boundary.actor_started.wait(), 5)
    await notify.call(
        wrap(make_event(boundary, message_id="request-2", config=config)),
        name="张三",
        text="新正文",
    )
    boundary.actor_release.set()
    await older
    assert [item["text"] for item in boundary.sends] == ["新正文"]
