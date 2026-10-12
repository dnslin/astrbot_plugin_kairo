"""Kairo components through the actual host waking stage, not a reimplementation."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from astrbot.core.config.default import DEFAULT_CONFIG
from astrbot.core.pipeline.waking_check.stage import WakingCheckStage
from astrbot_plugin_kairo.adapter import KairoPlatformAdapter


@pytest.mark.parametrize(
    "changes,ignore_all,expected",
    [
        ({"atMe": True}, False, True),
        ({"mentions": {"mentionedUsers": ["100"]}}, False, True),
        ({"mentions": {"mentionedUsers": ["43"]}}, False, False),
        ({"atAll": True}, False, True),
        ({"mentions": {"mentionedUsers": ["-1"]}}, True, False),
        (
            {"replyTo": {"replyToId": "700", "replyToSenderId": "100", "replyToContent": "旧回复"}},
            False,
            True,
        ),
        ({"content": "/帮助"}, False, True),
        ({"content": "普通群消息"}, False, False),
    ],
)
async def test_native_mentions_quotes_and_prefixes_obey_host_wake_rules(
    tmp_path, monkeypatch, changes, ignore_all, expected
):
    monkeypatch.setattr("astrbot_plugin_kairo.adapter.StarTools.get_data_dir", lambda _: tmp_path)
    # Only unrelated session-setting storage is replaced; the waking algorithm
    # and Kairo conversion are real. No framework DB worker outlives the test loop.
    monkeypatch.setattr(
        "astrbot.core.star.session_plugin_manager.sp",
        SimpleNamespace(get_async=AsyncMock(return_value={})),
    )
    adapter = KairoPlatformAdapter(
        {"id": "kairo-test", "token": "x" * 32, "bot_uid": "100"}, {}, asyncio.Queue()
    )
    await adapter.on_event(
        {
            "id": "800",
            "sessionId": "793803",
            "sessionType": "group",
            "senderId": "42",
            "content": "你好",
            "direction": "inbound",
            **changes,
        }
    )
    event = adapter._event_queue.get_nowait()
    original_session = event.session_id
    config = deepcopy(DEFAULT_CONFIG)
    config.update({"admins_id": [], "wake_prefix": ["/"], "plugin_set": []})
    config["platform_settings"].update({"ignore_at_all": ignore_all, "unique_session": True})
    stage = WakingCheckStage()
    await stage.initialize(
        SimpleNamespace(astrbot_config=config, db_helper=None, astrbot_config_id="kairo-test")
    )
    await stage.process(event)
    assert event.is_at_or_wake_command is expected
    assert event.is_wake is expected
    # The host does not recognize Kairo for its own unique_session rewriting.
    assert event.session_id == original_session
    assert event.get_extra("_session_isolated") is False
