"""Assemble and verify the project-specific fixed ZIP/provenance inventory. No builds or remote writes."""
import argparse
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import stat
import zipfile
from artifacts import Release, sha256, source_identity, verify_identity as identity
TARGETS = ("browser", "win32-x64", "linux-x64")
NAMES = tuple(f"manager-{target}.zip" for target in TARGETS)

def verify_identity(manifest, release):
    identity(manifest, release, NAMES)

@lru_cache(maxsize=1)
def observer():
    # Trusted checkout code, shared with runtime quarantine; never package code.
    return runpy.run_path(str(Path(__file__).resolve().parents[2] / "scripts/verify-manager-bundle.py"))

def oracle_expectations(repo, oracle_root):
    core = observer()
    pin = core["decode"](core["bounded_read"](repo / "host/buddy-oracle-source.json", 16 * 1024), 16 * 1024)
    core["verify_source"](pin)
    digests = {}
    for name, (_, target, _) in core["ORACLE_PLATFORMS"].items():
        raw = core["bounded_read"](oracle_root / target / "buddy-oracle/provenance.json", 16 * 1024)
        digests[name] = hashlib.sha256(raw).hexdigest()
    return dict(expected_source=pin, retained_provenance_sha256=digests)

def verify_packages(directory, release, *, oracle_root=None, repo=None):
    repo = Path(repo) if repo is not None else Path(__file__).resolve().parents[2]
    expected = oracle_expectations(repo, Path(oracle_root)) if oracle_root is not None else {}
    return observer()["inspect_bundle"](directory.resolve(), release.tag, release.sha, **expected)

def oracle_input_copies(repo, oracle_root):
    """Preflight both original Build inputs before mutating either package."""
    expected = oracle_expectations(repo, oracle_root)
    core = observer()
    copies = []
    for name, (filename, target, _) in core["ORACLE_PLATFORMS"].items():
        platform = name.removeprefix("manager-").removesuffix(".zip")
        host = repo / f"out/packages/ReMarkableBuddiesManager-{platform}/resources/host"
        for parent in (host, host / "third-party"):
            if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
                raise ValueError("Oracle destination parent is not a package directory")
        packaged_pin = core["decode"](core["bounded_read"](host / "buddy-oracle-source.json", 16 * 1024), 16 * 1024)
        if packaged_pin != expected["expected_source"]:
            raise ValueError("Packaged oracle source differs from candidate checkout")
        source = oracle_root / target / "buddy-oracle"
        if source.is_symlink() or {file.name for file in source.iterdir()} != {filename, "provenance.json"}:
            raise ValueError("Unexpected retained oracle resource inventory")
        for file in source.iterdir():
            core["regular"](file, core["MAX_PACKAGE"] if file.name == filename else 16 * 1024)
        # Notices are produced by the reviewed workflow and maintained generator.
        # This validates transport shape, not a new license-expression engine.
        notices = oracle_root / target / "notices"
        members = list(notices.rglob("*"))
        if notices.is_symlink() or not notices.is_dir() or not 0 < len(members) <= 4096:
            raise ValueError("Missing or oversized retained oracle notices")
        total = 0
        files = 0
        for file in members:
            if file.is_symlink():
                raise ValueError("Retained notices must not contain links")
            if file.is_dir():
                continue
            total += core["regular"](file, 16 * 1024 * 1024).st_size
            files += 1
        if not files or total > 32 * 1024 * 1024:
            raise ValueError("Missing or oversized retained oracle notices")
        for original, destination in ((source, host / "buddy-oracle"), (notices, host / "third-party/buddy-oracle")):
            if destination.exists() or destination.is_symlink():
                raise ValueError("Oracle destination already exists; use fresh build staging")
            copies.append((original, destination))
    return copies

def archive_package(source, destination, *, linux=False):
    executables = {"ReMarkableBuddiesManager", "chrome-sandbox", "chrome_crashpad_handler"}
    oracle = "resources/host/buddy-oracle/reader-buddy"
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                member = path.relative_to(source).as_posix()
                item = zipfile.ZipInfo(member)
                item.create_system = 3
                mode = 0o755 if linux and (path.name in executables or member == oracle) else 0o644
                item.external_attr = (stat.S_IFREG | mode) << 16
                item.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(item, path.read_bytes())

def assemble(repo, release, directory, *, oracle_root=None):
    source_identity(repo, release)
    copies = oracle_input_copies(repo, Path(oracle_root)) if oracle_root is not None else []
    directory.mkdir(parents=True, exist_ok=False)
    for original, destination in copies:
        # An interrupted copy is unpublished; never overwrite it on retry.
        shutil.copytree(original, destination)
    browser = repo / "dist/manager/browser"
    shutil.copyfile(repo / "electron/build-info.json", browser / "build-info.json")
    archive_package(browser, directory / "manager-browser.zip")
    for platform in ("win32", "linux"):
        package = repo / f"out/packages/ReMarkableBuddiesManager-{platform}-x64"
        shutil.copyfile(repo / "electron/build-info.json", package / "build-info.json")
        archive_package(package, directory / f"manager-{platform}-x64.zip", linux=platform == "linux")
    manifest = dict(tag=release.tag, sha=release.sha, version=release.tag[1:],
                    packages={name: sha256(directory / name) for name in NAMES})
    (directory / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    verify_packages(directory, release, oracle_root=oracle_root, repo=repo)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("assemble", "verify"))
    parser.add_argument("--source", type=Path, default=Path.cwd())
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--oracle-root", type=Path, help="Original Build inputs, never extracted candidate metadata")
    args = parser.parse_args()
    release = Release(args.tag, args.sha)
    if args.mode == "assemble":
        assemble(args.source.resolve(), release, args.output.resolve(), oracle_root=args.oracle_root)
    else:
        verify_packages(args.output.resolve(), release, oracle_root=args.oracle_root, repo=args.source.resolve())
