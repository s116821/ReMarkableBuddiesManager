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
MAX_METADATA = 16 * 1024
ORACLE_REQUIRED_FROM = (1, 0, 0)
ORACLE_PATH = "resources/host/buddy-oracle"
ORACLE_PIN = ORACLE_PATH + "-source.json"
ORACLE_PROVENANCE = ORACLE_PATH + "/provenance.json"
ORACLE_NOTICES = "resources/host/third-party/buddy-oracle"
MAX_NOTICE = 16 * 1024 * 1024
MAX_NOTICES = 32 * 1024 * 1024
ORACLE_PLATFORMS = {
    "manager-win32-x64.zip": ("reader-buddy.exe", "x86_64-pc-windows-msvc", 0o644),
    "manager-linux-x64.zip": ("reader-buddy", "x86_64-unknown-linux-gnu", 0o755),
}
WINDOWS = os.name == "nt"
PINS = {
    "artifacts.py": "4c0386ae79b1de55f84bea1cb349e62620ef2a763d90c0366a939aec37cdc94c",
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


def stream_digest(source, size):
    digest = hashlib.sha256()
    count = 0
    while data := source.read(64 * 1024):
        count += len(data)
        if count > size:
            refuse()
        digest.update(data)
    if count != size:
        refuse()
    return digest.hexdigest()


def file_receipt(path, limit):
    before = regular(path, limit)
    with path.open("rb") as source:
        handle = opened(before, source)
        digest = stream_digest(source, before.st_size)
        if identity(handle) != identity(os.fstat(source.fileno())):
            refuse()
    if identity(before) != identity(path.lstat()):
        refuse()
    return {"bytes": before.st_size, "sha256": digest}


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


def hexadecimal(value, length):
    return type(value) is str and len(value) == length and re.fullmatch(r"[a-f0-9]+", value) is not None


def member_json(archive, name, mode=None):
    entry = archive.getinfo(name)
    if (not 0 < entry.file_size <= MAX_METADATA or not 0 < entry.compress_size <= 64 * 1024
            or (mode is not None and entry.external_attr >> 16 != (stat.S_IFREG | mode))):
        refuse()
    with archive.open(entry) as member:
        data = member.read(MAX_METADATA + 1)
    if len(data) != entry.file_size:
        refuse()
    return data, decode(data, MAX_METADATA)


def verify_source(value):
    exact(value, ("schema", "repository", "sourceSha", "sourceTree", "cargoLockSha256", "sdkRevision"))
    if (type(value["schema"]) is not int or value["schema"] != 1
            or value["repository"] != "s116821/ReMarkableBuddies"
            or not all(hexadecimal(value[key], 40) for key in ("sourceSha", "sourceTree", "sdkRevision"))
            or not hexadecimal(value["cargoLockSha256"], 64)):
        refuse()


def short_name(part, prefix):
    base = part.split(".", 1)[0]
    return (len(base) <= 8 and part.startswith(prefix)
            and re.fullmatch(r"[^. ~]{1,6}~[0-9]+(?:\.[^. ]{1,3})?", part) is not None)


def oracle_members(names, windows):
    root = ORACLE_PATH.split("/")
    pin = ORACLE_PIN.split("/")
    # The ZIP parser has already rejected slash, stream, and relative aliases.
    # Windows also folds case and can ignore trailing dots and spaces.
    subtree = set()
    for name in names:
        parts = name.split("/")
        key = [part.rstrip(" .").upper().casefold() for part in parts] if windows else parts
        if "" in key or key == root[:len(key)]:
            refuse()
        if key[:len(root)] == root:
            subtree.add(name)
        if key[:len(pin)] == pin and name != ORACLE_PIN:
            refuse()
        # Refuse DOS short-name spellings at the long resource namespace levels.
        if windows and (short_name(key[0], "re") or (
                len(key) >= 3 and key[:2] == root[:2] and short_name(key[2], "bu"))):
            refuse()
    return subtree


def verify_member(archive, name, size, digest, mode, limit):
    entry = archive.getinfo(name)
    if (type(size) is not int or not 0 < size <= limit or not hexadecimal(digest, 64)
            or entry.file_size != size or not 0 < entry.compress_size <= MAX_PACKAGE
            or entry.external_attr >> 16 != (stat.S_IFREG | mode)
            or (entry.compress_type == zipfile.ZIP_STORED and entry.compress_size != size)):
        refuse()
    # ZipFile checks the member CRC at EOF.
    with archive.open(entry) as member:
        if stream_digest(member, size) != digest:
            refuse()


def observe_notices(archive, names, expected, windows):
    root = ORACLE_NOTICES.split("/")
    members = set()
    for name in names:
        parts = name.split("/")
        key = [part.rstrip(" .").upper().casefold() for part in parts] if windows else parts
        if key == root[:len(key)]:
            refuse()
        if key[:len(root)] == root:
            members.add(name)
        if windows and key[:2] == root[:2] and len(key) >= 3:
            if short_name(key[2], "th") or (
                    len(key) >= 4 and key[:3] == root[:3] and short_name(key[3], "bu")):
                refuse()
    if members != set(expected):
        refuse()
    remaining = MAX_NOTICES
    for name, receipt in expected.items():
        exact(receipt, ("bytes", "sha256"))
        size = receipt["bytes"]
        verify_member(archive, name, size, receipt["sha256"], 0o644, min(MAX_NOTICE, remaining))
        remaining -= size


def observe_oracle(archive, names, package, expected_source, provenance_digest, expected_notices):
    subtree = oracle_members(names, package != "manager-linux-x64.zip")
    platform = ORACLE_PLATFORMS.get(package)
    if not subtree:
        return None
    if platform is None:
        refuse()
    filename, target, mode = platform
    executable_path = ORACLE_PATH + "/" + filename
    if subtree != {ORACLE_PROVENANCE, executable_path} or ORACLE_PIN not in names:
        refuse()
    _, pin = member_json(archive, ORACLE_PIN, 0o644)
    raw, provenance = member_json(archive, ORACLE_PROVENANCE, 0o644)
    verify_source(pin)
    exact(provenance, ("schema", "source", "target", "profile", "features", "rustc", "version", "executable"))
    verify_source(provenance["source"])
    rustc, version = provenance["rustc"], provenance["version"]
    if (type(provenance["schema"]) is not int or provenance["schema"] != 1
            or provenance["source"] != pin or provenance["target"] != target
            or provenance["profile"] != "release" or provenance["features"] != []
            or type(rustc) is not str or not re.fullmatch(r"[\x20-\x7e]{1,256}", rustc)
            or type(version) is not str or not re.fullmatch(r"dev\.[\x21-\x7e]{1,124}", version)
            or version == "dev.unknown"):
        refuse()
    if ((expected_source is not None and pin != expected_source)
            or (provenance_digest is not None and hashlib.sha256(raw).hexdigest() != provenance_digest)):
        refuse()
    executable = provenance["executable"]
    exact(executable, ("name", "bytes", "sha256"))
    if executable["name"] != filename:
        refuse()
    verify_member(archive, executable_path, executable["bytes"], executable["sha256"], mode, MAX_PACKAGE)
    if expected_notices is not None:
        observe_notices(archive, names, expected_notices, package == "manager-win32-x64.zip")
    return pin


def qualified_producer():
    # Only hash-qualified trusted checkout code is compiled, never archive data.
    root = Path(__file__).resolve().parent.parent / "host/qualified-producer"
    modules = {}
    for filename, expected in PINS.items():
        path = root / filename
        data = bounded_read(path, 64 * 1024)
        if hashlib.sha256(data).hexdigest() != expected:
            refuse()
        name = "_qualified_manager_artifacts"
        module = types.ModuleType(name)
        module.__file__ = str(path)
        sys.modules[name] = module
        exec(compile(data, str(path), "exec"), module.__dict__)
        modules[filename] = module
    return modules["artifacts.py"]


def observe_zip(path, expected, expected_digest, expected_source, provenance_digest, expected_notices):
    before = regular(path, MAX_PACKAGE)
    with path.open("rb") as source:
        handle = opened(before, source)
        if before.st_size < 68:
            refuse()
        if stream_digest(source, before.st_size) != expected_digest:
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
            _, value = member_json(archive, "build-info.json")
            exact(value, ("version", "sha", "tag", "official"))
            if value != expected or value["official"] is not True:
                refuse()
            pin = observe_oracle(archive, names, path.name, expected_source, provenance_digest, expected_notices)
        if identity(handle) != identity(os.fstat(source.fileno())):
            refuse()
    if identity(before) != identity(path.lstat()):
        refuse()
    return pin


def inspect_bundle(directory, tag, sha, *, expected_source=None, retained_provenance_sha256=None,
                   retained_notices=None):
    """Observe candidate ZIPs; optional expectations belong to trusted shipping CI."""
    if (len(tag) > 64 or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag)
            or not hexadecimal(sha, 40)):
        refuse()
    version = tuple(int(part) for part in tag[1:].split("."))
    if expected_source is not None:
        verify_source(expected_source)
    if retained_provenance_sha256 is not None:
        exact(retained_provenance_sha256, ORACLE_PLATFORMS)
        if not all(hexadecimal(digest, 64) for digest in retained_provenance_sha256.values()):
            refuse()
    if retained_notices is not None:
        exact(retained_notices, ORACLE_PLATFORMS)
        if not all(isinstance(notices, dict) and notices for notices in retained_notices.values()):
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
    pins = []
    for name in PACKAGES:
        retained_digest = retained_provenance_sha256.get(name) if retained_provenance_sha256 is not None else None
        notices = retained_notices.get(name) if retained_notices is not None else None
        pin = observe_zip(root / name, expected, provenance["packages"][name], expected_source, retained_digest, notices)
        if name in ORACLE_PLATFORMS:
            pins.append(pin)
    required = (version >= ORACLE_REQUIRED_FROM or expected_source is not None
                or retained_provenance_sha256 is not None or retained_notices is not None)
    if pins[0] != pins[1] or (required and pins[0] is None):
        refuse()
    # Reuse the unchanged pure identity validator. Do not call the producer's
    # unbounded pathname-based ZIP/manifest rereads on downloaded input.
    producer = qualified_producer()
    # The producer's Release constructor enforces its publishing hold. Observation
    # only needs the validated identity fields and grants no publishing authority.
    producer.verify_identity(provenance, types.SimpleNamespace(tag=tag, sha=sha), PACKAGES)
    return provenance


def verify(directory, tag, sha):
    if sys.version_info[:2] != (3, 12):
        refuse()
    inspect_bundle(directory, tag, sha)
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
