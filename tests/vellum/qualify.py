"""Offline qualification of a separately built upstream apk; never installs packages."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

SOURCE = "ee31d275c7a2b7486e6de481ffe624b1de46d131"
PUBLISHED = {
    "armv7": (354274748, "2fa969001cd8fbc8fa373b7c3dfcc99f858ceb516306d35d1b037c09861ac94a",
              "a971ead7b78ecb0c10c47be9f8bb7402c0be1fc0bca958c1deed72c56aa417bb"),
    "aarch64": (354274751, "dab5b2b615cae41fd90a99fc6bdca87d26d04c0755440bded6b4832547c09cf7",
                "4b7300c73beff4d34ce396db5b0db516e5590ece7215ac9c1e85e5f203781190"),
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def regular(path):
    path = Path(path).absolute()
    if any(part.is_symlink() or part.is_junction() for part in [path, *path.parents]) or not path.is_file():
        raise ValueError("Input must be a regular file without symlink ancestors")
    return path.resolve()


def run_container(image, mounts, phase, apk_hash, timeout=120, emulator=None):
    name = "manager-apk-fixture-" + uuid.uuid4().hex
    script = regular(Path(__file__).with_name("fixture.py"))
    command = ["docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
               "--env", "APK_CONFIG=/fixtures/meta/etc/apk/config",
               "--env", "PYTHONDONTWRITEBYTECODE=1"]
    if sys.platform == "linux":
        # Private host directories stay mode 0700; cap-drop ALL cannot bypass ownership.
        uid, gid = os.geteuid(), os.getegid()
        if any(type(value) is not int or value < 0 for value in (uid, gid)):
            raise ValueError("Host effective UID/GID must be nonnegative integers")
        command += ["--user", f"{uid}:{gid}"]
    extra = [(emulator[0], "/tool/emulator", True)] if emulator else []
    for source, target, readonly in [*mounts, *extra, (script, "/harness/fixture.py", True)]:
        command += ["--mount", f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")]
    command += ["--entrypoint", "python3", image, "/harness/fixture.py", phase, apk_hash]
    if emulator:
        command.append(emulator[1])
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # The exact task-generated name identifies this container, never a shared container.
        try:
            cleanup = subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, timeout=20, check=False)
        finally:
            process.kill()
            process.communicate(timeout=20)
        if cleanup.returncode:
            raise RuntimeError(f"{phase} timed out; container removal was not confirmed: {name}") from None
        raise RuntimeError(f"{phase} container timed out and was removed") from None
    if process.returncode:
        # Fixture tool output may contain script text; expose no raw stdout/stderr.
        detail = ""
        try:
            detail = json.loads(stdout).get("failure", "")[:256]
        except (ValueError, AttributeError):
            pass
        raise RuntimeError(f"{phase} container failed (exit {process.returncode}): {detail}; "
                           f"diagnostic digest {hashlib.sha256(stdout + stderr).hexdigest()}")
    if len(stdout) > 128 * 1024:
        raise RuntimeError("Fixture result exceeds bound")
    return json.loads(stdout)


def validate_source(receipt, apk, archive):
    if receipt.get("source_revision") != SOURCE or receipt.get("upstream_version") != "3.0.3":
        raise ValueError("Expected exact evidenced Vellum branch source")
    for key, path in [("binary_sha256", apk), ("source_archive_sha256", archive)]:
        if not re.fullmatch(r"[0-9a-f]{64}", receipt.get(key, "")) or digest(path) != receipt[key]:
            raise ValueError(f"Build receipt {key} mismatch")
    if not receipt.get("build_options") or not receipt.get("dependencies"):
        raise ValueError("Build configuration/dependency identity is required")
    if receipt.get("archive_git_blobs_and_modes_verified") != 417:
        raise ValueError("Exact source archive blob/mode verification is required")


def validate_published(receipt, apk, emulator):
    identity = PUBLISHED.get(receipt.get("architecture"))
    if identity is None:
        raise ValueError("Unsupported published architecture")
    asset_id, apk_hash, emulator_hash = identity
    expected = {"evidence_class": "published-asset-emulated", "repository": "vellum-dev/apk-tools",
                "release_id": 285324426, "release_tag": "v3.0.3", "release_immutable": False,
                "asset_id": asset_id, "asset_name": "apk-" + receipt["architecture"],
                "github_digest": "sha256:" + apk_hash, "binary_sha256": apk_hash,
                "emulator_sha256": emulator_hash, "emulator_version": "8.2.2",
                "attributed_workflow_run": 21912939175, "attributed_source_revision": SOURCE}
    if any(type(receipt.get(key)) is not type(value) or receipt.get(key) != value
           for key, value in expected.items()):
        raise ValueError("Published asset receipt identity mismatch")
    if any(key in receipt for key in ("source_revision", "archive_git_blobs_and_modes_verified",
                                      "source_archive_sha256", "build_options")):
        raise ValueError("Published asset receipt must not claim a local source build")
    if digest(apk) != apk_hash or digest(emulator) != emulator_hash:
        raise ValueError("Pinned published asset/emulator digest mismatch")
    return expected | {"architecture": receipt["architecture"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build-receipt", type=Path)
    mode.add_argument("--published-asset-receipt", type=Path)
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--emulator", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.build_receipt and (not args.source_archive or args.emulator):
        parser.error("Source-build mode requires --source-archive and forbids --emulator")
    if args.published_asset_receipt and (not args.emulator or args.source_archive):
        parser.error("Published mode requires --emulator and forbids --source-archive")
    apk, receipt_file = map(regular, [args.apk, args.build_receipt or args.published_asset_receipt])
    if receipt_file.stat().st_size > 64 * 1024:
        raise ValueError("Input receipt exceeds bound")
    receipt = json.loads(receipt_file.read_text(encoding="utf-8-sig"))
    emulator = None
    published = None
    if args.build_receipt:
        validate_source(receipt, apk, regular(args.source_archive))
    else:
        emulator_file = regular(args.emulator)
        published = validate_published(receipt, apk, emulator_file)
        emulator = (emulator_file, published["emulator_sha256"])
    image = receipt.get("runtime_image_id", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("Runtime image must be an immutable local image ID")
    inspected = subprocess.run(["docker", "image", "inspect", image, "--format", "{{.Id}}"],
                               capture_output=True, timeout=20, check=True).stdout.decode().strip()
    if inspected != image:
        raise ValueError("Runtime image identity mismatch")
    output = args.output.absolute()
    if any(part.is_symlink() or part.is_junction() for part in [output, *output.parents]):
        raise ValueError("Output may not traverse symlinks")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError("Output must be new; preserve previous evidence")
    # Private signing keys exist only in generation-container tmpfs, never this host directory.
    with tempfile.TemporaryDirectory(prefix="manager-apk-fixtures-") as temporary:
        fixtures = Path(temporary).resolve()
        generated = run_container(image, [(apk, "/tool/apk", True), (fixtures, "/fixtures", False)],
                                  "generate", receipt["binary_sha256"], emulator=emulator)
        observed = run_container(image, [(apk, "/tool/apk", True), (fixtures, "/fixtures", True)],
                                 "observe", receipt["binary_sha256"], emulator=emulator)
    result = {"evidence_class": "synthetic offline host source-build; no installation/device qualification",
              "source_revision": SOURCE, "upstream_version": "3.0.3",
              "binary_sha256": receipt["binary_sha256"], "runtime_image_id": image,
              "build_receipt_sha256": digest(receipt_file), "generation": generated, "observations": observed}
    if published:
        result.pop("source_revision")
        result.pop("build_receipt_sha256")
        result.update(evidence_class="synthetic offline published ARM asset under QEMU; no installation/device qualification",
                      asset_receipt_sha256=digest(receipt_file), published_asset=published,
                      attribution_limit="GitHub digest/workflow attribution; no signed publisher or source-build attestation")
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"PASS: {len(observed['cases'])} actual-tool observations; receipt: {output}")


if __name__ == "__main__":
    main()
