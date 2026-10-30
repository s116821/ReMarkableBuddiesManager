"""Assemble and verify the project-specific fixed ZIP/provenance inventory. No builds or remote writes."""
import argparse
import json
from pathlib import Path
import shutil
import stat
import zipfile
from artifacts import Release, sha256, source_identity, verify_identity as identity, verify_packages as packages
TARGETS = ("browser", "win32-x64", "linux-x64")
NAMES = tuple(f"manager-{target}.zip" for target in TARGETS)

def verify_identity(manifest, release):
    identity(manifest, release, NAMES)

def verify_packages(directory, release):
    manifest = packages(directory, release, NAMES)
    for name in NAMES:
        with zipfile.ZipFile(directory / name) as archive:
            if json.loads(archive.read("build-info.json")) != dict(
                    version=release.tag[1:], sha=release.sha, tag=release.tag, official=True):
                raise ValueError("Embedded release-profile identity mismatch")
    return manifest

def archive_package(source, destination, *, linux=False):
    executables = {"ReMarkableBuddiesManager", "chrome-sandbox", "chrome_crashpad_handler"}
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                item = zipfile.ZipInfo(path.relative_to(source).as_posix())
                item.create_system = 3
                mode = 0o755 if linux and path.name in executables else 0o644
                item.external_attr = (stat.S_IFREG | mode) << 16
                item.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(item, path.read_bytes())

def assemble(repo, release, directory):
    source_identity(repo, release)
    directory.mkdir(parents=True, exist_ok=False)
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
    verify_packages(directory, release)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("assemble", "verify"))
    parser.add_argument("--source", type=Path, default=Path.cwd())
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    release = Release(args.tag, args.sha)
    if args.mode == "assemble":
        assemble(args.source.resolve(), release, args.output.resolve())
    else:
        verify_packages(args.output.resolve(), release)
