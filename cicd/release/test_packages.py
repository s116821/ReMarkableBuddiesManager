"""Project ZIP identity/modes and corruption controls; no application compilation."""
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import zipfile
from artifacts import Release, sha256
from build import assemble, verify_packages

class PackageControls(unittest.TestCase):
    def test_assembled_inventory_identity_modes_and_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            candidate = Release("v0.4.1", "a" * 40)
            info = dict(version="0.4.1", sha=candidate.sha, tag=candidate.tag, official=True)
            (root / "electron").mkdir()
            (root / "electron/build-info.json").write_text(json.dumps(info))
            for directory in ("dist/manager/browser", "out/packages/ReMarkableBuddiesManager-win32-x64",
                              "out/packages/ReMarkableBuddiesManager-linux-x64"):
                dest = root / directory; dest.mkdir(parents=True)
                (dest / "index.html").write_text("synthetic only")
                (dest / "ReMarkableBuddiesManager").write_text("synthetic executable marker")
            packages = root / "packages"
            with patch("build.source_identity") as source:
                assemble(root, candidate, packages)
                source.assert_called_once_with(root, candidate)
            verified = verify_packages(packages, candidate)
            self.assertEqual(set(packages.iterdir()), {packages / name for name in verified["packages"]} | {packages / "provenance.json"})
            for filename, executable in (("manager-linux-x64.zip", True), ("manager-win32-x64.zip", False)):
                with zipfile.ZipFile(packages / filename) as archive:
                    mode = archive.getinfo("ReMarkableBuddiesManager").external_attr >> 16
                    self.assertEqual(stat.S_IMODE(mode), 0o755 if executable else 0o644)
            # Execute the actual standard Linux extractor on the generated CI ZIP.
            import os
            if os.name != "nt":
                # A fresh checkout has electron/, but neither generated parent chain.
                checkout = root / "fresh-checkout"
                (checkout / "electron").mkdir(parents=True)
                self.assertFalse((checkout / "dist").exists())
                self.assertFalse((checkout / "out").exists())
                pipeline = (Path(__file__).resolve().parents[2] / ".github/workflows/pipeline.yml").read_text()
                step = pipeline.split("      - name: Extract verified Linux artifacts without rebuilding\n", 1)[1].split("      - name:", 1)[0]
                commands = textwrap.dedent(step.split("        run: |\n", 1)[1])
                subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", commands],
                               cwd=checkout, env=dict(os.environ, RUNNER_TEMP=str(root)), check=True)
                dest = checkout / "out/packages/ReMarkableBuddiesManager-linux-x64"
                self.assertEqual(stat.S_IMODE((dest / "ReMarkableBuddiesManager").stat().st_mode), 0o755)
                for file in ("dist/manager/browser/build-info.json", "electron/build-info.json"):
                    self.assertEqual(json.loads((checkout / file).read_text()), info)
            # A self-consistent manifest cannot authorize a different embedded identity.
            target = packages / "manager-browser.zip"
            with zipfile.ZipFile(target, "w") as archive:
                archive.writestr("build-info.json", json.dumps(dict(info, sha="b" * 40)))
            verified["packages"][target.name] = sha256(target)
            (packages / "provenance.json").write_text(json.dumps(verified))
            with self.assertRaisesRegex(ValueError, "Embedded"):
                verify_packages(packages, candidate)
            (packages / "unexpected").write_text("extra asset")
            with self.assertRaisesRegex(ValueError, "Unexpected or missing"):
                verify_packages(packages, candidate)
