"""Portable package integrity retained when replacing the release coordinator."""
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from build import Release, TARGETS, archive_package, sha256, verify_packages


class PackageTests(unittest.TestCase):
    def test_cross_packaged_linux_modes_and_tampered_asset_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, assets = root / 'source', root / 'assets'
            source.mkdir()
            assets.mkdir()
            release = Release('v0.2.0', 'a' * 40)
            (source / 'build-info.json').write_text(json.dumps(dict(version='0.2.0', sha=release.sha, tag=release.tag, official=True)))
            for name in ('ReMarkableBuddiesManager', 'chrome-sandbox', 'chrome_crashpad_handler', 'data.pak'):
                (source / name).write_bytes(b'fixture')
            packages = {}
            for target in TARGETS:
                path = assets / f'manager-{target}.zip'
                archive_package(source, path, linux=target == 'linux-x64')
                packages[path.name] = sha256(path)
            (assets / 'provenance.json').write_text(json.dumps(dict(tag=release.tag, sha=release.sha, version='0.2.0', packages=packages)))
            verify_packages(assets, release)
            with zipfile.ZipFile(assets / 'manager-linux-x64.zip') as archive:
                self.assertEqual((archive.getinfo('ReMarkableBuddiesManager').external_attr >> 16) & 0o777, 0o755)
                self.assertEqual((archive.getinfo('data.pak').external_attr >> 16) & 0o777, 0o644)
            (assets / 'manager-browser.zip').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                verify_packages(assets, release)

    def test_manifest_is_placeholder_and_specs_stay_central(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(json.loads((root / 'package.json').read_text())['version'], '0.0.0')
        self.assertFalse((root / 'openspec').exists())
        self.assertFalse((root / '.codex/skills').exists())
