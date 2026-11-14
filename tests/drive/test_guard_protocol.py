"""Exact helper wire bytes and Windows API selection; no native custody claim."""
import importlib.util
import io
import json
from pathlib import Path, PureWindowsPath
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def helper(name):
    path = Path(__file__).resolve().parents[2] / 'host' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GuardProtocolControls(unittest.TestCase):
    def test_guard_acknowledgments_keep_exact_lf_under_windows_text_translation(self):
        module = helper('drive-read-guard')
        original = json.dumps(['a' * 64, 'b' * 64]).encode() + b'\n'
        for tail, failed in ((b'check\n', False), (b'check\nunknown\n', True)):
            output = io.BytesIO()
            stdout = io.TextIOWrapper(output, encoding='utf-8', newline='\r\n', write_through=True)
            stdin = io.TextIOWrapper(io.BytesIO(original + tail), encoding='utf-8')
            checked = Mock()
            try:
                with patch.object(sys, 'argv', ['guard', str(Path.cwd())]), \
                        patch.object(sys, 'stdin', stdin), patch.object(sys, 'stdout', stdout), \
                        patch.object(module, 'checked_root', return_value=(1, 2)), \
                        patch.object(module, 'check', checked):
                    if failed:
                        with self.assertRaises(SystemExit) as raised:
                            module.main()
                        self.assertEqual(raised.exception.code, 1)
                    else:
                        module.main()
                    stdout.flush()
                    self.assertEqual(output.getvalue(), b'ok\nok\n')
                    self.assertEqual(checked.call_count, 2)
            finally:
                stdin.close()
                stdout.close()

    def test_staging_uses_file_api_and_refuses_nonfixed_windows_volume(self):
        module = helper('isolated-backup-staging')
        drive_type = Mock(return_value=3)
        with patch.object(module, 'Path', PureWindowsPath), patch.object(sys, 'platform', 'win32'), \
                patch.dict(sys.modules, {'win32file': SimpleNamespace(GetDriveType=drive_type),
                                         'win32api': SimpleNamespace()}):
            value = str(PureWindowsPath('C:/synthetic/private'))
            self.assertEqual(module.lexical_root(value), PureWindowsPath(value))
            drive_type.assert_called_once_with('C:\\')
            drive_type.return_value = 4
            with self.assertRaises(ValueError):
                module.lexical_root(value)
            for unsafe in ('relative', 'C:\\synthetic\\private:stream', '\\\\server\\share\\private'):
                with self.assertRaises(ValueError):
                    module.lexical_root(unsafe)


if __name__ == '__main__':
    unittest.main()
