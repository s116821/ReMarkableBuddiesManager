"""Host-private Vellum preview and commit for a resident update or rollback."""

from dataclasses import asdict, dataclass
import os
import re
import shlex

from resident_package_disable import STARTUP_LINK, disable_path, observe_disabled, retained_stock
from resident_package_recovery import (
    ACTIVE_LEASE, BUDDY, DIGEST, HELPER, PROFILE, RUNTIME, STOCK, STOCK_EXE, SYNC, SYNC_EXE, SYNC_SHA256,
    VELLUM_APK, VELLUM_APK_SHA256, VELLUM_OFFLINE, VELLUM_WORLD,
    PackageRecovery, json_record, require, require_package_version, sha256,
)
from resident_package_transition import (
    RecoveryPending, intent_path, load_intent, on_wire, write_private_record,
)
from resident_package_uninstall import (
    ADVISORY, PROMPT, exact_commit_result, locked_command, run_locked_transaction,
)
import wired_observer as shared


@dataclass(frozen=True)
class ApprovedReplacement:
    """Pins supplied by host release policy after independent signature verification."""

    nonce: str
    version: str
    apk_sha256: str
    index_sha256: str

    @property
    def directory(self):
        return f"/home/root/rem25-package-{self.nonce}"


def transition_verb(old, new):
    old_key = tuple(map(int, old.replace("-r", ".").split(".")))
    new_key = tuple(map(int, new.replace("-r", ".").split(".")))
    return "Upgrading" if new_key > old_key else "Downgrading"


def other_world_sha256(world, version, *, require_pin=False):
    lines = world.splitlines()
    buddy = [line for line in lines if re.match(rb"^remarkable-buddies(?:[<>=~@]|$)", line)]
    expected = [f"remarkable-buddies={version}".encode("ascii")]
    require(buddy == expected or (not require_pin and buddy == [b"remarkable-buddies"]))
    return sha256(b"\n".join(line for line in lines if line not in buddy))


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
    directory = candidate.directory
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
    verb = transition_verb(installed_version, candidate.version)
    lines = result.splitlines()
    first = f"(1/1) {verb} remarkable-buddies ({installed_version} -> {candidate.version})"
    require(len(lines) == 2 and lines[0] == first.encode("ascii")
            and re.fullmatch(rb"OK: [0-9]+(?:\.[0-9]+)? [A-Za-z]+ in [0-9]+ packages", lines[1]))
    require(staged() == before and recovery.protected(VELLUM_WORLD) == world
            and recovery.package_ownership(installed_version) == ownership)
    return {"ownership": ownership, "candidate_version": candidate.version,
            "apk_sha256": candidate.apk_sha256, "index_sha256": candidate.index_sha256,
            "world_sha256": sha256(world), "other_world_sha256": other_world_sha256(world, installed_version),
            "solver_sha256": sha256(result)}


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


def exact_replacement_prompt(output, old, new):
    require(output.endswith(PROMPT))
    lines = output[:-len(PROMPT)].splitlines()
    if lines[:2] == ADVISORY:
        lines = lines[2:]
        while lines and re.fullmatch(rb"  [a-zA-Z0-9_.+ -]+", lines[0]):
            lines = lines[1:]
    heading = b"upgraded" if transition_verb(old, new) == "Upgrading" else b"DOWNGRADED"
    require(len(lines) == 3 and lines[0] == b"The following packages will be " + heading + b":"
            and lines[1] == f"  remarkable-buddies ({old} -> {new})".encode("ascii")
            and re.fullmatch(rb"After this operation, [0-9]+(?:\.[0-9]+)? [A-Za-z]+ "
                             rb"(?:of additional disk space will be used|of disk space will be freed)\.", lines[2]))


def replacement_path(config, boot, activation):
    return intent_path(config, boot, activation).with_name(f"resident-replace-{boot}-{activation}.json")


def observe_replaced(recovery, expected, stock, candidate, profile_sha256, plan):
    require(recovery.boot() == expected.boot_id)
    archived = f"{RUNTIME}/recovered-{expected.activation_id}.json"
    require(sha256(recovery.protected(archived, private=True)) == expected.lease_sha256)
    for path in (ACTIVE_LEASE, STARTUP_LINK, f"/etc/systemd/system/{BUDDY}"):
        recovery.read(f"test ! -e {path} && test ! -L {path}", 32)
    require(recovery.unit_file_state(BUDDY) == b"disabled\n" and recovery.unit_file_state(HELPER) == b"static\n")
    stopped = {unit: recovery.service(unit, allow_pending_reload=True) for unit in (BUDDY, HELPER)}
    require(all(state["ActiveState"] == "inactive" and state["SubState"] == "dead" and state["MainPID"] == "0"
                for state in stopped.values()))
    profile = recovery.protected(PROFILE)
    require(sha256(profile) == profile_sha256)
    recovery.package_files(json_record(profile))
    ownership = recovery.package_ownership(candidate.version)
    require(ownership["boot_id"] == expected.boot_id
            and ownership["database_sha256"] != plan["ownership"]["database_sha256"])
    world = recovery.protected(VELLUM_WORLD)
    require(other_world_sha256(world, candidate.version, require_pin=True) == plan["other_world_sha256"])
    require(recovery.vendor_process(recovery.service(STOCK), STOCK_EXE, expected.stock_sha256,
                                    expected.buddy_start_micros) == stock["reader_invocation"]
            and recovery.vendor_process(recovery.service(SYNC), SYNC_EXE, SYNC_SHA256,
                                        expected.buddy_start_micros) == stock["sync_invocation"])
    require(recovery.protected(PROFILE) == profile and recovery.protected(VELLUM_WORLD) == world
            and recovery.package_ownership(candidate.version) == ownership
            and all(recovery.service(unit, allow_pending_reload=True) == state for unit, state in stopped.items()))
    return {"ownership": ownership, "profile_sha256": profile_sha256}


def execute(config, connection, boot, activation, profile_sha256, deadline, *,
            approved_version, candidate, replacement_profile_sha256, approved_plan):
    """Apply the retained reviewed candidate after the old service is recovered and disabled."""
    expected, stop, removal = load_intent(config, connection, boot, activation, profile_sha256, approved_version)
    require(stop["version"] == 2 and removal is None)
    require(isinstance(replacement_profile_sha256, str) and DIGEST.fullmatch(replacement_profile_sha256))
    path = replacement_path(config, boot, activation)
    if os.path.lexists(path):
        raise RecoveryPending("Replacement intent is already retained")
    started = False

    def inspect(transport):
        nonlocal started
        recovery = PackageRecovery(transport, deadline)
        stock = (retained_stock(config, boot, activation, stop)
                 if os.path.lexists(disable_path(config, boot, activation))
                 else recovery.observe_recovery(expected))

        def verify_locked():
            observe_disabled(recovery, expected, approved_version, stop, None, stock)
            require(replacement_plan(recovery, approved_version, candidate) == approved_plan)

        verify_locked()
        record = {"version": 1, "stop": stop, "stock": stock, "candidate": asdict(candidate),
                  "profile_sha256": replacement_profile_sha256, "plan": approved_plan}
        write_private_record(path, record)
        started = True
        argv = shlex.split(VELLUM_OFFLINE) + [
            "--repositories-file", f"{candidate.directory}/repositories", "--interactive=yes", "--verbose",
            "--no-scripts", "add", f"remarkable-buddies={candidate.version}",
        ]
        verb = transition_verb(approved_version, candidate.version)
        transition = f"(1/1) {verb} remarkable-buddies ({approved_version} -> {candidate.version})"
        run_locked_transaction(
            transport, deadline, lambda token: locked_command(activation, token, "replace", argv),
            lambda output: exact_replacement_prompt(output, approved_version, candidate.version),
            verify_locked, lambda output: exact_commit_result(output, transition),
        )
        return {"replacement": observe_replaced(
            recovery, expected, stock, candidate, replacement_profile_sha256, approved_plan)}

    try:
        return on_wire(config, inspect, connection)
    except Exception as error:
        if started:
            raise RecoveryPending("Vellum replacement outcome requires read-only reconciliation") from error
        raise


def observe(config, connection, boot, activation, profile_sha256, deadline, *,
            approved_version, candidate, replacement_profile_sha256, approved_plan):
    """Reconcile the retained revision change without dispatching a package command."""
    expected, stop, removal = load_intent(config, connection, boot, activation, profile_sha256, approved_version)
    require(stop["version"] == 2 and removal is None)
    raw = shared.private_bytes(replacement_path(config, boot, activation), parent_private=True, maximum=2048)
    record = json_record(raw)
    require(set(record) == {"version", "stop", "stock", "candidate", "profile_sha256", "plan"}
            and type(record["version"]) is int and record["version"] == 1 and record["stop"] == stop
            and record["candidate"] == asdict(candidate) and record["profile_sha256"] == replacement_profile_sha256
            and record["plan"] == approved_plan)

    def inspect(transport):
        return {"replacement": observe_replaced(
            PackageRecovery(transport, deadline), expected, record["stock"], candidate,
            replacement_profile_sha256, approved_plan)}

    return on_wire(config, inspect, connection)
