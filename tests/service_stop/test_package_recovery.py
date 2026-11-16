"""Synthetic stale and changed recovery evidence controls."""

from dataclasses import replace
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "host"))
import resident_package_recovery as recovery


class PackageRecoveryTest(unittest.TestCase):
    def setUp(self):
        lease, profile = b"retained lease", b"{}"
        self.expected = recovery.Activation(
            "12345678-1234-1234-1234-123456789abc",
            "22345678-1234-1234-1234-123456789abc",
            recovery.sha256(lease), recovery.sha256(profile), "1" * 32, 10, "a" * 64,
        )
        self.sample = recovery.PackageRecovery(None, float("inf"))
        self.sample.boot = Mock(return_value=self.expected.boot_id)
        self.sample.runtime = Mock()
        self.sample.protected = Mock(side_effect=lambda path, **_: profile if path == recovery.PROFILE else lease)
        self.sample.package_files = Mock()
        self.sample.read = Mock(return_value=b"")
        inactive = {"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "Result": "success"}
        self.states = {
            recovery.BUDDY: {**inactive, "InvocationID": self.expected.buddy_invocation},
            recovery.HELPER: {**inactive, "InvocationID": "2" * 32, "ExecMainCode": "1",
                              "ExecMainStatus": "0", "ExecMainStartTimestampMonotonic": "20",
                              "ExecMainExitTimestampMonotonic": "30"},
            recovery.STOCK: {"InvocationID": "3" * 32},
            recovery.SYNC: {"InvocationID": "4" * 32},
        }
        self.sample.service = Mock(side_effect=self.states.__getitem__)
        self.sample.vendor_process = Mock(side_effect=lambda state, *_: state["InvocationID"])

    def test_exact_recovered_lease_binds_vendor_invocations(self):
        result = self.sample.observe_recovery(self.expected)
        self.assertEqual(result["lease_sha256"], self.expected.lease_sha256)
        self.assertEqual(result["reader_invocation"], "3" * 32)
        self.assertEqual(result["sync_invocation"], "4" * 32)
        self.sample.package_files.assert_called_once_with({})

    def test_refuses_wrong_lease_digest(self):
        with self.assertRaises(ValueError):
            self.sample.observe_recovery(replace(self.expected, lease_sha256="0" * 64))

    def test_refuses_old_helper_success(self):
        self.states[recovery.HELPER]["ExecMainStartTimestampMonotonic"] = "9"
        with self.assertRaises(ValueError):
            self.sample.observe_recovery(self.expected)

    def test_disabled_recovery_uses_retained_invocations_after_reload(self):
        receipt = self.sample.observe_recovery(self.expected)
        self.states[recovery.BUDDY]["InvocationID"] = ""
        self.states[recovery.HELPER]["InvocationID"] = ""
        self.sample.observe_disabled_recovery(self.expected, receipt)
        self.states[recovery.STOCK]["InvocationID"] = "f" * 32
        with self.assertRaises(ValueError):
            self.sample.observe_disabled_recovery(self.expected, receipt)

    def test_package_file_rejects_digest_drift(self):
        sampler = recovery.PackageRecovery(None, float("inf"))
        stat = b"1:2:0:0:755:1:64:10:10\n"
        sampler.read = Mock(return_value=stat + f"{'a' * 64}  {recovery.APP}\n".encode() + stat)
        profile = {
            "version": 6,
            "firmware": "3.28.0.172",
            "companion": "rm2-3.28.0.172-v1",
            "source_mode": "resident-installed-output-v1",
            "app_sha256": [0] * 32,
        }
        with self.assertRaises(ValueError):
            sampler.package_files(profile)
        sampler.read.assert_called_once()
