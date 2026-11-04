"""Read-only Vellum preview for a host-approved resident update or rollback."""

from dataclasses import dataclass
import re

from resident_package_recovery import (
    DIGEST, VELLUM_APK, VELLUM_APK_SHA256, VELLUM_OFFLINE, VELLUM_WORLD,
    PackageRecovery, require, require_package_version, sha256,
)
from resident_package_transition import on_wire
import wired_observer as shared


@dataclass(frozen=True)
class ApprovedReplacement:
    """Pins supplied by host release policy after independent signature verification."""

    nonce: str
    version: str
    apk_sha256: str
    index_sha256: str


def candidate_stamp(recovery, path, digest, limit):
    stat = f"stat -c '%d:%i:%u:%g:%a:%h:%s:%y:%z' {path}"
    raw = recovery.read(
        f'test ! -L {path} && test -f {path} && test "$(readlink -f {path})" = {path} && '
        f'test "$(stat -c %s {path})" -le {limit} && {stat} && sha256sum {path} && {stat}', 768)
    before, checksum, after = raw.splitlines()
    require(before == after and checksum == f"{digest}  {path}".encode("ascii"))
    _, _, uid, gid, mode, links, length, _ = before.decode("ascii").split(":", 7)
    require((uid, gid, mode, links) == ("0", "0", "600", "1") and 0 < int(length) <= limit)
    return before


def replacement_plan(recovery, installed_version, candidate):
    require_package_version(installed_version)
    require(isinstance(candidate, ApprovedReplacement))
    require_package_version(candidate.version)
    require(candidate.version != installed_version)
    require(isinstance(candidate.nonce, str) and re.fullmatch(r"[0-9a-f]{32}", candidate.nonce))
    require(all(isinstance(digest, str) and DIGEST.fullmatch(digest)
                for digest in (candidate.apk_sha256, candidate.index_sha256)))
    ownership = recovery.package_ownership(installed_version)
    world = recovery.protected(VELLUM_WORLD)
    directory = f"/home/root/rem25-package-{candidate.nonce}"
    package = f"{directory}/remarkable-buddies-{candidate.version}.armv7.apk"
    index = f"{directory}/index.adb"
    repositories = f"{directory}/repositories"

    def staged():
        require(recovery.read(
            f'test ! -L {directory} && test -d {directory} && '
            f'test "$(readlink -f {directory})" = {directory} && stat -c "%u:%g:%a" {directory}',
            32) == b"0:0:700\n")
        require(recovery.protected(repositories, private=True) == f"ndx {index}\n".encode("ascii"))
        return (candidate_stamp(recovery, package, candidate.apk_sha256, 268435456),
                candidate_stamp(recovery, index, candidate.index_sha256, 1048576))

    before = staged()
    command = (f'test "$(sha256sum {VELLUM_APK})" = "{VELLUM_APK_SHA256}  {VELLUM_APK}" && '
               f'{VELLUM_OFFLINE} --repositories-file {repositories}')
    require(recovery.read(f"{command} verify {package} {index}", 1024)
            == f"{package}: OK\n{index}: OK\n".encode("ascii"))
    result = recovery.read(f"{command} --simulate add remarkable-buddies={candidate.version}", 1024)
    installed_key = tuple(map(int, installed_version.replace("-r", ".").split(".")))
    candidate_key = tuple(map(int, candidate.version.replace("-r", ".").split(".")))
    verb = "Upgrading" if candidate_key > installed_key else "Downgrading"
    lines = result.splitlines()
    first = f"(1/1) {verb} remarkable-buddies ({installed_version} -> {candidate.version})"
    require(len(lines) == 2 and lines[0] == first.encode("ascii")
            and re.fullmatch(rb"OK: [0-9]+(?:\.[0-9]+)? [A-Za-z]+ in [0-9]+ packages", lines[1]))
    require(staged() == before and recovery.protected(VELLUM_WORLD) == world
            and recovery.package_ownership(installed_version) == ownership)
    return {"ownership": ownership, "candidate_version": candidate.version,
            "apk_sha256": candidate.apk_sha256, "index_sha256": candidate.index_sha256,
            "world_sha256": sha256(world), "solver_sha256": sha256(result)}


def preview(config, connection, installed_version, candidate, deadline):
    def inspect(transport):
        platform = shared.inspect(transport)
        require(platform["model"] == "reMarkable 2.0" and platform["architecture"] == "armv7l"
                and platform["firmware"] == "3.28.0.172" and not platform["firmware_conflict"])
        plan = replacement_plan(PackageRecovery(transport, deadline), installed_version, candidate)
        require(plan["ownership"]["boot_id"] == platform["boot_id"])
        return {"replacement_plan": plan}

    require(isinstance(connection, str) and DIGEST.fullmatch(connection))
    return on_wire(config, inspect, connection)
