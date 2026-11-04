"""Host-private stop and recovery preparation for a resident package change."""

from dataclasses import asdict
import sys
import time

from resident_package_recovery import Activation, DIGEST, PackageRecovery, require
from service_stop_sampler import run_fixed
from service_stop_transport import STOP_COMMAND
import wired_observer as shared


class RecoveryPending(RuntimeError):
    """A stop may have been submitted. Only observe the original activation."""


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


def review(config_path, approved_profile_sha256, deadline):
    """Read the activation for the package identity approved by the host caller."""
    def inspect(transport):
        activation = PackageRecovery(transport, deadline).capture_activation()
        require_approved(activation, approved_profile_sha256)
        return {"activation": asdict(activation)}

    return on_wire(config_path, inspect)


def prepare(config_path, expected_connection, expected, approved_profile_sha256,
            deadline, record_possible_submission):
    """Send one stop after admission.

    The caller holds the package transaction lock. Its callback must durably
    record the activation and refuse any duplicate before returning.
    """
    require_approved(expected, approved_profile_sha256)
    require(isinstance(expected_connection, str) and DIGEST.fullmatch(expected_connection))
    possible = False

    def inspect(transport):
        nonlocal possible
        recovery = PackageRecovery(transport, deadline)
        require(recovery.capture_activation() == expected and time.monotonic() < deadline)
        record_possible_submission(expected)
        if time.monotonic() >= deadline:
            raise shared.Refusal("timeout")
        possible = True
        code, out, err = run_fixed(transport, STOP_COMMAND, deadline, 1024)
        if code or out or err:
            raise RecoveryPending("Buddy stop submission could not be confirmed")
        while time.monotonic() < deadline:
            try:
                return {"recovery": recovery.observe_recovery(expected)}
            except ValueError:
                if recovery.boot() != expected.boot_id:
                    raise RecoveryPending("Tablet boot changed after stop submission") from None
                time.sleep(max(0, min(0.25, deadline - time.monotonic())))
        raise RecoveryPending("Stock recovery could not be confirmed")

    try:
        return on_wire(config_path, inspect, expected_connection)
    except RecoveryPending:
        raise
    except Exception as error:
        if possible:
            raise RecoveryPending("Connection or observation failed after possible stop submission") from error
        raise


def observe(config_path, expected_connection, expected, approved_profile_sha256, deadline):
    """Reconcile a retained activation without a service command."""
    require_approved(expected, approved_profile_sha256)
    require(isinstance(expected_connection, str) and DIGEST.fullmatch(expected_connection))

    def inspect(transport):
        return {"recovery": PackageRecovery(transport, deadline).observe_recovery(expected)}

    return on_wire(config_path, inspect, expected_connection)
