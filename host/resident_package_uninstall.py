"""Host-private, one-shot removal of a recovered, disabled resident package."""

import os
import re
import secrets
import shlex
import time

from resident_package_recovery import (
    ACTIVE_LEASE, BUDDY, HELPER, OWNER_PATHS, RUNTIME, STOCK, STOCK_EXE, SYNC,
    SYNC_EXE, SYNC_SHA256, VELLUM_APK, VELLUM_APK_SHA256, VELLUM_DB, VELLUM_OFFLINE,
    PackageRecovery, json_record, require, sha256,
)
from resident_package_transition import (
    RecoveryPending, intent_path, load_intent, on_wire, write_private_record,
)
from service_stop_sampler import PREFIX
import wired_observer as shared


PROMPT = b"Do you want to continue [Y/n]? "
ADVISORY = [
    b"NOTE: Consider running apk upgrade with --prune and/or --available.",
    b"The following packages are no longer available from a repository:",
]
RELEASED_FILES = (*OWNER_PATHS,
                  "/home/root/.local/lib/remarkable-buddies/OpenSDK-LICENSE",
                  "/home/root/.local/lib/remarkable-buddies/Dobby-LICENSE",
                  "/usr/share/remarkable-buddies/LICENSE",
                  "/usr/share/remarkable-buddies/build.json")
# Keep a writer open inside apk so losing the feeder cannot turn into approval
# via EOF. PID 1 bounds the entire group, including a feeder killed before reply.
FEEDER = r"""
set -eu
work=$(mktemp -d)
mkfifo -m 600 "$work/input"
exec 3<>"$work/input"
rm -- "$work/input"
rmdir -- "$work"
exec 4<&0
(
    if IFS= read -r -t 40 -n 37 decision <&4 && [ "$decision" = "$1" ]; then
        printf 'y\n' >&3
    else
        printf 'n\n' >&3
    fi
) &
feeder=$!
shift
status=0
"$@" <&3 4<&- || status=$?
kill "$feeder" 2>/dev/null || :
wait "$feeder" 2>/dev/null || :
exit "$status"
"""


def exact_prompt(output, version):
    require(output.endswith(PROMPT))
    lines = output[:-len(PROMPT)].splitlines()
    if lines[:2] == ADVISORY:
        lines = lines[2:]
        while lines and re.fullmatch(rb"  [a-zA-Z0-9_.+ -]+", lines[0]):
            lines = lines[1:]
    require(len(lines) == 3 and lines[0] == b"The following packages will be REMOVED:"
            and lines[1] == f"  remarkable-buddies ({version})".encode("ascii")
            and re.fullmatch(rb"After this operation, [0-9]+(?:\.[0-9]+)? [A-Za-z]+ of disk space will be freed\.",
                             lines[2]))


def fixed_command(activation, token):
    apk = shlex.split(VELLUM_OFFLINE) + [
        "--repositories-file", "/dev/null", "--interactive=yes", "--verbose",
        "--no-scripts", "del", "remarkable-buddies",
    ]
    service = [
        "/usr/bin/systemd-run", "--quiet", "--pipe", "--wait",
        f"--unit=remarkable-buddies-remove-{activation}", "--property=Type=exec",
        "--property=RuntimeMaxSec=55s", "--property=TimeoutStopSec=3s",
        "--property=KillMode=control-group", "--property=Restart=no",
        "/usr/bin/env", "-i", "HOME=/home/root", "PATH=/usr/bin:/bin", "LC_ALL=C",
        "/bin/bash", "-c", FEEDER, "remarkable-buddies-remove", token,
        "/usr/bin/env", *apk,
    ]
    guard = f'test "$(sha256sum {VELLUM_APK})" = "{VELLUM_APK_SHA256}  {VELLUM_APK}" && '
    return PREFIX + shlex.quote(guard + shlex.join(service))


def run_locked(transport, deadline, activation, version, verify_locked):
    end = min(deadline, time.monotonic() + 60)
    require(end > time.monotonic())
    channel = transport.open_session(timeout=min(2, end - time.monotonic()))
    token = secrets.token_hex(16)
    output = bytearray()
    approved = False
    try:
        channel.settimeout(min(2, end - time.monotonic()))
        channel.exec_command(fixed_command(activation, token))
        while time.monotonic() < end:
            if channel.recv_stderr_ready():
                require(not channel.recv_stderr(4096))
            if channel.recv_ready():
                output.extend(channel.recv(4096))
                require(len(output) <= 8192)
            if not approved and output.endswith(PROMPT):
                exact_prompt(output, version)
                verify_locked()
                require(time.monotonic() < end and not channel.exit_status_ready()
                        and not channel.recv_stderr_ready() and not channel.recv_ready())
                channel.sendall((token + "\n").encode("ascii"))
                channel.shutdown_write()
                approved = True
                output.clear()
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                require(approved and channel.recv_exit_status() == 0)
                lines = output.splitlines()
                require(len(lines) == 2
                        and lines[0] == f"(1/1) Purging remarkable-buddies ({version})".encode("ascii")
                        and re.fullmatch(rb"OK: [0-9]+ packages, [0-9]+ dirs, [0-9]+ files, "
                                         rb"[0-9]+(?:\.[0-9]+)? [A-Za-z]+", lines[1]))
                return
            time.sleep(0.01)
        raise shared.Refusal("timeout")
    finally:
        channel.close()


def removal_path(config, boot, activation):
    stop = intent_path(config, boot, activation)
    return stop.with_name(f"resident-remove-{boot}-{activation}.json")


def removed(recovery, expected, plan, stock):
    require(recovery.boot() == expected.boot_id)
    archived = f"{RUNTIME}/recovered-{expected.activation_id}.json"
    require(sha256(recovery.protected(archived, private=True)) == expected.lease_sha256)
    paths = (*RELEASED_FILES, ACTIVE_LEASE, "/etc/systemd/system/reader-buddy.service")
    recovery.read(" && ".join(f"test ! -e {path} && test ! -L {path}" for path in paths), 32)
    database = f'test ! -L {VELLUM_DB} && test -f {VELLUM_DB} && sha256sum {VELLUM_DB}'
    checksum = recovery.read(database, 256)
    require(re.fullmatch(rb"[0-9a-f]{64}  " + re.escape(VELLUM_DB.encode()) + rb"\n", checksum)
            and checksum[:64].decode("ascii") != plan["ownership"]["database_sha256"])
    code, out, err = recovery.sampler.command(
        f'test "$(sha256sum {VELLUM_APK})" = "{VELLUM_APK_SHA256}  {VELLUM_APK}" || exit 92; '
        f'{VELLUM_OFFLINE} info --exists remarkable-buddies', 1024)
    require((code, out, err) == (1, b"", b""))
    require(recovery.vendor_process(recovery.service(STOCK), STOCK_EXE, expected.stock_sha256,
                                    expected.buddy_start_micros) == stock["reader_invocation"]
            and recovery.vendor_process(recovery.service(SYNC), SYNC_EXE, SYNC_SHA256,
                                        expected.buddy_start_micros) == stock["sync_invocation"]
            and recovery.read(database, 256) == checksum and recovery.boot() == expected.boot_id)
    return {"removed": plan["ownership"]["package"], "database_sha256": checksum[:64].decode("ascii")}


def execute(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Apply the retained exact removal plan once, after recovery and explicit disable."""
    expected, stop, plan = load_intent(config, connection, boot, activation, profile_sha256, approved_version)
    require(plan is not None)
    path = removal_path(config, boot, activation)
    if os.path.lexists(path):
        raise RecoveryPending("Removal intent is already retained")
    started = False

    def inspect(transport):
        nonlocal started
        recovery = PackageRecovery(transport, deadline)
        stock = recovery.observe_recovery(expected)

        def verify_locked():
            require(recovery.observe_recovery(expected) == stock and recovery.removal_plan(approved_version) == plan)
            for unit, state in ((BUDDY, b"disabled\n"), (HELPER, b"static\n")):
                require(recovery.read(f"/bin/systemctl show -p UnitFileState --value -- {unit}", 32) == state)

        verify_locked()
        write_private_record(path, {"version": 1, "stop": stop, "stock": stock})
        started = True
        run_locked(transport, deadline, activation, approved_version, verify_locked)
        return {"removal": removed(recovery, expected, plan, stock)}

    try:
        return on_wire(config, inspect, connection)
    except Exception as error:
        if started:
            raise RecoveryPending("Vellum removal outcome requires read-only reconciliation") from error
        raise


def observe(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Reconcile the original removal from installed state without opening an apply channel."""
    expected, stop, plan = load_intent(config, connection, boot, activation, profile_sha256, approved_version)
    require(plan is not None)
    raw = shared.private_bytes(removal_path(config, boot, activation), parent_private=True, maximum=2048)
    record = json_record(raw)
    require(set(record) == {"version", "stop", "stock"} and type(record["version"]) is int
            and record["version"] == 1 and record["stop"] == stop)

    def inspect(transport):
        return {"removal": removed(PackageRecovery(transport, deadline), expected, plan, record["stock"])}

    return on_wire(config, inspect, connection)
