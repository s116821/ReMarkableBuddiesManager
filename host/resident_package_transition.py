"""Host-private stop and recovery preparation for a resident package change."""

from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
import time

from drive_store import checked_root, exclusive
from resident_package_recovery import (
    Activation, DIGEST, UUID, PackageRecovery, json_record, require, require_package_version,
)
from service_stop_sampler import run_fixed
from service_stop_transport import STOP_COMMAND
import wired_observer as shared
from resident_package_goal import LEASE_SINK, IntentLease, validate_goal, preflight


INTENT_MAX_BYTES = 4096


class RecoveryPending(RuntimeError):
    """A stop may have been submitted. Only observe the original activation."""


def intent_path(config_path, boot, activation):
    require(isinstance(boot, str) and UUID.fullmatch(boot)
            and isinstance(activation, str) and UUID.fullmatch(activation))
    return Path(config_path).parent / f"resident-stop-{boot}-{activation}.json"


def record_intent(path, connection, activation, ownership, removal_plan=None, *, goal=None):
    payload = {"version": 2, "connection_id": connection, "activation": asdict(activation),
               "ownership": ownership}
    if removal_plan is not None:
        payload.update(version=3, removal_plan=removal_plan)
    if goal is not None:
        validate_goal(goal, ownership, removal_plan)
        payload.update(version=4, goal=goal, removal_plan=removal_plan)
        preflight(payload)
    write_private_record(path, payload)


def write_private_record(path, payload):
    data = json.dumps(payload, separators=(",", ":")).encode("ascii")
    require(len(data) <= INTENT_MAX_BYTES)
    root_identity = checked_root(path.parent)
    require(root_identity is not None)
    try:
        with exclusive(path, write_through=True, **({'shared_read': True} if payload.get('version') == 4 else {})) as stream:
            if payload.get('version') == 4:
                require(LEASE_SINK.get() is not None)
                lease = IntentLease(stream.fileno())
                lease.path = str(path)
                LEASE_SINK.get().append(lease)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception as error:
        if os.path.lexists(path):
            raise RecoveryPending("Intent already exists or its publication is uncertain") from error
        raise
    if sys.platform == "linux":
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require((info.st_dev, info.st_ino) == root_identity)
            os.fsync(fd)
        finally:
            os.close(fd)
    require(checked_root(path.parent) == root_identity)
    require(json_record(shared.private_bytes(path, parent_private=True, maximum=INTENT_MAX_BYTES)) == payload)


def on_wire(config_path, inspect, expected_connection=None):
    import paramiko

    if paramiko.__version__ != "5.0.0":
        raise shared.Refusal("unconfigured")
    if sys.platform == "win32":
        import windows_wired

        config = windows_wired.load_config(config_path)
        return windows_wired.observe(config, shared, inspection=inspect,
                                     expected_connection=expected_connection)
    if sys.platform == "linux":
        config = shared.load_config(config_path)
        return shared.observe(config, inspection=inspect, expected_connection=expected_connection)
    raise shared.Refusal("unsupported-host")


def require_approved(expected, approved_profile_sha256):
    require(isinstance(expected, Activation) and isinstance(approved_profile_sha256, str)
            and DIGEST.fullmatch(approved_profile_sha256)
            and expected.profile_sha256 == approved_profile_sha256)


def require_ownership(ownership, boot, version):
    require_package_version(version)
    require(isinstance(ownership, dict) and set(ownership) == {"boot_id", "package", "database_sha256"}
            and ownership["boot_id"] == boot and ownership["package"] == f"remarkable-buddies-{version}"
            and isinstance(ownership["database_sha256"], str) and DIGEST.fullmatch(ownership["database_sha256"]))


def require_removal_plan(plan, boot, version):
    require(isinstance(plan, dict) and set(plan) == {"ownership", "world_sha256", "solver_sha256"})
    require_ownership(plan["ownership"], boot, version)
    require(all(isinstance(plan[field], str) and DIGEST.fullmatch(plan[field])
                for field in ("world_sha256", "solver_sha256")))


def recovered_with_ownership(recovery, receipt, version, expected_ownership, removal_plan=None):
    if removal_plan is not None:
        if recovery.removal_plan(version) != removal_plan:
            raise RecoveryPending("Vellum removal plan changed after possible stop submission")
        return {"recovery": receipt, "ownership": expected_ownership, "removal_plan": removal_plan}
    if recovery.package_ownership(version) != expected_ownership:
        raise RecoveryPending("Vellum ownership changed after possible stop submission")
    return {"recovery": receipt, "ownership": expected_ownership}


def observe_package_ownership(config_path, approved_version, deadline, expected_connection=None):
    """Inspect the installed Vellum package through Manager's verified wired route."""
    def inspect(transport):
        recovery = PackageRecovery(transport, deadline)
        return {"ownership": recovery.package_ownership(approved_version)}

    return on_wire(config_path, inspect, expected_connection)


def preview_removal(config_path, approved_version, deadline, expected_connection=None):
    """Preview the single-package Vellum removal over the verified wired route."""
    def inspect(transport):
        return {"removal_plan": PackageRecovery(transport, deadline).removal_plan(approved_version)}

    return on_wire(config_path, inspect, expected_connection)


def review(config_path, approved_profile_sha256, deadline):
    """Read the activation for the package identity approved by the host caller."""
    def inspect(transport):
        activation = PackageRecovery(transport, deadline).capture_activation()
        require_approved(activation, approved_profile_sha256)
        return {"activation": asdict(activation)}

    return on_wire(config_path, inspect)


def prepare(config_path, expected_connection, expected, approved_profile_sha256, deadline, *,
            approved_version, removal=False, expected_plan=None, goal=None):
    """Require owned bytes before recording intent and reconfirm ownership after recovery."""
    require_approved(expected, approved_profile_sha256)
    require_package_version(approved_version)
    require(isinstance(expected_connection, str) and DIGEST.fullmatch(expected_connection))
    if expected_plan is not None:
        require(removal)
        require_removal_plan(expected_plan, expected.boot_id, approved_version)
    path = intent_path(config_path, expected.boot_id, expected.activation_id)
    if os.path.lexists(path):
        raise RecoveryPending("Stop intent is already retained")
    possible = False

    def inspect(transport):
        nonlocal possible
        recovery = PackageRecovery(transport, deadline)
        plan = None
        if removal:
            plan = recovery.removal_plan(approved_version)
            require_removal_plan(plan, expected.boot_id, approved_version)
            if expected_plan is not None:
                require(plan == expected_plan)
            ownership = plan["ownership"]
        else:
            ownership = recovery.package_ownership(approved_version)
            require_ownership(ownership, expected.boot_id, approved_version)
        require(recovery.capture_activation() == expected and time.monotonic() < deadline)
        recovery.require_takeover()
        require(time.monotonic() < deadline)
        if goal is None:
            record_intent(path, expected_connection, expected, ownership, plan)
        else:
            record_intent(path, expected_connection, expected, ownership, plan, goal=goal)
        if time.monotonic() >= deadline:
            raise shared.Refusal("timeout")
        possible = True
        code, out, err = run_fixed(transport, STOP_COMMAND, deadline, 1024)
        if code or out or err:
            raise RecoveryPending("Buddy stop submission could not be confirmed")
        while time.monotonic() < deadline:
            try:
                receipt = recovery.observe_recovery(expected)
            except ValueError:
                if recovery.boot() != expected.boot_id:
                    raise RecoveryPending("Tablet boot changed after stop submission") from None
                time.sleep(max(0, min(0.25, deadline - time.monotonic())))
            else:
                return recovered_with_ownership(recovery, receipt, approved_version, ownership, plan)
        raise RecoveryPending("Stock recovery could not be confirmed")

    try:
        return on_wire(config_path, inspect, expected_connection)
    except RecoveryPending:
        raise
    except Exception as error:
        if possible:
            raise RecoveryPending("Connection or observation failed after possible stop submission") from error
        raise


def load_intent(config_path, expected_connection, boot, activation, approved_profile_sha256, approved_version):
    path = intent_path(config_path, boot, activation)
    require(checked_root(path.parent) is not None)
    record = json_record(shared.private_bytes(path, parent_private=True, maximum=INTENT_MAX_BYTES))
    require(type(record.get("version")) is int and record["version"] in (1, 2, 3, 4)
            and record.get("connection_id") == expected_connection)
    fields = {"version", "connection_id", "activation"}
    plan = None
    if record["version"] == 4:
        require(set(record) == fields | {"ownership", "removal_plan", "goal"})
        require_ownership(record["ownership"], boot, approved_version)
        plan = record["removal_plan"]
        if plan is not None:
            require_removal_plan(plan, boot, approved_version)
            require(plan["ownership"] == record["ownership"])
        validate_goal(record["goal"], record["ownership"], plan)
        preflight(record)
    elif record["version"] == 3:
        require(set(record) == fields | {"ownership", "removal_plan"})
        plan = record["removal_plan"]
        require_removal_plan(plan, boot, approved_version)
        require(plan["ownership"] == record["ownership"])
    elif record["version"] == 2:
        require(set(record) == fields | {"ownership"})
        require_ownership(record["ownership"], boot, approved_version)
    else:
        # Existing receipts remain readable but cannot establish package ownership.
        require(set(record) == fields and approved_version is None)
    expected = Activation(**record["activation"])
    require(expected.boot_id == boot and expected.activation_id == activation)
    require_approved(expected, approved_profile_sha256)
    require(isinstance(expected_connection, str) and DIGEST.fullmatch(expected_connection))
    return expected, record, plan


def observe(config_path, expected_connection, boot, activation, approved_profile_sha256, deadline,
            *, approved_version=None):
    """Read the original intent across processes and reconcile without a service command."""
    expected, record, plan = load_intent(config_path, expected_connection, boot, activation,
                                         approved_profile_sha256, approved_version)

    def inspect(transport):
        recovery = PackageRecovery(transport, deadline)
        receipt = recovery.observe_recovery(expected)
        if record["version"] == 1:
            return {"recovery": receipt}
        return recovered_with_ownership(recovery, receipt, approved_version, record["ownership"], plan)

    return on_wire(config_path, inspect, expected_connection)
