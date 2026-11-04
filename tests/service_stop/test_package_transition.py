"""Synthetic checks for the stop submission boundary and read-only reobservation."""

from dataclasses import asdict, replace
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "host"))
import resident_package_transition as transition
import resident_package_uninstall as uninstall
import resident_package_disable as disable
import resident_package_removal as removal
import resident_package_replacement as replacement


class TransitionTest(unittest.TestCase):
    def setUp(self):
        self.activation = transition.Activation(
            "12345678-1234-1234-1234-123456789abc",
            "22345678-1234-1234-1234-123456789abc", "a" * 64, "b" * 64,
            "1" * 32, 10, "c" * 64,
        )
        self.connection = "d" * 64
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = Path(directory.name) / "wired.json"
        self.recovery = Mock()
        self.version = "1.2.3-r2"
        self.ownership = {"boot_id": self.activation.boot_id, "package": f"remarkable-buddies-{self.version}",
                          "database_sha256": "e" * 64}
        self.plan = {"ownership": self.ownership, "world_sha256": "a" * 64, "solver_sha256": "b" * 64}
        self.recovery.package_ownership.return_value = self.ownership
        self.recovery.removal_plan.return_value = self.plan
        self.recovery.capture_activation.return_value = self.activation
        self.recovery.observe_recovery.return_value = {"lease_sha256": self.activation.lease_sha256}
        self.events = Mock()
        self.events.stop.return_value = (0, b"", b"")
        self.patch_wire = patch.object(transition, "on_wire", side_effect=self.wire)
        self.patch_sampler = patch.object(transition, "PackageRecovery", return_value=self.recovery)
        self.patch_stop = patch.object(transition, "run_fixed", self.events.stop)
        self.patch_record = patch.object(transition, "record_intent", self.events.record)
        for fixture in (self.patch_wire, self.patch_sampler, self.patch_stop, self.patch_record):
            fixture.start()
            self.addCleanup(fixture.stop)

    def wire(self, config, inspect, expected_connection=None):
        self.assertEqual(expected_connection, self.connection)
        return inspect("wire")

    def prepare(self, *, removal=False):
        return transition.prepare(self.config, self.connection, self.activation, self.activation.profile_sha256,
                                  float("inf"), approved_version=self.version, removal=removal)

    def test_journal_precedes_the_single_stop(self):
        receipt = self.prepare()
        self.assertEqual(receipt["recovery"]["lease_sha256"], self.activation.lease_sha256)
        self.assertEqual(receipt["ownership"], self.ownership)
        self.assertEqual([entry[0] for entry in self.events.mock_calls], ["record", "stop"])
        path = transition.intent_path(self.config, self.activation.boot_id, self.activation.activation_id)
        self.events.record.assert_called_once_with(path, self.connection, self.activation, self.ownership, None)
        self.events.stop.assert_called_once_with("wire", transition.STOP_COMMAND, float("inf"), 1024)
        self.assertEqual(self.recovery.package_ownership.call_count, 2)

    def test_duplicate_intent_refuses_before_opening_usb(self):
        path = transition.intent_path(self.config, self.activation.boot_id, self.activation.activation_id)
        path.touch()
        with self.assertRaises(transition.RecoveryPending):
            self.prepare()
        self.recovery.capture_activation.assert_not_called()
        self.assertEqual(self.events.mock_calls, [])

    def test_stale_activation_never_records_or_stops(self):
        self.recovery.capture_activation.return_value = replace(self.activation, buddy_invocation="2" * 32)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.events.mock_calls, [])

    def test_unsettled_takeover_never_records_or_stops(self):
        self.recovery.require_takeover.side_effect = ValueError("stock still active")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.events.mock_calls, [])

    def test_missing_ownership_never_records_or_stops(self):
        self.recovery.package_ownership.side_effect = ValueError("ownership refused")
        with self.assertRaises(ValueError):
            self.prepare()
        self.recovery.capture_activation.assert_not_called()
        self.assertEqual(self.events.mock_calls, [])

    def test_ownership_drift_stays_pending_after_recovery(self):
        self.recovery.package_ownership.side_effect = [
            self.ownership, {**self.ownership, "database_sha256": "f" * 64},
        ]
        with self.assertRaises(transition.RecoveryPending):
            self.prepare()
        self.recovery.observe_recovery.assert_called_once_with(self.activation)
        self.events.stop.assert_called_once()

    def test_removal_revalidates_solver_plan_after_recovery(self):
        self.recovery.removal_plan.side_effect = [self.plan, {**self.plan, "world_sha256": "f" * 64}]
        with self.assertRaises(transition.RecoveryPending):
            self.prepare(removal=True)
        path = transition.intent_path(self.config, self.activation.boot_id, self.activation.activation_id)
        self.events.record.assert_called_once_with(path, self.connection, self.activation, self.ownership, self.plan)
        self.events.stop.assert_called_once()
        self.recovery.observe_recovery.assert_called_once_with(self.activation)

    def test_removal_review_drift_refuses_before_stop(self):
        self.recovery.removal_plan.return_value = {**self.plan, "world_sha256": "f" * 64}
        with self.assertRaises(ValueError):
            removal.execute(self.config, self.connection, self.activation, self.plan, self.activation.profile_sha256,
                            float("inf"), approved_version=self.version)
        self.assertEqual(self.events.mock_calls, [])

    def test_interrupted_removal_observes_the_retained_phase_without_applying(self):
        args = (self.config, self.connection, self.activation.boot_id, self.activation.activation_id,
                self.activation.profile_sha256, float("inf"))
        disable.disable_path(self.config, self.activation.boot_id, self.activation.activation_id).touch()
        with (patch.object(disable, "observe", return_value={"removal_plan": self.plan}) as observe,
              patch.object(uninstall, "execute") as apply):
            receipt = removal.observe(*args, approved_version=self.version)
        self.assertEqual(receipt, {"phase": "disable", "removal_plan": self.plan})
        observe.assert_called_once_with(*args, approved_version=self.version)
        apply.assert_not_called()
        self.assertEqual(self.events.mock_calls, [])

    def test_retained_removal_plan_is_reconciled_without_stop(self):
        raw = json.dumps({"version": 3, "connection_id": self.connection, "activation": asdict(self.activation),
                          "ownership": self.ownership, "removal_plan": self.plan}).encode()
        args = (self.config, self.connection, self.activation.boot_id, self.activation.activation_id,
                self.activation.profile_sha256, float("inf"))
        with (patch.object(transition, "checked_root", return_value=(1, 2)),
              patch.object(transition.shared, "private_bytes", return_value=raw)):
            receipt = transition.observe(*args, approved_version=self.version)
            self.assertEqual(receipt["removal_plan"], self.plan)
            self.recovery.removal_plan.return_value = {**self.plan, "solver_sha256": "f" * 64}
            with self.assertRaises(transition.RecoveryPending):
                transition.observe(*args, approved_version=self.version)
        self.events.stop.assert_not_called()

    def test_connection_failure_stays_pending_and_observation_does_not_stop(self):
        self.events.stop.side_effect = OSError("link lost")
        with self.assertRaises(transition.RecoveryPending):
            self.prepare()
        self.recovery.observe_recovery.assert_not_called()
        raw = json.dumps({"version": 2, "connection_id": self.connection,
                          "activation": asdict(self.activation), "ownership": self.ownership}).encode()
        with (patch.object(transition, "checked_root", return_value=(1, 2)),
              patch.object(transition.shared, "private_bytes", return_value=raw)):
            receipt = transition.observe(self.config, self.connection, self.activation.boot_id,
                                         self.activation.activation_id, self.activation.profile_sha256, float("inf"),
                                         approved_version=self.version)
            self.assertEqual(receipt["ownership"], self.ownership)
        self.recovery.observe_recovery.assert_called_once_with(self.activation)
        self.assertEqual([entry[0] for entry in self.events.mock_calls], ["record", "stop"])

    def test_v1_intent_remains_observable_without_ownership(self):
        raw = json.dumps({"version": 1, "connection_id": self.connection,
                          "activation": asdict(self.activation)}).encode()
        args = (self.config, self.connection, self.activation.boot_id, self.activation.activation_id,
                self.activation.profile_sha256, float("inf"))
        with (patch.object(transition, "checked_root", return_value=(1, 2)),
              patch.object(transition.shared, "private_bytes", return_value=raw)):
            self.assertNotIn("ownership", transition.observe(*args))
            with self.assertRaises(ValueError):
                transition.observe(*args, approved_version=self.version)
        self.recovery.package_ownership.assert_not_called()
        self.events.stop.assert_not_called()


class RemovalPromptTest(unittest.TestCase):
    def test_only_the_exact_buddy_removal_is_approved(self):
        lines = (b"The following packages will be REMOVED:\n"
                 b"  remarkable-buddies (1.2.3-r2)\n"
                 b"After this operation, 32 B of disk space will be freed.\n")
        uninstall.exact_prompt(lines + uninstall.PROMPT, "1.2.3-r2")
        advisory = b"\n".join(uninstall.ADVISORY + [b"  rm2 remarkable-os", b""])
        uninstall.exact_prompt(advisory + lines + uninstall.PROMPT, "1.2.3-r2")
        with self.assertRaises(ValueError):
            uninstall.exact_prompt(lines + uninstall.PROMPT, "1.2.3-r1")
        collateral = lines.replace(b"After this operation", b"  rm2 (1.0.0-r0)\nAfter this operation")
        with self.assertRaises(ValueError):
            uninstall.exact_prompt(collateral + uninstall.PROMPT, "1.2.3-r2")


class ReplacementPromptTest(unittest.TestCase):
    def test_upgrade_and_downgrade_require_the_sole_exact_transition(self):
        for heading, old, new in (("upgraded", "1.2.3-r1", "1.2.3-r2"),
                                  ("DOWNGRADED", "1.2.3-r2", "1.2.3-r1")):
            with self.subTest(heading=heading):
                prompt = (
                    f"The following packages will be {heading}:\n"
                    f"  remarkable-buddies ({old} -> {new})\n"
                    "After this operation, 0 B of additional disk space will be used.\n"
                ).encode("ascii")
                replacement.exact_replacement_prompt(prompt + uninstall.PROMPT, old, new)
                extra = prompt.replace(b"After this operation", b"  rm2 (1.0.0-r0)\nAfter this operation")
                with self.assertRaises(ValueError):
                    replacement.exact_replacement_prompt(extra + uninstall.PROMPT, old, new)

    def test_replacement_world_binds_the_exact_pin_and_other_entries(self):
        before = b"remarkable-buddies\nremarkable-os=3.28.0.172-r0\nrm2\n"
        after = before.replace(b"remarkable-buddies\n", b"remarkable-buddies=1.2.3-r2\n")
        expected = replacement.other_world_sha256(before, "1.2.3-r1")
        self.assertEqual(replacement.other_world_sha256(after, "1.2.3-r2", require_pin=True), expected)
        self.assertNotEqual(replacement.other_world_sha256(after + b"unrelated\n", "1.2.3-r2"), expected)
        with self.assertRaises(ValueError):
            replacement.other_world_sha256(before, "1.2.3-r2", require_pin=True)


class DisableTransitionTest(unittest.TestCase):
    def test_disable_preserves_recovery_and_reobserves_without_dispatch(self):
        boot, activation = "12345678-1234-1234-1234-123456789abc", "22345678-1234-1234-1234-123456789abc"
        version = "1.2.3-r2"
        stop = {"version": 2, "ownership": {"package": f"remarkable-buddies-{version}"}}
        stock = {"reader_invocation": "a" * 32, "sync_invocation": "b" * 32}
        record = {"version": 1, "stop": stop, "stock": stock}
        expected = Mock()
        recovery = Mock()
        recovery.observe_recovery.return_value = stock
        recovery.package_ownership.return_value = stop["ownership"]
        operations = []
        disabled = False

        def state(unit):
            if unit == disable.HELPER:
                return b"static\n"
            return b"disabled\n" if disabled else b"enabled\n"

        def read(command, _):
            nonlocal disabled
            if command == disable.DISABLE_COMMAND:
                self.assertNotIn("--no-reload", command)
                self.assertEqual(operations, ["record"])
                operations.append("disable")
                disabled = True
            if command == f"readlink {disable.STARTUP_LINK}":
                return (disable.PACKAGE_UNIT + "\n").encode("ascii")
            return b""

        recovery.unit_file_state.side_effect = state
        recovery.read.side_effect = read
        with (TemporaryDirectory() as directory,
              patch.object(disable, "load_intent", return_value=(expected, stop, None)),
              patch.object(disable, "on_wire", side_effect=lambda _, inspect, _connection: inspect("wire")),
              patch.object(disable, "PackageRecovery", return_value=recovery),
              patch.object(disable, "write_private_record", side_effect=lambda *_: operations.append("record")),
              patch.object(disable.shared, "private_bytes", return_value=json.dumps(record).encode())):
            args = (Path(directory) / "wired.json", "c" * 64, boot, activation, "d" * 64, float("inf"))
            self.assertTrue(disable.execute(*args, approved_version=version)["disabled"])
            self.assertTrue(disable.observe(*args, approved_version=version)["disabled"])
        self.assertEqual(operations, ["record", "disable"])
        self.assertEqual(recovery.observe_disabled_recovery.call_count, 2)
