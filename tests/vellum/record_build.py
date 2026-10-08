"""Record a local host build after exact Git archive blob/mode verification."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

from qualify import SOURCE, digest, regular


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--build-details", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    archive, apk, details = map(regular, [args.archive, args.apk, args.build_details])
    raw = subprocess.check_output(["git", "ls-tree", "-r", "-z", SOURCE], cwd=args.source, timeout=20)
    expected = {}
    for entry in raw.split(b"\0"):
        if entry:
            metadata, path = entry.split(b"\t", 1)
            mode, kind, blob = metadata.split()
            if kind != b"blob":
                raise ValueError("Unsupported source tree entry")
            expected[path.decode()] = (mode, blob.decode())
    verified = 0
    with tarfile.open(archive) as tar:
        for member in tar:
            if member.isdir():
                continue
            if member.size > 16 * 1024 * 1024:
                raise ValueError("Source blob exceeds verification bound")
            mode, blob = expected.pop(member.name)
            if member.issym():
                data = member.linkname.encode()
                if mode != b"120000":
                    raise ValueError("Source symlink type differs")
            elif member.isfile():
                data = tar.extractfile(member).read()
                if mode not in {b"100644", b"100755"} or bool(member.mode & 0o111) != (mode == b"100755"):
                    raise ValueError("Source Git executable mode differs")
            else:
                raise ValueError("Unsupported source archive member")
            actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            if actual != blob:
                raise ValueError("Archive bytes differ from exact source Git blob")
            verified += 1
    if expected or verified != 417:
        raise ValueError("Archive does not cover exact source inventory")
    if details.stat().st_size > 64 * 1024:
        raise ValueError("Build details exceed bound")
    receipt = json.loads(details.read_text(encoding="utf-8-sig"))
    receipt.update(source_revision=SOURCE, upstream_version="3.0.3", source_archive_sha256=digest(archive),
                   binary_sha256=digest(apk), archive_git_blobs_and_modes_verified=verified,
                   qualification="Local Linux x86_64 source build only; not published ARM/device qualification")
    if any(part.is_symlink() or part.is_junction() for part in [args.output.absolute(), *args.output.absolute().parents]):
        raise ValueError("Build receipt output may not traverse symlinks")
    if args.output.exists():
        raise ValueError("Preserve existing build receipt; choose new output")
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Recorded {verified} exact Git blobs and executable/link modes")


if __name__ == "__main__":
    main()
