"""Generate real test ZIPs through the unchanged publisher; payload is synthetic."""

import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import struct
import sys
import warnings
import zipfile

# Exact current producer fixture, not runtime build-engine code.
repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "host/qualified-producer"))
builder_path = Path(__file__).with_name("current-manager-build.py")
assert hashlib.sha256(builder_path.read_bytes()).hexdigest() == "5fc651228ef50c5231b71ff91a2c688aade622c2a7a7c685cfbde08a8d660670"
spec = importlib.util.spec_from_file_location("_current_manager_build_fixture", builder_path)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
archive_package = builder.archive_package

root, tag, sha, mode = sys.argv[1:]
root = Path(root)
payload = root / "payload"
payload.mkdir(parents=True)
info = {"version": tag[1:], "sha": sha, "tag": tag, "official": True}
if mode == "wrong-version":
    info["version"] = "9.9.9"
elif mode == "wrong-source":
    info["sha"] = "d" * 40
elif mode == "official-number":
    info["official"] = 1
elif mode == "unknown-field":
    info["unexpected"] = True
data = json.dumps(info)
if mode == "duplicate-json":
    data = data.replace('"official": true', '"official": false,"official":true')
if mode == "oversized-json":
    data += " " * (16 * 1024)
(payload / "build-info.json").write_text(data)
(payload / "fixture-payload.txt").write_text("Synthetic fixture only; NEVER_EXECUTE_OR_EXTRACT\n")
if mode == "missing-build-info":
    (payload / "build-info.json").unlink()
names = ("manager-browser.zip", "manager-win32-x64.zip", "manager-linux-x64.zip")
for name in names:
    archive_package(payload, root / name, linux="linux" in name)
bad = root / names[0]
if mode in {"path-traversal", "duplicate-entry", "symlink-entry", "encrypted", "bad-compression"}:
    warnings.simplefilter("ignore", UserWarning)
    with zipfile.ZipFile(bad, "a") as archive:
        name = "../escape" if mode == "path-traversal" else "build-info.json" if mode == "duplicate-entry" else "extra"
        entry = zipfile.ZipInfo(name)
        entry.create_system = 3
        entry.external_attr = ((stat.S_IFLNK if mode == "symlink-entry" else stat.S_IFREG) | 0o644) << 16
        archive.writestr(entry, b"/unrelated-user-file" if mode == "symlink-entry" else b"fixture")
if mode == "eocd-comment":
    with zipfile.ZipFile(bad, "a") as archive:
        archive.comment = b"unsupported"
raw = bytearray(bad.read_bytes())
if mode == "central-bomb":
    struct.pack_into("<L", raw, len(raw) - 10, 2 * 1024 * 1024 + 1)
elif mode == "entry-count-bomb":
    struct.pack_into("<HH", raw, len(raw) - 14, 5000, 5000)
elif mode == "zip64-locator":
    raw[-42:-38] = b"PK\x06\x07"
elif mode == "truncated-archive":
    raw = raw[:-8]
elif mode in {"expanded-bomb", "encrypted", "bad-compression", "crc-tamper"}:
    offset = raw.index(b"PK\x01\x02")
    if mode == "expanded-bomb":
        struct.pack_into("<L", raw, offset + 24, 2 * 1024 * 1024 * 1024 + 1)
    elif mode == "encrypted":
        struct.pack_into("<H", raw, offset + 8, 1)
    elif mode == "bad-compression":
        struct.pack_into("<H", raw, offset + 10, 99)
    else:
        struct.pack_into("<L", raw, offset + 16, 0)
bad.write_bytes(raw)
packages = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}
(root / "provenance.json").write_text(json.dumps({"tag": tag, "sha": sha, "version": tag[1:], "packages": packages}))
