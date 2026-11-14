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
oracle = "resources/host/buddy-oracle"
oracle_pin = oracle + "-source.json"
oracle_provenance = oracle + "/provenance.json"


def append_member(archive, name, content, mode=0o644):
    entry = zipfile.ZipInfo(name)
    entry.create_system = 3
    entry.external_attr = (stat.S_IFREG | mode) << 16
    entry.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(entry, content)


def append_oracle(package, mode):
    linux = "linux" in package.name
    filename = "reader-buddy" if linux else "reader-buddy.exe"
    payload = b"Synthetic oracle: never execute.\x00\xff" * 4096
    pin = dict(schema=1, repository="s116821/ReMarkableBuddies", sourceSha="1" * 40,
               sourceTree="2" * 40, cargoLockSha256="3" * 64, sdkRevision="4" * 40)
    if linux and mode == "oracle-platform-pin":
        pin["sourceSha"] = "5" * 40
    provenance = dict(schema=1, source=dict(pin), target="x86_64-unknown-linux-gnu" if linux else "x86_64-pc-windows-msvc",
                      profile="release", features=[], rustc="rustc synthetic", version="dev.v0.1.0-1-g1111111",
                      executable=dict(name=filename, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
    if linux and mode == "oracle-local-pin":
        provenance["source"]["sourceSha"] = "5" * 40
    elif linux and mode == "oracle-target":
        provenance["target"] = "x86_64-pc-windows-msvc"
    elif linux and mode == "oracle-digest":
        provenance["executable"]["sha256"] = "0" * 64
    elif linux and mode == "oracle-size":
        provenance["executable"]["bytes"] += 1
    elif linux and mode == "oracle-boolean-size":
        provenance["executable"]["bytes"] = True
    elif linux and mode == "oracle-version":
        provenance["version"] = "dev.unknown"
    data = json.dumps(provenance).encode()
    if linux and mode == "oracle-duplicate-json":
        data = data.replace(b'"schema": 1', b'"schema": 2, "schema": 1', 1)
    if linux and mode == "oracle-oversized-json":
        data += b" " * (16 * 1024)
    with zipfile.ZipFile(package, "a") as archive:
        if mode != "oracle-missing-pin" or not linux:
            append_member(archive, oracle_pin, json.dumps(pin).encode())
        append_member(archive, oracle_provenance, data)
        if mode != "oracle-partial" or not linux:
            member = oracle + "/" + filename
            if linux and mode == "oracle-wrong-name":
                member += ".exe"
            append_member(archive, member, payload, 0o755 if linux and mode != "oracle-mode" else 0o644)
        if linux and mode == "oracle-extra":
            append_member(archive, oracle + "/extra", b"unexpected")
        if not linux and mode == "oracle-alias":
            append_member(archive, "Resources/host/buddy-oracle. /reader-buddy.exe", b"aliased")
        if not linux and mode == "oracle-ancestor":
            append_member(archive, "RESOURCES/HOST", b"file blocking the expected directory")
        if not linux and mode == "oracle-short-alias":
            append_member(archive, "RESOUR~1/host/buddy-oracle/reader-buddy.exe", b"aliased")
        if not linux and mode == "oracle-pin-alias":
            append_member(archive, oracle_pin.upper() + ".", b"aliased")
    if linux and mode == "oracle-crc":
        raw = bytearray(package.read_bytes())
        offset = raw.index(b"PK\x01\x02")
        while offset < len(raw) and raw[offset:offset + 4] == b"PK\x01\x02":
            name_size, extra_size, comment_size = struct.unpack_from("<HHH", raw, offset + 28)
            if raw[offset + 46:offset + 46 + name_size] == (oracle + "/" + filename).encode():
                struct.pack_into("<L", raw, offset + 16, 0)
                break
            offset += 46 + name_size + extra_size + comment_size
        else:
            raise AssertionError("missing fixture member")
        package.write_bytes(raw)


for name in names:
    archive_package(payload, root / name, linux="linux" in name)
    if mode == "legacy-with-pin" and name != names[0]:
        with zipfile.ZipFile(root / name, "a") as archive:
            append_member(archive, oracle_pin, b'{"legacy":"no oracle payload"}')
    if mode.startswith("oracle-") and (name != names[0] or mode == "oracle-browser"):
        if mode != "oracle-one-platform" or name != names[1]:
            append_oracle(root / name, mode)
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
