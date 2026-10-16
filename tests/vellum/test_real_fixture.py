"""Focused consumer guards; no signature, producer-build or device qualification."""
from pathlib import Path
import sys
import tempfile
import unittest

import real_fixture as fixture


class ConsumerGuards(unittest.TestCase):
    def test_nested_duplicate_and_nonfinite_json_refuse(self):
        for raw in (b'{"info":{"tag":1,"tag":2}}', b'{"value":NaN}', b'{"value":Infinity}'):
            with self.assertRaises(ValueError):
                fixture.strict(raw)

    def test_json_utf8_and_bounds_refuse(self):
        with self.assertRaises(ValueError):
            fixture.strict(b'{}', 1)
        with self.assertRaises(UnicodeError):
            fixture.strict(b'"\xff"')

    def test_pin_requires_complete_lowercase_digest(self):
        for value in (True, 'A' * 64, '0' * 63, '0' * 64 + '\n'):
            with self.assertRaises(ValueError):
                fixture.pin(value)

    def test_manifest_pin_refuses_original_bytes_before_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'hash-manifest.json').write_bytes(b'not-json')
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                fixture.admit(root, '0' * 64)

    def test_snapshot_detects_content_and_inventory_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'input').write_bytes(b'original')
            original = fixture.snapshot(root)
            (root / 'input').write_bytes(b'changed!')
            self.assertNotEqual(original, fixture.snapshot(root))
            (root / 'extra').mkdir()
            self.assertNotEqual(original, fixture.snapshot(root))

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-only opt-in consumer process/mount boundary')
    def test_snapshot_refuses_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'escape').symlink_to(root.parent)
            with self.assertRaisesRegex(ValueError, 'Regular files'):
                fixture.snapshot(root)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-only bounded selector/process groups')
    def test_actual_process_output_bound(self):
        with self.assertRaisesRegex(ValueError, 'output bound'):
            fixture.bounded_run([sys.executable, '-c', 'import os;os.write(1,b"x"*8192)'], limit=128)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-only bounded selector/process groups')
    def test_actual_timeout_calls_owned_cleanup(self):
        cleaned = []
        with self.assertRaisesRegex(ValueError, 'timeout'):
            fixture.bounded_run([sys.executable, '-c', 'import time;time.sleep(10)'],
                                timeout=0.1, cleanup=lambda: cleaned.append(True))
        self.assertEqual(cleaned, [True])


if __name__ == '__main__':
    unittest.main()
