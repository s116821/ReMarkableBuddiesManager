"""Serialized release orchestration. Run only from the protected main workflow.

git-cliff owns version decisions. Immutable annotated tags are the retry ledger.
No tag or release is changed by the plan command, which is safe in fixture repos.
"""

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import zipfile
import stat
import tempfile

from policy import CLIFF_VERSION, CONFIG, TAG, commit_relevant, git, validate_title

MARKER = "RemarkableBuddiesManager release-v1"
TARGETS = ("browser", "win32-x64", "linux-x64")


@dataclass(frozen=True)
class Release:
    tag: str
    sha: str


def tags_on_main(repo, main):
    first_parent = set(git(repo, "rev-list", "--first-parent", main).splitlines())
    found = []
    for tag in git(repo, "tag", "--merged", main).splitlines():
        if TAG.fullmatch(tag):
            sha = git(repo, "rev-parse", f"{tag}^{{commit}}")
            if sha not in first_parent:
                raise ValueError(f"Release tag {tag} is not on main's first-parent history")
            found.append(Release(tag, sha))
    order = {sha: index for index, sha in enumerate(git(repo, "rev-list", "--first-parent", main).splitlines())}
    return sorted(found, key=lambda release: order[release.sha])


def plan(repo, main="origin/main", cliff="git-cliff"):
    if git(repo, "rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("Release planning requires full history")
    tags = tags_on_main(repo, main)
    baseline = tags[0] if tags else None
    revision = f"{baseline.sha}..{main}" if baseline else main
    commits = git(repo, "rev-list", "--first-parent", "--reverse", revision).splitlines()
    application = []
    for sha in commits:
        parents = git(repo, "rev-list", "--parents", "-n", "1", sha).split()
        if len(parents) > 2:
            raise ValueError(f"Expected a squash commit on main: {sha}")
        if commit_relevant(repo, sha):
            validate_title(git(repo, "show", "-s", "--format=%s", sha))
            application.append(sha)
    if not application:
        return None
    sha = application[0]
    actual = subprocess.check_output([cliff, "--version"], text=True).strip()
    if actual != f"git-cliff {CLIFF_VERSION}":
        raise ValueError(f"Expected git-cliff {CLIFF_VERSION}, got {actual}")
    # Detached worktree fixes git-cliff's branch/reachable-tag context to the
    # actual app commit, even when main has advanced to a documentation commit.
    with tempfile.TemporaryDirectory(prefix="manager-release-plan-") as temp:
        checkout = Path(temp) / "source"
        git(repo, "worktree", "add", "--detach", str(checkout), sha)
        try:
            tag = subprocess.check_output(
                [cliff, "--config", str(CONFIG), "--bumped-version", "--unreleased", "--use-branch-tags"],
                cwd=checkout, text=True, encoding="utf-8").strip()
        finally:
            git(repo, "worktree", "remove", str(checkout))
    if not TAG.fullmatch(tag) or (baseline and tag == baseline.tag) or any(item.tag == tag for item in tags):
        raise ValueError(f"git-cliff did not produce a new semantic release: {tag}")
    return Release(tag, sha)


def managed_tags(repo, main):
    return [release for release in reversed(tags_on_main(repo, main))
            if git(repo, "for-each-ref", "--format=%(contents)", f"refs/tags/{release.tag}").splitlines()[0:1] == [MARKER]]


def allow_publication(release):
    if not TAG.fullmatch(release.tag) or int(release.tag[1:].split(".")[0]) >= 1:
        raise ValueError("REM-35 owns the reviewed 1.0 gate; publication is limited to major zero")


def create_tag(repo, release):
    allow_publication(release)
    runner = CONFIG.parent / "node_modules/release-it/bin/release-it.js"
    if not runner.is_file():
        raise ValueError("Install pinned release tools with npm ci --prefix release")
    with tempfile.TemporaryDirectory(prefix="manager-release-tag-") as temp:
        checkout = Path(temp) / "source"
        git(repo, "worktree", "add", "--detach", str(checkout), release.sha)
        try:
            env = dict(os.environ,
                       GIT_COMMITTER_NAME="github-actions[bot]",
                       GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com")
            subprocess.run(["node", str(runner), release.tag[1:], "--ci", "--config", str(CONFIG.with_name("release-it.json"))],
                           cwd=checkout, env=env, check=True)
            if git(checkout, "rev-parse", "HEAD") != release.sha:
                raise ValueError("Release runner created an unexpected source commit")
            if git(checkout, "rev-parse", f"refs/tags/{release.tag}^{{commit}}") != release.sha:
                raise ValueError("Release runner tagged the wrong source")
        finally:
            git(repo, "worktree", "remove", str(checkout))
    git(repo, "push", "origin", f"refs/tags/{release.tag}")
    verify_remote_tag(repo, release)


def verify_remote_tag(repo, release):
    remote = git(repo, "ls-remote", "origin", f"refs/tags/{release.tag}^{{}}")
    if remote.split()[0:1] != [release.sha]:
        raise ValueError(f"Remote tag identity mismatch: {release.tag}")


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


class GitHub:
    def __init__(self, repository):
        self.repository = repository

    def run(self, *args):
        return subprocess.check_output(["gh", *args, "--repo", self.repository], text=True, encoding="utf-8")

    def view(self, release):
        result = subprocess.run(["gh", "api", f"repos/{self.repository}/releases/tags/{release.tag}"],
                                capture_output=True, text=True)
        if result.returncode:
            if "HTTP 404" in result.stderr:
                return None
            raise RuntimeError(result.stderr)
        return json.loads(result.stdout)

    def complete(self, release):
        state = self.view(release)
        if not state or state["draft"]:
            return False
        # The verified draft's completion record is published with the release.
        # Compare GitHub's server-side asset digests, not every historical binary
        # download on every run. Missing/damaged published records fail closed.
        match = re.search(r"<!-- manager-complete:(.*?) -->", state.get("body") or "")
        if not match:
            raise ValueError(f"Published release lacks completion provenance: {release.tag}")
        record = json.loads(match[1])
        verify_identity(record, release)
        expected = dict(record["packages"], **{"provenance.json": record["provenance_sha256"]})
        assets = {asset["name"]: asset.get("digest") for asset in state["assets"]}
        if assets != {name: f"sha256:{digest}" for name, digest in expected.items()}:
            raise ValueError(f"Published asset digests disagree with completion record: {release.tag}")
        return True

    def publish(self, release, directory):
        state = self.view(release)
        if state and not state["draft"]:
            raise ValueError(f"Refusing to overwrite published {release.tag}")
        if not state:
            self.run("release", "create", release.tag, "--draft", "--verify-tag", "--target", release.sha,
                     "--title", release.tag, "--notes", f"Manager {release.tag}\n\nSource: {release.sha}\n\nAll three packages include tag-derived version and source provenance.")
        self.run("release", "upload", release.tag, *map(str, sorted(directory.iterdir())), "--clobber")
        # Verify uploaded bytes while still draft, so partial uploads remain retryable.
        with tempfile.TemporaryDirectory(prefix="manager-release-upload-") as temp:
            self.run("release", "download", release.tag, "--dir", temp)
            verify_packages(Path(temp), release)
            if sha256(Path(temp) / "provenance.json") != sha256(directory / "provenance.json"):
                raise ValueError("Uploaded provenance differs from the verified local build")
        record = json.loads((directory / "provenance.json").read_text())
        record["provenance_sha256"] = sha256(directory / "provenance.json")
        notes = f"Manager {release.tag}\n\nSource: {release.sha}\n\n<!-- manager-complete:{json.dumps(record, separators=(',', ':'))} -->"
        self.run("release", "edit", release.tag, "--draft=false", "--latest", "--notes", notes)


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


def build(repo, release, directory):
    # A real clone keeps .git usable inside cross containers. A linked worktree's
    # .git file can point outside the mounted source (especially on Windows).
    with tempfile.TemporaryDirectory(prefix="manager-release-source-") as temp:
        source = Path(temp) / "source"
        git(repo, "clone", "--config", "core.autocrlf=false", "--no-local", "--no-checkout", str(repo), str(source))
        build_checkout(source, release, directory)


def build_checkout(repo, release, directory):
    allow_publication(release)
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


def publish_all(repo, publisher, builder=build, cliff="git-cliff", branch="main"):
    git(repo, "fetch", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}", "--tags")
    main = f"origin/{branch}"
    # Recover old pending tags before considering newer changes. The job's lock
    # spans every build/upload, not merely the version computation.
    for release in managed_tags(repo, main):
        allow_publication(release)
        if not publisher.complete(release):
            verify_remote_tag(repo, release)
            with tempfile.TemporaryDirectory(prefix="manager-release-assets-") as temp:
                builder(repo, release, Path(temp))
                publisher.publish(release, Path(temp))
    completed = []
    while release := plan(repo, main, cliff):
        create_tag(repo, release)
        with tempfile.TemporaryDirectory(prefix="manager-release-assets-") as temp:
            builder(repo, release, Path(temp))
            publisher.publish(release, Path(temp))
        completed.append(release)
    return completed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("plan", "publish"))
    parser.add_argument("--branch", default="main", choices=("main", "master"))
    args = parser.parse_args()
    repo = Path.cwd()
    if args.command == "plan":
        release = plan(repo, f"origin/{args.branch}")
        print(json.dumps(release.__dict__ if release else None))
    else:
        publish_all(repo, GitHub(os.environ["GITHUB_REPOSITORY"]), branch=args.branch)


if __name__ == "__main__":
    main()
