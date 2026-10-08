"""Container-only synthetic fixture generation and read-only apk observations."""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import tarfile

ROOT = Path("/fixtures")
APK = "/tool/apk"
COMMIT = "1" * 40  # Synthetic package provenance, never a Buddy source identity.


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot():
    result = {}
    for path in [ROOT, *sorted(ROOT.rglob("*"))]:
        info = path.lstat()
        item = {"mode": stat.S_IMODE(info.st_mode)}
        if stat.S_ISREG(info.st_mode):
            item.update(kind="file", size=info.st_size, sha256=sha(path))
        elif stat.S_ISDIR(info.st_mode):
            item.update(kind="directory")
        elif stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            # A link is permitted only when its resolved target stays in the private fixture root.
            if not path.resolve().is_relative_to(ROOT):
                raise ValueError("Fixture symlink escapes root")
            item.update(kind="symlink", target=target)
        else:
            raise ValueError("Unsupported fixture file type")
        result[str(path.relative_to(ROOT))] = item
    return result


def command(args, expected=0, refusal=None):
    # Construct an allowlist: only creation tools during generation, read tools during observation.
    phase = sys.argv[1]
    allowed = {"mkpkg", "mkndx"} if phase == "generate" else {"verify", "version", "query", "info"}
    if args[0] not in allowed:
        raise ValueError("Unapproved apk command")
    forbidden = {"--allow-untrusted", "--force", "--force-broken-world", "--no-verify"}
    if any(arg in forbidden for arg in args):
        raise ValueError("Verification bypass refused")
    before = snapshot() if phase == "observe" else None
    env = {"PATH": "/usr/bin:/bin", "APK_CONFIG": "/fixtures/meta/etc/apk/config", "HOME": "/tmp",
           "LC_ALL": "C", "TMPDIR": "/tmp"}
    common = [APK, "--root", "/fixtures/meta", "--install-root", "/fixtures/payload",
              "--no-network", "--no-cache", "--no-logfile",
              "--repositories-file", "/fixtures/meta/etc/apk/repositories"]
    # Explicit keys prevent inherited system-key fallback; paths are relative to metadata --root.
    completed = subprocess.run(common + args, env=env, capture_output=True, timeout=15)
    if len(completed.stdout) + len(completed.stderr) > 64 * 1024:
        raise ValueError("Tool diagnostic exceeds bound")
    if before is not None and before != snapshot():
        raise ValueError("Read operation mutated fixture inventory/content/mode/link")
    if Path("/tmp/fixture-script-executed").exists():
        raise ValueError("Observation executed package script")
    success = completed.returncode == 0
    if success != (expected == 0):
        raise ValueError(f"Unexpected {args[0]} exit {completed.returncode}")
    classification = "success"
    if expected:
        # app_verify counts failed inputs: this harness passes exactly one file. Crash/usage is not refusal.
        if completed.returncode != 1:
            raise ValueError("Negative case did not return the pinned single-input refusal status")
        labels = {"UNTRUSTED signature": "untrusted-signature", "BAD signature": "bad-signature",
                  "ADB integrity error": "payload-integrity", "file integrity error": "file-integrity"}
        if args[0] == "verify":
            line = completed.stdout.decode("utf-8").strip()
            label = line.rsplit(": ", 1)[-1]
            classification = labels.get(label, "unexpected-error") if not completed.stderr else "unexpected-error"
        elif args[0] == "info":
            diagnostic = (completed.stdout + completed.stderr).decode("utf-8").strip()
            classification = ("unowned-file" if diagnostic ==
                              f"ERROR: {args[-1]}: Could not find owner package" else "unexpected-error")
        if classification not in (refusal or set()):
            seen = [name for label, name in labels.items() if label.encode() in completed.stdout + completed.stderr]
            raise ValueError(f"Wrong {args[0]} {Path(args[-1]).name} refusal classification: {classification}; recognized labels: {seen}")
    record = {"exit_code": completed.returncode,
              "classification": classification,
              "stdout_sha256": hashlib.sha256(completed.stdout).hexdigest(),
              "stderr_sha256": hashlib.sha256(completed.stderr).hexdigest(),
              "diagnostic_bytes": len(completed.stdout) + len(completed.stderr),
              "roots_unchanged": before is not None}
    return completed.stdout.decode("utf-8"), record


def generate():
    for directory in ["meta/etc/apk/keys-good", "meta/etc/apk/keys-wrong", "meta/etc/apk/keys-empty",
                      "meta/lib/apk/db", "payload/usr/share/fixture", "package-files/usr/share/fixture"]:
        (ROOT / directory).mkdir(parents=True)
    (ROOT / "meta/etc/apk/config").write_text("", encoding="utf-8")
    (ROOT / "meta/etc/apk/repositories").write_text("", encoding="utf-8")
    (ROOT / "meta/etc/apk/world").write_text("fixture-package\n", encoding="utf-8")
    (ROOT / "meta/etc/apk/arch").write_text("x86_64\n", encoding="utf-8")
    content = b"fixture-payload-original-contents\n"
    (ROOT / "package-files/usr/share/fixture/owned.txt").write_bytes(content)
    (ROOT / "payload/usr/share/fixture/owned.txt").write_bytes(content)
    (ROOT / "payload/usr/share/fixture/local-link").symlink_to("owned.txt")
    script = ROOT / "post-install.sh"
    script.write_text("#!/bin/sh\ntouch /tmp/fixture-script-executed\n", encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="fixture-keys-", dir="/tmp") as key_temp:
        for name in ["good", "wrong"]:
            private = Path(key_temp) / (name + ".pem")
            subprocess.run(["openssl", "genrsa", "-out", str(private), "2048"],
                           capture_output=True, timeout=15, check=True)
            public = ROOT / f"meta/etc/apk/keys-{name}/{name}.pub"
            subprocess.run(["openssl", "rsa", "-in", str(private), "-pubout", "-out", str(public)],
                           capture_output=True, timeout=15, check=True)
        package = ROOT / "fixture-package-1.2.3-r2.apk"
        command(["mkpkg", "--compression", "none", "--sign-key", str(Path(key_temp) / "good.pem"),
                 "--keys-dir", "etc/apk/keys-good", "--files", str(ROOT / "package-files"),
                 "--output", str(package), "--no-xattrs", "--script", f"post-install:{script}",
                 "--info", "name:fixture-package", "--info", "version:1.2.3-r2", "--info", "arch:x86_64",
                 "--info", "description:fixture-description-original", "--info", f"repo-commit:{COMMIT}",
                 "--info", "origin:fixture-source", "--info", "depends:remarkable-os>=3.0.0 rm2"])
        index = ROOT / "fixture-index.adb"
        command(["mkndx", "--compression", "none", "--sign-key", str(Path(key_temp) / "good.pem"),
                 "--keys-dir", "etc/apk/keys-good", "--output", str(index), str(package)])
    # Equal-length targeted changes preserve container format, changing signed content/data only.
    original = package.read_bytes()
    for name, old, new in [("control", b"fixture-description-original", b"fixture-description-modified"),
                           ("payload", content, b"fixture-payload-modified-contents\n")]:
        if len(old) != len(new) or original.count(old) != 1:
            raise ValueError("Fixture mutation target must be unique and equal length")
        (ROOT / f"tampered-{name}.apk").write_bytes(original.replace(old, new))
    index_bytes = index.read_bytes()
    old, new = b"fixture-description-original", b"fixture-description-modified"
    if len(old) != len(new) or index_bytes.count(old) != 1:
        raise ValueError("Signed index mutation target must be unique and equal length")
    (ROOT / "tampered-index.adb").write_bytes(index_bytes.replace(old, new))
    # Seed documented installed-index format: observation only, no installation.
    installed = ("C:Q1" + "A" * 27 + "=\nP:fixture-package\nV:1.2.3-r2\nA:x86_64\n"
                 "S:1024\nI:32\nT:Synthetic fixture\nL:MIT\no:fixture-source\n"
                 f"c:{COMMIT}\nD:remarkable-os>=3.0.0 rm2\nf:s\nF:usr/share/fixture\nR:owned.txt\n\n")
    (ROOT / "meta/lib/apk/db/installed").write_text(installed, encoding="utf-8")
    # Documented upstream scripts database filename and checksum encoding, not a package producer.
    script_bytes = script.read_bytes()
    with tarfile.open(ROOT / "meta/lib/apk/db/scripts.tar", "w") as archive:
        entry = tarfile.TarInfo("fixture-package-1.2.3-r2.X1" + "0" * 40 + ".post-install")
        entry.size, entry.mode = len(script_bytes), 0o755
        archive.addfile(entry, io.BytesIO(script_bytes))
    return {"private_keys_retained": False, "fixture_package_sha256": sha(package),
            "fixture_index_sha256": sha(index), "synthetic_database_seeded": True}


def observe():
    # Verify container configuration rather than reporting the intended mount flag as proof.
    mount = next((line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines()
                  if line.split()[4] == "/fixtures"), None)
    if mount is None or "ro" not in mount[5].split(","):
        raise ValueError("Observation requires an actual read-only fixture mount")
    cases = []
    package = str(ROOT / "fixture-package-1.2.3-r2.apk")
    index = str(ROOT / "fixture-index.adb")
    for name, path, keys, expected in [
        ("valid-package", package, "good", 0), ("valid-index", index, "good", 0),
        ("missing-key-package", package, "empty", 1), ("wrong-key-package", package, "wrong", 1),
        ("missing-key-index", index, "empty", 1), ("wrong-key-index", index, "wrong", 1),
        ("signed-control-tamper", str(ROOT / "tampered-control.apk"), "good", 1),
        ("signed-index-control-tamper", str(ROOT / "tampered-index.adb"), "good", 1),
        ("signed-payload-tamper", str(ROOT / "tampered-payload.apk"), "good", 1),
    ]:
        refusal = ({"payload-integrity", "file-integrity"} if name == "signed-payload-tamper" else
                   {"bad-signature", "untrusted-signature"} if name in {"signed-control-tamper", "signed-index-control-tamper"} else
                   {"untrusted-signature"})
        _, record = command(["verify", "--keys-dir", f"etc/apk/keys-{keys}", path], expected, refusal)
        cases.append({"name": name, **record})
    stdout, record = command(["version", "--keys-dir", "etc/apk/keys-good", "-t", "1.2.3-r2", "1.2.3-r1"])
    if stdout.strip() != ">":
        raise ValueError("Actual apk must retain pkgrel ordering")
    cases.append({"name": "full-pkgrel-ordering", "comparison": ">", **record})
    stdout, record = command(["query", "--keys-dir", "etc/apk/keys-good", "--from", "installed", "--format", "json",
                              "--fields", "name,version,arch,commit,origin,depends,status,scripts", "fixture-package"])
    parsed = json.loads(stdout)
    package_info = parsed[0] if isinstance(parsed, list) else parsed
    expected = {"name": "fixture-package", "version": "1.2.3-r2", "arch": "x86_64",
                "commit": COMMIT, "origin": "fixture-source"}
    if any(package_info.get(key) != value for key, value in expected.items()):
        raise ValueError("Seeded database query failed exact metadata readback")
    if "rm2" not in package_info.get("depends", []) or "installed" not in package_info.get("status", []):
        raise ValueError("Seeded database dependency/status missing")
    if package_info.get("scripts") != ["post-install"] or "broken-script" not in package_info.get("status", []):
        raise ValueError("Seeded script names/failure status were not observed")
    cases.append({"name": "seeded-full-installed-metadata", "metadata": package_info, **record})
    stdout, record = command(["info", "--keys-dir", "etc/apk/keys-good", "--who-owns", "/usr/share/fixture/owned.txt"])
    if "fixture-package" not in stdout or "1.2.3-r2" not in stdout:
        raise ValueError("Seeded ownership query lost full package identity")
    cases.append({"name": "seeded-owned-file", **record})
    _, record = command(["info", "--keys-dir", "etc/apk/keys-good", "--who-owns", "/usr/share/fixture/unowned.txt"],
                        1, {"unowned-file"})
    cases.append({"name": "seeded-unowned-file-refusal", **record})
    final = snapshot()
    return {"cases": cases, "snapshot_sha256": hashlib.sha256(json.dumps(final, sort_keys=True).encode()).hexdigest(),
            "read_only_mount": True, "network": "none", "scripts_executed": False}


if __name__ == "__main__":
    if len(sys.argv) != 3 or sha(Path(APK)) != sys.argv[2]:
        raise ValueError("Exact supplied apk binary digest required")
    if sys.argv[1] not in {"generate", "observe"}:
        raise ValueError("Unsupported fixture phase")
    try:
        print(json.dumps(generate() if sys.argv[1] == "generate" else observe()))
    except ValueError as error:
        # Only our own bounded assertion text; never forward tool diagnostics/script output.
        print(json.dumps({"failure": str(error)[:256]}))
        sys.exit(1)
