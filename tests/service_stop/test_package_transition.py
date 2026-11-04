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
