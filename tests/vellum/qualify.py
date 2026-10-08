"""Offline qualification of a separately built upstream apk; never installs packages."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

SOURCE = "ee31d275c7a2b7486e6de481ffe624b1de46d131"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def regular(path):
    path = Path(path).absolute()
    if any(part.is_symlink() or part.is_junction() for part in [path, *path.parents]) or not path.is_file():
        raise ValueError("Input must be a regular file without symlink ancestors")
    return path.resolve()


def run_container(image, mounts, phase, apk_hash, timeout=120):
    name = "manager-apk-fixture-" + uuid.uuid4().hex
    script = regular(Path(__file__).with_name("fixture.py"))
    command = ["docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
               "--env", "APK_CONFIG=/fixtures/meta/etc/apk/config",
               "--env", "PYTHONDONTWRITEBYTECODE=1"]
    for source, target, readonly in [*mounts, (script, "/harness/fixture.py", True)]:
        command += ["--mount", f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")]
    command += ["--entrypoint", "python3", image, "/harness/fixture.py", phase, apk_hash]
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--build-receipt", required=True, type=Path)
    parser.add_argument("--source-archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    apk, receipt_file, archive = map(regular, [args.apk, args.build_receipt, args.source_archive])
    if receipt_file.stat().st_size > 64 * 1024:
        raise ValueError("Build receipt exceeds bound")
    receipt = json.loads(receipt_file.read_text(encoding="utf-8-sig"))
    if receipt.get("source_revision") != SOURCE or receipt.get("upstream_version") != "3.0.3":
        raise ValueError("Expected exact evidenced Vellum branch source")
    for key, path in [("binary_sha256", apk), ("source_archive_sha256", archive)]:
        if not re.fullmatch(r"[0-9a-f]{64}", receipt.get(key, "")) or digest(path) != receipt[key]:
            raise ValueError(f"Build receipt {key} mismatch")
    if not receipt.get("build_options") or not receipt.get("dependencies"):
        raise ValueError("Build configuration/dependency identity is required")
    if receipt.get("archive_git_blobs_and_modes_verified") != 417:
        raise ValueError("Exact source archive blob/mode verification is required")
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
                                  "generate", receipt["binary_sha256"])
        observed = run_container(image, [(apk, "/tool/apk", True), (fixtures, "/fixtures", True)],
                                 "observe", receipt["binary_sha256"])
    result = {"evidence_class": "synthetic offline host source-build; no installation/device qualification",
              "source_revision": SOURCE, "upstream_version": "3.0.3",
              "binary_sha256": receipt["binary_sha256"], "runtime_image_id": image,
              "build_receipt_sha256": digest(receipt_file), "generation": generated, "observations": observed}
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"PASS: {len(observed['cases'])} actual-tool observations; receipt: {output}")


if __name__ == "__main__":
    main()
