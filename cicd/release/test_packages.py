"""Project ZIP identity/modes and corruption controls; no application compilation."""
import json
import hashlib
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
            oracle = "resources/host/buddy-oracle/reader-buddy"
            existing_executables = {"ReMarkableBuddiesManager", "chrome-sandbox", "chrome_crashpad_handler"}
            members = {
                "index.html": b"synthetic only",
                **{name: b"synthetic executable marker" for name in existing_executables},
                "reader-buddy": b"unrelated root entry",
                "resources/host/other/reader-buddy": b"unrelated resource entry",
            }
            for directory in ("dist/manager/browser", "out/packages/ReMarkableBuddiesManager-win32-x64",
                              "out/packages/ReMarkableBuddiesManager-linux-x64"):
                for member, content in members.items():
                    file = root / directory / member
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(content)
            pin = dict(schema=1, repository="s116821/ReMarkableBuddies", sourceSha="1" * 40,
                       sourceTree="2" * 40, cargoLockSha256="3" * 64, sdkRevision="4" * 40)
            (root / "host").mkdir()
            pin_path = root / "host/buddy-oracle-source.json"
            pin_path.write_text(json.dumps(pin))
            retained = root / "retained"
            payload = b"\x00synthetic oracle\r\n\xff"
            notice_root = "resources/host/third-party/buddy-oracle/"
            license_bytes = b"Synthetic Buddy license fixture.\n"
            for platform, target, filename in (
                ("win32", "x86_64-pc-windows-msvc", "reader-buddy.exe"),
                ("linux", "x86_64-unknown-linux-gnu", "reader-buddy"),
            ):
                host = root / f"out/packages/ReMarkableBuddiesManager-{platform}-x64/resources/host"
                (host / "buddy-oracle-source.json").write_bytes(pin_path.read_bytes())
                resource = retained / target / "buddy-oracle"
                resource.mkdir(parents=True)
                (resource / filename).write_bytes(payload)
                provenance = dict(schema=1, source=pin, target=target, profile="release", features=[],
                    rustc="rustc synthetic fixture", version="dev.fixture-1-g1111111",
                    executable=dict(name=filename, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                (resource / "provenance.json").write_text(json.dumps(provenance))
                notices = resource.parent / "notices"
                notices.mkdir()
                (notices / "BUDDY-LICENSE").write_bytes(license_bytes)
                (notices / "BUDDY-THIRD-PARTY-NOTICES.md").write_bytes(b"Synthetic Buddy notices.\n")
            packages = root / "packages"
            with patch("build.source_identity") as source:
                hosts = [root / f"out/packages/ReMarkableBuddiesManager-{platform}-x64/resources/host"
                         for platform in ("win32", "linux")]
                packages.mkdir()
                with self.assertRaises(FileExistsError):
                    assemble(root, candidate, packages, oracle_root=retained)
                self.assertTrue(all(not (host / "buddy-oracle").exists() for host in hosts))
                self.assertTrue(all(not (host / "third-party/buddy-oracle").exists() for host in hosts))
                packages.rmdir()
                second_notices = retained / "x86_64-unknown-linux-gnu/notices"
                saved_notices = {path.name: path.read_bytes() for path in second_notices.iterdir()}
                for name in saved_notices:
                    (second_notices / name).unlink()
                with self.assertRaisesRegex(ValueError, "notices"):
                    assemble(root, candidate, packages, oracle_root=retained)
                self.assertFalse(packages.exists())
                self.assertTrue(all(not (host / "buddy-oracle").exists() for host in hosts))
                self.assertTrue(all(not (host / "third-party/buddy-oracle").exists() for host in hosts))
                for name, content in saved_notices.items():
                    (second_notices / name).write_bytes(content)
                blocked_parent = hosts[1] / "third-party"
                blocked_parent.write_bytes(b"existing unrelated file")
                with self.assertRaisesRegex(ValueError, "destination parent"):
                    assemble(root, candidate, packages, oracle_root=retained)
                self.assertFalse(packages.exists())
                self.assertTrue(all(not (host / "buddy-oracle").exists() for host in hosts))
                self.assertFalse((hosts[0] / "third-party").exists())
                self.assertEqual(blocked_parent.read_bytes(), b"existing unrelated file")
                blocked_parent.unlink()
                source.reset_mock()
                assemble(root, candidate, packages, oracle_root=retained)
                source.assert_called_once_with(root, candidate)
            verified = verify_packages(packages, candidate, oracle_root=retained, repo=root)
            self.assertEqual(set(packages.iterdir()), {packages / name for name in verified["packages"]} | {packages / "provenance.json"})
            self.assertEqual(set(verified["packages"]), {
                "manager-browser.zip", "manager-linux-x64.zip", "manager-win32-x64.zip",
            })
            for filename in verified["packages"]:
                directory = root / ("dist/manager/browser" if filename == "manager-browser.zip" else
                    "out/packages/ReMarkableBuddiesManager-" + filename.removeprefix("manager-").removesuffix(".zip"))
                member_bytes = {file.relative_to(directory).as_posix(): file.read_bytes()
                                for file in directory.rglob("*") if file.is_file()}
                executable_paths = existing_executables | {oracle} if filename == "manager-linux-x64.zip" else set()
                with zipfile.ZipFile(packages / filename) as archive:
                    self.assertCountEqual(archive.namelist(), member_bytes)
                    for member, content in member_bytes.items():
                        with self.subTest(archive=filename, member=member):
                            self.assertEqual(archive.read(member), content)
                            mode = archive.getinfo(member).external_attr >> 16
                            self.assertEqual(mode, stat.S_IFREG | (0o755 if member in executable_paths else 0o644))
                    if filename == "manager-browser.zip":
                        self.assertFalse(any(name.startswith("resources/host/buddy-oracle") for name in archive.namelist()))
                    else:
                        command = oracle if "linux" in filename else oracle + ".exe"
                        self.assertEqual(archive.read(command), payload)
                        self.assertEqual(archive.read(notice_root + "BUDDY-LICENSE"), license_bytes)
            # Trusted original inputs are independent of the candidate ZIP metadata.
            pin_path.write_text(json.dumps(dict(pin, sourceSha="9" * 40)))
            with self.assertRaisesRegex(ValueError, "bundle-refused"):
                verify_packages(packages, candidate, oracle_root=retained, repo=root)
            pin_path.write_text(json.dumps(pin))
            original = retained / "x86_64-pc-windows-msvc/buddy-oracle/provenance.json"
            original_bytes = original.read_bytes()
            original.write_bytes(original_bytes + b" ")
            with self.assertRaisesRegex(ValueError, "bundle-refused"):
                verify_packages(packages, candidate, oracle_root=retained, repo=root)
            original.write_bytes(original_bytes)
            self.assertEqual(verify_packages(packages, candidate, oracle_root=retained, repo=root), verified)
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
                for member in existing_executables | {oracle}:
                    self.assertEqual(stat.S_IMODE((dest / member).stat().st_mode), 0o755)
                self.assertEqual((dest / oracle).read_bytes(), payload)
                for file in ("dist/manager/browser/build-info.json", "electron/build-info.json"):
                    self.assertEqual(json.loads((checkout / file).read_text()), info)
            manifest_path = packages / "provenance.json"
            license_path = notice_root + "BUDDY-LICENSE"
            modified = b"!" + license_bytes[1:]
            for filename in ("manager-linux-x64.zip", "manager-win32-x64.zip"):
                target = packages / filename
                original_zip = target.read_bytes()
                with zipfile.ZipFile(target) as archive:
                    entries = [(entry, archive.read(entry)) for entry in archive.infolist()]
                for mutation in ("changed", "missing", "extra"):
                    with self.subTest(archive=filename, notice=mutation):
                        with zipfile.ZipFile(target, "w") as archive:
                            for entry, content in entries:
                                if entry.filename == license_path:
                                    if mutation == "missing":
                                        continue
                                    if mutation == "changed":
                                        content = modified
                                archive.writestr(entry, content)
                            if mutation == "extra":
                                entry = zipfile.ZipInfo(notice_root + "EXTRA-NOTICE")
                                entry.create_system = 3
                                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                                archive.writestr(entry, b"Added notice")
                        candidate_manifest = dict(verified, packages={**verified["packages"], filename: sha256(target)})
                        manifest_path.write_text(json.dumps(candidate_manifest))
                        self.assertEqual(verify_packages(packages, candidate), candidate_manifest)
                        with self.assertRaisesRegex(ValueError, "bundle-refused"):
                            verify_packages(packages, candidate, oracle_root=retained, repo=root)
                target.write_bytes(original_zip)
                manifest_path.write_text(json.dumps(verified))
            # A self-consistent manifest cannot authorize a different embedded identity.
            target = packages / "manager-browser.zip"
            with zipfile.ZipFile(target, "w") as archive:
                archive.writestr("build-info.json", json.dumps(dict(info, sha="b" * 40)))
            verified["packages"][target.name] = sha256(target)
            (packages / "provenance.json").write_text(json.dumps(verified))
            with self.assertRaisesRegex(ValueError, "bundle-refused"):
                verify_packages(packages, candidate)
            (packages / "unexpected").write_text("extra asset")
            with self.assertRaisesRegex(ValueError, "bundle-refused"):
                verify_packages(packages, candidate)
