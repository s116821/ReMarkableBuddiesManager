"""Synthetic checks for the stop submission boundary and read-only reobservation."""

from dataclasses import replace
from pathlib import Path
import sys
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
        self.recovery = Mock()
        self.recovery.capture_activation.return_value = self.activation
        self.recovery.observe_recovery.return_value = {"lease_sha256": self.activation.lease_sha256}
        self.events = Mock()
        self.events.stop.return_value = (0, b"", b"")
        self.patch_wire = patch.object(transition, "on_wire", side_effect=self.wire)
        self.patch_sampler = patch.object(transition, "PackageRecovery", return_value=self.recovery)
        self.patch_stop = patch.object(transition, "run_fixed", self.events.stop)
        for fixture in (self.patch_wire, self.patch_sampler, self.patch_stop):
            fixture.start()
            self.addCleanup(fixture.stop)

    def wire(self, config, inspect, expected_connection=None):
        self.assertEqual(expected_connection, self.connection)
        return inspect("wire")

    def prepare(self):
        return transition.prepare("config", self.connection, self.activation, self.activation.profile_sha256,
                                  float("inf"), self.events.record)

    def test_journal_precedes_the_single_stop(self):
        self.assertEqual(self.prepare()["recovery"]["lease_sha256"], self.activation.lease_sha256)
        self.assertEqual([entry[0] for entry in self.events.mock_calls], ["record", "stop"])
        self.events.stop.assert_called_once_with("wire", transition.STOP_COMMAND, float("inf"), 1024)

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
        transition.observe("config", self.connection, self.activation, self.activation.profile_sha256, float("inf"))
        self.recovery.observe_recovery.assert_called_once_with(self.activation)
        self.assertEqual([entry[0] for entry in self.events.mock_calls], ["record", "stop"])
