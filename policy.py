"""Kairo 收发共用的准确工号与原生群会话名单。"""

from collections.abc import Mapping
from typing import Any

from .transport import BridgeError


class KairoAccessPolicy:
    """每次判定读取原配置，确保发送时再次应用当前规则。"""

    def __init__(self, platform_config: Mapping[str, Any]) -> None:
        self._config = platform_config

    def _rules(self, scope: str) -> tuple[set[str], set[str], bool]:
        lists = []
        for suffix in ("blacklist", "whitelist"):
            key = f"{scope}_{suffix}"
            values = self._config.get(key, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise TypeError(f"{key} 必须是字符串列表")
            lists.append({value.strip() for value in values if value.strip()})
        key = f"enable_{scope}_whitelist"
        enabled = self._config.get(key, False)
        if not isinstance(enabled, bool):
            raise TypeError(f"{key} 必须是布尔值")
        return lists[0], lists[1], enabled

    @property
    def requires_employee_identity(self) -> bool:
        blacklist, _, enabled = self._rules("user")
        return bool(blacklist) or enabled

    @property
    def requires_group_identity(self) -> bool:
        blacklist, _, enabled = self._rules("group")
        return bool(blacklist) or enabled

    def check_employee(self, login_name: str) -> None:
        blacklist, whitelist, enabled = self._rules("user")
        login_name = login_name.strip()
        if login_name in blacklist:
            raise BridgeError("ACCESS_DENIED", f"工号“{login_name}”在员工黑名单中")
        if enabled and login_name not in whitelist:
            raise BridgeError("ACCESS_DENIED", f"工号“{login_name}”不在启用的员工白名单中")

    def check_group(self, native_session_id: str) -> None:
        blacklist, whitelist, enabled = self._rules("group")
        native_session_id = native_session_id.strip()
        if native_session_id in blacklist:
            raise BridgeError("ACCESS_DENIED", f"群会话“{native_session_id}”在群黑名单中")
        if enabled and native_session_id not in whitelist:
            raise BridgeError("ACCESS_DENIED", f"群会话“{native_session_id}”不在启用的群白名单中")
