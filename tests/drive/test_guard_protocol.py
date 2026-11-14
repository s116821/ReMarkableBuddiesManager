"""Exact helper wire bytes and Windows API selection; no native custody claim."""
from contextlib import contextmanager, nullcontext
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

    def test_staging_creates_each_directory_with_protected_attributes_before_admission(self):
        module = helper('isolated-backup-staging')
        broker = module.Broker.__new__(module.Broker)
        broker.windows, broker.root, broker.dirs = True, Path.cwd(), {}
        broker.pin_dirs = nullcontext
        attributes = object()
        events = []
        create = Mock(side_effect=lambda path, sd: events.append(('create', path, sd)))

        @contextmanager
        def admit(path, directory, private):
            self.assertTrue(directory and private)
            events.append(('admit', str(path)))
            yield path

        with patch.dict(sys.modules, {'win32file': SimpleNamespace(CreateDirectory=create)}), \
                patch.object(module, 'windows_private_attributes', return_value=attributes), \
                patch.object(module, 'win_handle', admit), \
                patch.object(module, 'checked_root', return_value=(1, 2)), \
                patch.object(module, 'win_key', side_effect=lambda handle: handle), \
                patch.object(module.os, 'mkdir', side_effect=AssertionError('requires a native descriptor')):
            for relative in module.DIRECTORIES:
                broker.create_dir(relative, '', None)
        self.assertEqual(events, [
            entry for relative in module.DIRECTORIES
            for entry in (
                ('create', str(broker.root / relative), attributes),
                ('admit', str(broker.root / relative)),
            )
        ])
        self.assertEqual(broker.dirs, {name: (broker.root / name, None) for name in module.DIRECTORIES})

    def test_staging_preserves_original_create_failure_when_checked_cleanup_fails(self):
        module = helper('isolated-backup-staging')
        broker = module.Broker.__new__(module.Broker)
        broker.parent, broker.root, broker.windows = Path.cwd(), None, True
        create = ValueError('create refused')
        cleanup = OSError('checked cleanup refused')
        broker.check_parent = Mock()
        broker.create_dir = Mock(side_effect=create)
        broker.release = Mock(side_effect=cleanup)
        with self.assertRaises(ValueError) as raised:
            broker.create()
        self.assertIs(raised.exception, create)
        self.assertIs(raised.exception.__cause__, cleanup)
        broker.release.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
