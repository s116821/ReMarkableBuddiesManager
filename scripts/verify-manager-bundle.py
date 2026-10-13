"""Bounded offline metadata observation; never extracts or executes ZIP payloads."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import types
import zipfile

PACKAGES = ("manager-browser.zip", "manager-win32-x64.zip", "manager-linux-x64.zip")
MAX_PACKAGE = 512 * 1024 * 1024
WINDOWS = os.name == "nt"
PINS = {
    "policy.py": "e10acd03ad0ea879a0cd7bcd45399089a10022bd054a5d08cd24b491c56da1bc",
    "coordinator.py": "fb6115ee9903513fc1860f47af4e43379e11dc81e889886df5d99e88d25e1f6a",
}


def refuse():
    raise ValueError("bundle-refused")


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def opened(before, source):
    handle = os.fstat(source.fileno())
    if not stat.S_ISREG(handle.st_mode) or handle.st_size != before.st_size:
        refuse()
    # Windows path/descriptor APIs can report different identity/time tuples.
    # Bracket each API in its own domain; content hashes bind actual ZIP bytes.
    if not WINDOWS and identity(before) != identity(handle):
        refuse()
    return handle


def regular(path, limit):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
        refuse()
    return info


def bounded_read(path, limit):
    before = regular(path, limit)
    with path.open("rb") as source:
        handle = opened(before, source)
        data = source.read(limit + 1)
        if len(data) > limit or identity(handle) != identity(os.fstat(source.fileno())):
            refuse()
    if identity(before) != identity(path.lstat()):
        refuse()
    return data


def pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            refuse()
        value[key] = item
    return value


def decode(data, limit):
    if not 0 < len(data) <= limit:
        refuse()
    return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: refuse())


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        refuse()


def qualified_producer():
    # Only hash-qualified trusted checkout code is compiled, never archive data.
    root = Path(__file__).resolve().parent.parent / "release"
    modules = {}
    for filename, expected in PINS.items():
        path = root / filename
        data = bounded_read(path, 64 * 1024)
        if hashlib.sha256(data).hexdigest() != expected:
            refuse()
        name = "policy" if filename == "policy.py" else "_qualified_manager_coordinator"
        module = types.ModuleType(name)
        module.__file__ = str(path)
        sys.modules[name] = module
        exec(compile(data, str(path), "exec"), module.__dict__)
        modules[filename] = module
    return modules["coordinator.py"]


def observe_zip(path, expected, expected_digest):
    before = regular(path, MAX_PACKAGE)
    with path.open("rb") as source:
        handle = opened(before, source)
        if before.st_size < 68:
            refuse()
        digest = hashlib.sha256()
        count = 0
        while data := source.read(64 * 1024):
            count += len(data)
            if count > before.st_size or count > MAX_PACKAGE:
                refuse()
            digest.update(data)
        if count != before.st_size or digest.hexdigest() != expected_digest:
            refuse()
        source.seek(-22, os.SEEK_END)
        end = struct.unpack("<4s4H2LH", source.read(22))
        signature, disk, directory_disk, disk_count, count, directory_size, offset, comment_size = end
        # Current producer writes seekable ordinary ZIPs with no comment/ZIP64.
        # Bound central-directory allocation before standard ZipFile loads it.
        if (signature != b"PK\x05\x06" or disk or directory_disk or disk_count != count
                or not 0 < count <= 4096 or not 0 < directory_size <= 2 * 1024 * 1024
                or offset <= 0 or offset + directory_size != before.st_size - 22 or comment_size):
            refuse()
        source.seek(-42, os.SEEK_END)
        if source.read(4) == b"PK\x06\x07":
            refuse()
        source.seek(0)
        if source.read(4) != b"PK\x03\x04":
            refuse()
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) != count or archive.comment:
                refuse()
            names = set()
            expanded = 0
            for entry in entries:
                name = entry.filename
                if (name != entry.orig_filename or not name or len(name.encode("utf-8")) > 512
                        or "\\" in name or ":" in name or name.startswith("/")
                        or any(ord(c) < 32 or ord(c) == 127 for c in name)
                        or any(part in {"", ".", ".."} for part in name.split("/"))
                        or str(PurePosixPath(name)) != name or name in names
                        or entry.is_dir() or entry.create_system != 3
                        or not stat.S_ISREG(entry.external_attr >> 16)
                        or entry.extra or entry.comment or entry.flag_bits & ~0x800
                        or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                        or entry.file_size < 0 or entry.compress_size < 0
                        or entry.header_offset < 0 or entry.header_offset >= offset
                        or entry.compress_size > MAX_PACKAGE):
                    refuse()
                names.add(name)
                expanded += entry.file_size
                if expanded > 2 * 1024 * 1024 * 1024:
                    refuse()
            if "build-info.json" not in names:
                refuse()
            metadata = archive.getinfo("build-info.json")
            if not 0 < metadata.file_size <= 16 * 1024 or metadata.compress_size > 64 * 1024:
                refuse()
            with archive.open(metadata) as member:
                data = member.read(16 * 1024 + 1)
            value = decode(data, 16 * 1024)
            exact(value, ("version", "sha", "tag", "official"))
            if value != expected or value["official"] is not True:
                refuse()
        if identity(handle) != identity(os.fstat(source.fileno())):
            refuse()
    if identity(before) != identity(path.lstat()):
        refuse()


def verify(directory, tag, sha):
    if sys.version_info[:2] != (3, 12) or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag) or len(tag) > 64 or not re.fullmatch(r"[a-f0-9]{40}", sha):
        refuse()
    root = Path(directory)
    if not root.is_absolute() or root.resolve() != root or root.is_symlink() or not root.is_dir():
        refuse()
    if {p.name for p in root.iterdir()} != set(PACKAGES) | {"provenance.json"}:
        refuse()
    manifest = root / "provenance.json"
    regular(manifest, 64 * 1024)
    provenance = decode(bounded_read(manifest, 64 * 1024), 64 * 1024)
    exact(provenance, ("tag", "sha", "version", "packages"))
    exact(provenance["packages"], PACKAGES)
    if (provenance["tag"], provenance["sha"], provenance["version"]) != (tag, sha, tag[1:]):
        refuse()
    if any(not isinstance(v, str) or not re.fullmatch(r"[a-f0-9]{64}", v) for v in provenance["packages"].values()):
        refuse()
    if sum(regular(root / name, MAX_PACKAGE).st_size for name in PACKAGES) + manifest.stat().st_size > 768 * 1024 * 1024:
        refuse()
    expected = {"version": tag[1:], "sha": sha, "tag": tag, "official": True}
    for name in PACKAGES:
        observe_zip(root / name, expected, provenance["packages"][name])
    # Reuse the unchanged pure identity validator. Do not call the producer's
    # unbounded pathname-based ZIP/manifest rereads on downloaded input.
    producer = qualified_producer()
    producer.verify_identity(provenance, producer.Release(tag, sha))
    return {"ok": True, "embeddedIdentityVerified": True, "archivesExtracted": False, "payloadExecuted": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            refuse()
        result = verify(*sys.argv[1:])
        sys.stdout.buffer.write(json.dumps(result, separators=(",", ":")).encode("ascii") + b"\n")
    except Exception:
        # No path, archive content, interpreter or inherited diagnostic disclosure.
        sys.stdout.buffer.write(b'{"ok":false,"code":"bundle-refused"}\n')
        sys.exit(1)
