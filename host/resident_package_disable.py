"""Disable startup for one recovered resident Buddy installation."""

import os
import time

from resident_package_recovery import BUDDY, HELPER, UNIT_DIR, PackageRecovery, json_record, require
from resident_package_transition import (
    RecoveryPending, intent_path, load_intent, on_wire, recovered_with_ownership, write_private_record,
)
import wired_observer as shared


STARTUP_LINK = f"/etc/systemd/system/multi-user.target.wants/{BUDDY}"
PACKAGE_UNIT = f"{UNIT_DIR}/{BUDDY}"
DISABLE_COMMAND = (
    f'test ! -e /etc/systemd/system/{BUDDY} && test ! -L /etc/systemd/system/{BUDDY} && '
    f'test -L {STARTUP_LINK} && test "$(readlink {STARTUP_LINK})" = {PACKAGE_UNIT} && '
    f'/bin/systemctl --system --no-pager --no-ask-password --quiet disable -- {BUDDY}'
)


def disable_path(config, boot, activation):
    return intent_path(config, boot, activation).with_name(f"resident-disable-{boot}-{activation}.json")


def observe_disabled(recovery, expected, version, stop, plan, stock):
    require(recovery.unit_file_state(BUDDY) == b"disabled\n"
            and recovery.unit_file_state(HELPER) == b"static\n")
    recovery.read(f"test ! -e {STARTUP_LINK} && test ! -L {STARTUP_LINK}", 32)
    recovery.observe_disabled_recovery(expected, stock)
    result = recovered_with_ownership(recovery, stock, version, stop["ownership"], plan)
    require(recovery.unit_file_state(BUDDY) == b"disabled\n"
            and recovery.unit_file_state(HELPER) == b"static\n")
    return {**result, "disabled": True}


def execute(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Disable the exact package after recovery, with a separate durable intent."""
    expected, stop, plan = load_intent(config, connection, boot, activation, profile_sha256, approved_version)
    require(stop["version"] in (2, 3))
    path = disable_path(config, boot, activation)
    if os.path.lexists(path):
        raise RecoveryPending("Disable intent is already retained")
    started = False

    def inspect(transport):
        nonlocal started
        recovery = PackageRecovery(transport, deadline)
        stock = recovery.observe_recovery(expected)
        recovered_with_ownership(recovery, stock, approved_version, stop["ownership"], plan)
        state = recovery.unit_file_state(BUDDY)
        require(recovery.unit_file_state(HELPER) == b"static\n")
        if state == b"enabled\n":
            require(recovery.read(f"readlink {STARTUP_LINK}", 256) == (PACKAGE_UNIT + "\n").encode("ascii"))
            require(time.monotonic() < deadline)
            write_private_record(path, {"version": 1, "stop": stop, "stock": stock})
            started = True
            require(recovery.read(DISABLE_COMMAND, 1024) == b"")
        else:
            require(state == b"disabled\n")
        return observe_disabled(recovery, expected, approved_version, stop, plan, stock)

    try:
        return on_wire(config, inspect, connection)
    except Exception as error:
        if started:
            raise RecoveryPending("Buddy disable outcome requires read-only reconciliation") from error
        raise


def retained_stock(config, boot, activation, stop):
    raw = shared.private_bytes(disable_path(config, boot, activation), parent_private=True, maximum=2048)
    record = json_record(raw)
    require(set(record) == {"version", "stop", "stock"} and type(record["version"]) is int
            and record["version"] == 1 and record["stop"] == stop)
    return record["stock"]


def observe(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Read the retained disable operation without a systemd state change."""
    expected, stop, plan = load_intent(config, connection, boot, activation, profile_sha256, approved_version)
    require(stop["version"] in (2, 3))
    stock = retained_stock(config, boot, activation, stop)

    def inspect(transport):
        return observe_disabled(PackageRecovery(transport, deadline), expected, approved_version, stop, plan, stock)

    return on_wire(config, inspect, connection)
