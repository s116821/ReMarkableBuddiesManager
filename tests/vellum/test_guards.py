"""Safety-boundary regressions; these do not replace the actual-tool qualification."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fixture, qualify = module("fixture"), module("qualify")


class Guards(unittest.TestCase):
    def test_mutation_command_rejected_before_process(self):
        with patch.object(sys, "argv", ["fixture", "observe"]), patch.object(fixture.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Unapproved"):
                fixture.command(["add", "anything"])
            run.assert_not_called()

    def test_snapshot_detects_content_directory_and_mode_changes(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(fixture, "ROOT", Path(temporary)):
            path = Path(temporary) / "content"
            path.write_text("before")
            before = fixture.snapshot()
            path.write_text("after")
            self.assertNotEqual(before, fixture.snapshot())
            before = fixture.snapshot()
            (Path(temporary) / "new-directory").mkdir()
            self.assertNotEqual(before, fixture.snapshot())
            before = fixture.snapshot()
            path.chmod(0o400)
            self.assertNotEqual(before, fixture.snapshot())
            path.chmod(0o600)

    def test_escape_link_refused_before_tool(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(fixture, "ROOT", Path(temporary)):
            path = Path(temporary) / "escape"
            try:
                path.symlink_to(Path(temporary).parent)
            except OSError:
                self.skipTest("Host cannot create symlinks; run this guard on Linux")
            with self.assertRaisesRegex(ValueError, "escapes"):
                fixture.snapshot()

    def test_timeout_removes_only_generated_container_and_kills_cli(self):
        process = Mock()
        process.communicate.side_effect = [subprocess.TimeoutExpired("docker", 1), (b"", b"")]
        cleanup = Mock(returncode=0)
        with patch.object(qualify.subprocess, "Popen", return_value=process) as start, \
                patch.object(qualify.subprocess, "run", return_value=cleanup) as remove:
            with self.assertRaisesRegex(RuntimeError, "timed out and was removed"):
                qualify.run_container("sha256:" + "1" * 64, [], "observe", "2" * 64, timeout=1)
            name = start.call_args.args[0][4]
            self.assertTrue(name.startswith("manager-apk-fixture-"))
            self.assertEqual(remove.call_args.args[0], ["docker", "rm", "--force", name])
            process.kill.assert_called_once()

    def test_failed_removal_never_claims_cleanup(self):
        process = Mock()
        process.communicate.side_effect = [subprocess.TimeoutExpired("docker", 1), (b"", b"")]
        with patch.object(qualify.subprocess, "Popen", return_value=process), \
                patch.object(qualify.subprocess, "run", return_value=Mock(returncode=1)):
            with self.assertRaisesRegex(RuntimeError, "removal was not confirmed"):
                qualify.run_container("sha256:" + "1" * 64, [], "observe", "2" * 64, timeout=1)
            process.kill.assert_called_once()

    def test_crash_or_usage_error_is_not_crypto_refusal(self):
        for code, diagnostic in [(139, b"file: UNTRUSTED signature\n"), (1, b"usage error\n")]:
            result = Mock(returncode=code, stdout=diagnostic, stderr=b"")
            with patch.object(sys, "argv", ["fixture", "observe"]), \
                    patch.object(fixture, "snapshot", return_value={}), \
                    patch.object(fixture.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError):
                    fixture.command(["verify", "file"], 1, {"untrusted-signature"})


if __name__ == "__main__":
    unittest.main()
