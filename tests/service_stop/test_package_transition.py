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

    def prepare(self):
        return transition.prepare(self.config, self.connection, self.activation, self.activation.profile_sha256,
                                  float("inf"))

    def test_journal_precedes_the_single_stop(self):
        self.assertEqual(self.prepare()["recovery"]["lease_sha256"], self.activation.lease_sha256)
        self.assertEqual([entry[0] for entry in self.events.mock_calls], ["record", "stop"])
        self.events.stop.assert_called_once_with("wire", transition.STOP_COMMAND, float("inf"), 1024)

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

    def test_connection_failure_stays_pending_and_observation_does_not_stop(self):
        self.events.stop.side_effect = OSError("link lost")
        with self.assertRaises(transition.RecoveryPending):
            self.prepare()
        self.recovery.observe_recovery.assert_not_called()
        raw = json.dumps({"version": 1, "connection_id": self.connection,
                          "activation": asdict(self.activation)}).encode()
        with (patch.object(transition, "checked_root", return_value=(1, 2)),
              patch.object(transition.shared, "private_bytes", return_value=raw)):
            transition.observe(self.config, self.connection, self.activation.boot_id,
                               self.activation.activation_id, self.activation.profile_sha256, float("inf"))
        self.recovery.observe_recovery.assert_called_once_with(self.activation)
        self.assertEqual([entry[0] for entry in self.events.mock_calls], ["record", "stop"])
