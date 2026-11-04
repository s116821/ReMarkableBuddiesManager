"""Coordinate one reviewed removal through Manager's private wired transport."""

from dataclasses import asdict
import os

import resident_package_disable as disable
import resident_package_transition as transition
import resident_package_uninstall as uninstall
from resident_package_recovery import PackageRecovery


def review(config, profile_sha256, deadline, *, approved_version):
    """Read the exact installed activation and sole-package solver plan together."""
    def inspect(transport):
        recovery = PackageRecovery(transport, deadline)
        plan = recovery.removal_plan(approved_version)
        active = recovery.capture_activation()
        transition.require_approved(active, profile_sha256)
        transition.require_removal_plan(plan, active.boot_id, approved_version)
        recovery.require_takeover()
        return {"activation": asdict(active), "removal_plan": plan}

    return transition.on_wire(config, inspect)


def execute(config, connection, active, plan, profile_sha256, deadline, *, approved_version):
    """Apply one host-approved review, using a single deadline for all phases."""
    transition.require_removal_plan(plan, active.boot_id, approved_version)
    transition.prepare(config, connection, active, profile_sha256, deadline,
                       approved_version=approved_version, removal=True, expected_plan=plan)
    args = (config, connection, active.boot_id, active.activation_id, profile_sha256, deadline)
    try:
        disable.execute(*args, approved_version=approved_version)
        return uninstall.execute(*args, approved_version=approved_version)
    except transition.RecoveryPending:
        raise
    except Exception as error:
        raise transition.RecoveryPending("Removal stopped after verified stock recovery") from error


def observe(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Reconcile the latest retained phase without resubmitting any command."""
    args = (config, connection, boot, activation, profile_sha256, deadline)
    if os.path.lexists(uninstall.removal_path(config, boot, activation)):
        return {"phase": "removal", **uninstall.observe(*args, approved_version=approved_version)}
    if os.path.lexists(disable.disable_path(config, boot, activation)):
        phase, receipt = "disable", disable.observe(*args, approved_version=approved_version)
    else:
        phase, receipt = "stop", transition.observe(*args, approved_version=approved_version)
    transition.require("removal_plan" in receipt)
    return {"phase": phase, **receipt}
