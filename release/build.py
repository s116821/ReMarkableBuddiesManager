"""Build and verify application packages. No GitHub writes or version selection."""
import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import zipfile

TAG = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")

@dataclass(frozen=True)
class Release:
    tag: str
    sha: str

def git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo, text=True, encoding="utf-8").strip()

TARGETS = ("browser", "win32-x64", "linux-x64")

def sha256(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()

def verify_packages(directory, release):
    manifest = json.loads((directory / "provenance.json").read_text())
    verify_identity(manifest, release)
    if {path.name for path in directory.iterdir()} != set(manifest['packages']) | {'provenance.json'}:
        raise ValueError('Unexpected or missing release assets')
    for name, digest in manifest["packages"].items():
        if sha256(directory / name) != digest:
            raise ValueError(f"Package checksum mismatch: {name}")
        with zipfile.ZipFile(directory / name) as archive:
            info = json.loads(archive.read('build-info.json'))
            if info != dict(version=release.tag[1:], sha=release.sha, tag=release.tag, official=True):
                raise ValueError(f"Embedded build provenance mismatch: {name}")

def verify_identity(manifest, release):
    if (manifest["tag"], manifest["sha"], manifest["version"]) != (release.tag, release.sha, release.tag[1:]):
        raise ValueError("Release provenance does not match tag and source")
    expected = {f"manager-{target}.zip" for target in TARGETS}
    if set(manifest["packages"]) != expected:
        raise ValueError("Release must contain browser and both desktop packages")

def build_checkout(repo, release, directory):
    git(repo, "checkout", "--detach", release.tag)
    if git(repo, "rev-parse", "HEAD") != release.sha:
        raise ValueError("Checkout does not match release SHA")
    env = dict(os.environ, MANAGER_RELEASE_TAG=release.tag, MANAGER_RELEASE_SHA=release.sha)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    def run(*args, extra=None):
        subprocess.run([npm, *args], cwd=repo, env=dict(env, **(extra or {})), check=True)
    run("ci", "--no-audit", "--no-fund")
    run("run", "build")
    run("run", "test:hosts")
    browser = repo / "dist/manager/browser"
    shutil.copy2(repo / "electron/build-info.json", browser / "build-info.json")
    archive_package(browser, directory / "manager-browser.zip")
    for platform in ("win32", "linux"):
        run("run", "package", extra={"MANAGER_PACKAGE_PLATFORM": platform})
        if platform == ("win32" if os.name == "nt" else "linux"):
            run("run", "test:package")
        package = repo / f"out/packages/ReMarkableBuddiesManager-{platform}-x64"
        # A plain metadata copy allows consumers to verify version without executing code.
        shutil.copy2(repo / "electron/build-info.json", package / "build-info.json")
        archive_package(package, directory / f"manager-{platform}-x64.zip", linux=platform == "linux")
    packages = {path.name: sha256(path) for path in directory.glob("*.zip")}
    manifest = dict(tag=release.tag, sha=release.sha, version=release.tag[1:], packages=packages)
    (directory / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
    verify_packages(directory, release)

def archive_package(source, destination, *, linux=False):
    # Windows release runners must preserve Linux executability in cross-packages.
    executables = {"ReMarkableBuddiesManager", "chrome-sandbox", "chrome_crashpad_handler"}
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob('*')):
            if path.is_file():
                item = zipfile.ZipInfo(path.relative_to(source).as_posix())
                item.create_system = 3
                mode = 0o755 if linux and path.name in executables else 0o644
                item.external_attr = (stat.S_IFREG | mode) << 16
                item.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(item, path.read_bytes())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not TAG.fullmatch(args.tag) or not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("An exact stable tag and source SHA are required")
    if args.verify_only:
        verify_packages(args.output.resolve(), Release(args.tag, args.sha))
        print(f"Verified package inventory: {args.tag} at {args.sha}")
        return
    if args.source is None:
        parser.error("--source is required when building")
    repo = args.source.resolve()
    if git(repo, "rev-parse", "HEAD") != args.sha or git(repo, "rev-parse", f"refs/tags/{args.tag}^{{commit}}") != args.sha:
        parser.error("Checkout/tag do not match the verified source SHA")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    build_checkout(repo, Release(args.tag, args.sha), output)
    print(f"Verified packages: {args.tag} at {args.sha}")

if __name__ == "__main__":
    main()
