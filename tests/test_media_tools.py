"""图片文件工具使用真实宿主事件、名单及附件快照，仅替换原生发送边界。"""

import asyncio

import pytest
from astrbot.api.message_components import File, Image
from astrbot_plugin_kairo import tools as kairo_tools
from astrbot_plugin_kairo.notifications import KairoNotifications, KairoSelectEmployeeTool
from astrbot_plugin_kairo.transport import BridgeServer
from test_notifications import NativeBoundary, employee, make_event, wrap


class MediaBoundary(NativeBoundary):
    def __init__(self, root, employees=None, *, status="sent"):
        super().__init__(employees, status=status)
        self.payloads = []

        async def receive(_message):
            pass

        self.files = BridgeServer(
            token="m" * 32, expected_self_id="bot", on_event=receive, storage_dir=root / "files"
        )
        self.files.storage_dir.mkdir()

    async def add_file(self, path, name=None):
        return await self.files.add_file(path, name)

    async def request(self, action, params, *, timeout=None):
        if action == "get_sessions":
            return {"sessions": [{"id": "12345", "type": "group"}]}
        if action in {"send", "send_media_to_user"}:
            self.calls.append((action, dict(params), timeout))
            self.sends.append(dict(params))
            self.payloads.append(self.files.get_file_path(params["file_id"]).read_bytes())
            self.last_result = {
                "status": self.status,
                "operationId": params["operation_id"],
                "messageId": "native-media",
                "sessionId": "98765",
            }
            if self.status != "sent":
                self.last_result["error"] = "native receipt missing"
            return self.last_result
        return await super().request(action, params, timeout=timeout)


MEDIA_CASES = [("KairoSendImageTool", "image", Image), ("KairoSendFileTool", "file", File)]


def attach(event, path, component):
    item = (
        Image.fromFileSystem(str(path))
        if component is Image
        else File(name="原始报告.txt", file=str(path))
    )
    event.message_obj.message.append(item)
    return event


def tool_for(class_name, manager=None):
    return getattr(kairo_tools, class_name)(manager or KairoNotifications())


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
async def test_media_exact_name_pushes_original_bytes_to_employee_private_chat(
    tmp_path, class_name, kind, component
):
    boundary = MediaBoundary(tmp_path)
    source = tmp_path / "原始附件.bin"
    source.write_bytes(b"original media bytes\x00\xff")
    event = attach(make_event(boundary), source, component)
    result = await tool_for(class_name).call(wrap(event), name="张三")
    assert "sent" in result and "sessionId=98765" in result
    assert boundary.payloads == [source.read_bytes()]
    assert [(send["kind"], send["login_name"]) for send in boundary.sends] == [(kind, "EmployeeA")]
    assert "target_session_id" not in boundary.sends[0]
    if kind == "file":
        assert boundary.sends[0]["name"] == "原始报告.txt"


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
async def test_media_choice_uses_source_snapshot_not_changed_file_or_choice_attachment(
    tmp_path, class_name, kind, component
):
    boundary = MediaBoundary(tmp_path, [employee(), employee("uid-b", "张三", "EmployeeB")])
    manager = KairoNotifications()
    tool, choose = tool_for(class_name, manager), KairoSelectEmployeeTool(manager)
    source = tmp_path / "source.bin"
    source.write_bytes(b"original snapshot")
    listing = await tool.call(wrap(attach(make_event(boundary), source, component)), name="张三")
    assert "尚未发送" in listing and boundary.sends == []
    source.write_bytes(b"changed after listing")
    replacement = tmp_path / "choice.bin"
    replacement.write_bytes(b"not the selected source")
    choice_event = attach(make_event(boundary, "2", message_id="choice"), replacement, component)
    result = await choose.call(wrap(choice_event), choice=2)
    assert "sent" in result
    assert boundary.payloads == [b"original snapshot"]
    assert boundary.sends[0]["login_name"] == "EmployeeB"


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
async def test_media_without_name_stays_in_original_session_and_member_can_forward(
    tmp_path, class_name, kind, component
):
    boundary = MediaBoundary(tmp_path)
    source = tmp_path / "source.bin"
    source.write_bytes(b"member supplied attachment")
    event = attach(make_event(boundary, admin=False), source, component)
    event.session_id = "rewritten-context"
    assert await tool_for(class_name).call(wrap(event)) is None
    assert boundary.payloads == [b"member supplied attachment"]
    assert boundary.sends[0]["target_session_id"] == "12345"
    assert all(call[0] != "search_employees" for call in boundary.calls)


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
@pytest.mark.parametrize("arguments", [{"name": "张三"}, {"path": "private-host-file"}])
async def test_member_cannot_direct_media_or_read_arbitrary_host_path(
    tmp_path, class_name, kind, component, arguments
):
    boundary = MediaBoundary(tmp_path)
    result = await tool_for(class_name).call(wrap(make_event(boundary, admin=False)), **arguments)
    assert "ACCESS_DENIED" in result
    assert boundary.calls == [] and list(boundary.files.storage_dir.iterdir()) == []


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
async def test_admin_can_send_existing_local_media_without_chat_attachment(
    tmp_path, class_name, kind, component
):
    boundary = MediaBoundary(tmp_path)
    source = tmp_path / "生成的报告.txt"
    source.write_bytes(b"generated asset")
    result = await tool_for(class_name).call(
        wrap(make_event(boundary)), name="张三", path=str(source)
    )
    assert "sent" in result
    assert boundary.payloads == [b"generated asset"]
    assert boundary.sends[0]["name"] == source.name


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
@pytest.mark.parametrize("failure", ["identity", "policy", "unknown"])
async def test_media_selection_rechecks_recipient_and_does_not_replay(
    tmp_path, class_name, kind, component, failure
):
    boundary = MediaBoundary(
        tmp_path,
        [employee(), employee("uid-b", "张三", "EmployeeB")],
        status="unknown" if failure == "unknown" else "sent",
    )
    manager = KairoNotifications()
    tool, choose = tool_for(class_name, manager), KairoSelectEmployeeTool(manager)
    source = tmp_path / "source.bin"
    source.write_bytes(b"original")
    config = {}
    await tool.call(
        wrap(attach(make_event(boundary, config=config), source, component)), name="张三"
    )
    if failure == "identity":
        boundary.profiles["uid-b"]["loginName"] = "Changed"
    if failure == "policy":
        config["user_blacklist"] = ["EmployeeB"]
    event = make_event(boundary, "2", message_id="choice", config=config)
    result = await choose.call(wrap(event), choice=2)
    assert {"identity": "IDENTITY_CHANGED", "policy": "ACCESS_DENIED", "unknown": "unknown"}[
        failure
    ] in result
    assert await choose.call(wrap(event), choice=2) == result
    await choose.call(wrap(make_event(boundary, "2", message_id="retry", config=config)), choice=2)
    assert len(boundary.sends) == (1 if failure == "unknown" else 0)


@pytest.mark.parametrize(
    "arguments",
    [
        {"attachment_index": True},
        {"attachment_index": 0},
        {"attachment_index": 2},
        {"path": "missing", "attachment_index": 1},
        {"path": "missing"},
        {"path": "https://example.org/a.png"},
    ],
)
async def test_invalid_or_unavailable_media_does_not_search_or_send(tmp_path, arguments):
    boundary = MediaBoundary(tmp_path)
    result = await tool_for("KairoSendImageTool").call(
        wrap(make_event(boundary)), name="张三", **arguments
    )
    assert "错误" in result
    assert boundary.calls == [] and boundary.sends == []


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
async def test_duplicate_media_calls_share_snapshot_and_first_route(
    tmp_path, class_name, kind, component
):
    boundary = MediaBoundary(tmp_path)
    source = tmp_path / "source.bin"
    source.write_bytes(b"once")
    event = attach(make_event(boundary), source, component)
    tool = tool_for(class_name)
    first, duplicate = await asyncio.gather(
        tool.call(wrap(event), name="张三"), tool.call(wrap(event), name="张三")
    )
    assert first == duplicate and "sent" in first
    assert await tool.call(wrap(event)) == first
    assert boundary.payloads == [b"once"]
    assert len(list(boundary.files.storage_dir.iterdir())) == 1


@pytest.mark.parametrize("class_name,kind,component", MEDIA_CASES)
async def test_attachment_index_counts_only_requested_media_type(
    tmp_path, class_name, kind, component
):
    boundary = MediaBoundary(tmp_path)
    first, second = tmp_path / "first.bin", tmp_path / "second.bin"
    first.write_bytes(b"first attachment")
    second.write_bytes(b"selected second attachment")
    event = attach(make_event(boundary), first, component)
    attach(event, first, File if component is Image else Image)
    attach(event, second, component)
    result = await tool_for(class_name).call(wrap(event), name="张三", attachment_index=2)
    assert "sent" in result
    assert boundary.payloads == [b"selected second attachment"]
