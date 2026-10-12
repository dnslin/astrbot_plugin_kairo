"""共享员工/群规则的优先级、准确身份及运行时变更。"""

import pytest
from astrbot_plugin_kairo.policy import KairoAccessPolicy
from astrbot_plugin_kairo.transport import BridgeError


@pytest.mark.parametrize("scope,identity", [("user", "EmployeeA"), ("group", "12345")])
def test_blacklist_overrides_whitelist(scope, identity):
    policy = KairoAccessPolicy(
        {
            f"{scope}_blacklist": [identity],
            f"{scope}_whitelist": [identity],
            f"enable_{scope}_whitelist": True,
        }
    )
    check = policy.check_employee if scope == "user" else policy.check_group
    with pytest.raises(BridgeError, match="黑名单") as error:
        check(identity)
    assert error.value.code == "ACCESS_DENIED"


@pytest.mark.parametrize("scope,identity", [("user", "EmployeeA"), ("group", "12345")])
def test_enabled_empty_whitelist_denies_everyone(scope, identity):
    policy = KairoAccessPolicy({f"enable_{scope}_whitelist": True})
    check = policy.check_employee if scope == "user" else policy.check_group
    with pytest.raises(BridgeError, match="白名单"):
        check(identity)


@pytest.mark.parametrize("scope,identity", [("user", "EmployeeA"), ("group", "12345")])
def test_disabled_whitelist_does_not_restrict(scope, identity):
    policy = KairoAccessPolicy({f"{scope}_whitelist": ["someone-else"]})
    check = policy.check_employee if scope == "user" else policy.check_group
    check(identity)


def test_employee_identity_trims_without_case_folding():
    policy = KairoAccessPolicy({"enable_user_whitelist": True, "user_whitelist": ["  EmployeeA  "]})
    policy.check_employee(" EmployeeA ")
    with pytest.raises(BridgeError):
        policy.check_employee("employeea")


def test_rules_recheck_the_original_config_after_mutations():
    config = {"user_blacklist": [], "group_blacklist": []}
    policy = KairoAccessPolicy(config)
    assert not policy.requires_employee_identity
    assert not policy.requires_group_identity
    policy.check_employee("EmployeeA")
    policy.check_group("12345")

    config["user_blacklist"].append("EmployeeA")
    config["group_blacklist"].append("12345")
    assert policy.requires_employee_identity
    assert policy.requires_group_identity
    with pytest.raises(BridgeError):
        policy.check_employee("EmployeeA")
    with pytest.raises(BridgeError):
        policy.check_group("12345")

    config["user_blacklist"] = []
    config["group_blacklist"] = []
    config["enable_user_whitelist"] = True
    config["enable_group_whitelist"] = True
    assert policy.requires_employee_identity
    assert policy.requires_group_identity
    with pytest.raises(BridgeError):
        policy.check_employee("EmployeeA")
    with pytest.raises(BridgeError):
        policy.check_group("12345")

    config["enable_user_whitelist"] = False
    config["enable_group_whitelist"] = False
    policy.check_employee("EmployeeA")
    policy.check_group("12345")


def test_disabled_employee_whitelist_does_not_require_profile_lookup():
    policy = KairoAccessPolicy({"user_whitelist": ["EmployeeA"]})
    assert not policy.requires_employee_identity


@pytest.mark.parametrize(
    "config",
    [
        {"user_blacklist": "EmployeeA"},
        {"user_blacklist": [123]},
        {"enable_user_whitelist": "false"},
        {"user_whitelist": None},
    ],
)
def test_invalid_employee_config_is_not_silently_ignored(config):
    with pytest.raises(TypeError):
        KairoAccessPolicy(config).check_employee("EmployeeA")


def test_group_and_employee_rules_do_not_leak_into_each_other():
    policy = KairoAccessPolicy({"user_blacklist": ["EmployeeA"], "group_blacklist": ["12345"]})
    policy.check_group("67890")
    policy.check_employee("EmployeeB")
    with pytest.raises(BridgeError):
        policy.check_group("12345")
    with pytest.raises(BridgeError):
        policy.check_employee("EmployeeA")


@pytest.mark.parametrize("scope,identity", [("user", "EmployeeA"), ("group", "12345")])
def test_enabled_whitelist_allows_only_exact_members(scope, identity):
    policy = KairoAccessPolicy(
        {f"enable_{scope}_whitelist": True, f"{scope}_whitelist": [identity]}
    )
    check = policy.check_employee if scope == "user" else policy.check_group
    check(identity)
    with pytest.raises(BridgeError, match="白名单") as error:
        check("67890" if scope == "group" else "EmployeeB")
    assert error.value.code == "ACCESS_DENIED"


def test_group_configuration_errors_remain_visible():
    config = {"group_blacklist": []}
    policy = KairoAccessPolicy(config)
    policy.check_group("12345")
    config["enable_group_whitelist"] = "true"
    with pytest.raises(TypeError, match="enable_group_whitelist"):
        policy.check_group("12345")
    with pytest.raises(TypeError, match="enable_group_whitelist"):
        _ = policy.requires_group_identity
