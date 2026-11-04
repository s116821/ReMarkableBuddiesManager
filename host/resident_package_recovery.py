"""Read-only RM2 resident recovery evidence for a future package transaction."""

from dataclasses import dataclass
import hashlib
import json
import re
import shlex

from service_stop_sampler import Sampler


LIB = "/home/root/.local/lib/remarkable-buddies"
UNIT_DIR = "/usr/lib/systemd/system"
RUNTIME = "/run/reader-buddy-resident"
ACTIVE_LEASE = f"{RUNTIME}/activation.json"
PROFILE = f"{LIB}/resident-recovery.json"
APP = f"{LIB}/reader-buddy"
BUDDY = "reader-buddy.service"
HELPER = "reader-buddy-stock-recovery.service"
STOCK = "xochitl.service"
SYNC = "rm-sync.service"
UNITS = (BUDDY, HELPER, STOCK, SYNC)
STOCK_EXE = "/usr/bin/xochitl"
SYNC_EXE = "/usr/bin/rm-sync"
SYNC_SHA256 = "1caf6493cce2132af89a9377679c19005bef1c5b0e658f704f95b4fdbd07138c"
BOOT = "/proc/sys/kernel/random/boot_id"
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
INVOCATION = re.compile(r"[0-9a-f]{32}")
DIGEST = re.compile(r"[0-9a-f]{64}")
POSITIVE = re.compile(r"[1-9][0-9]{0,19}")
PROPERTIES = (
    "Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job",
    "InvocationID", "FragmentPath", "DropInPaths", "NeedDaemonReload", "Result",
    "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic",
    "ExecMainCode", "ExecMainStatus",
)
PACKAGE_FILES = (
    (APP, "app_sha256", "755", 128 * 1024 * 1024),
    (f"{LIB}/libremarkable-resident.so", "adapter_sha256", "644", 32 * 1024 * 1024),
    (f"{LIB}/resident-profile.json", "native_profile_sha256", "644", 32768),
    (f"{UNIT_DIR}/{BUDDY}", "buddy_unit_sha256", "644", 32768),
    (f"{UNIT_DIR}/{HELPER}", "helper_unit_sha256", "644", 32768),
)


def require(value):
    if not value:
        raise ValueError("resident package recovery observation refused")


def json_record(raw):
    def unique(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result

    result = json.loads(raw, object_pairs_hook=unique)
    require(isinstance(result, dict))
    return result


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def digest_field(value):
    require(isinstance(value, list) and len(value) == 32
            and all(type(byte) is int and 0 <= byte <= 255 for byte in value))
    return bytes(value).hex()


def positive(value):
    require(isinstance(value, str) and POSITIVE.fullmatch(value))
    return int(value)


def invocation(value):
    require(isinstance(value, str) and INVOCATION.fullmatch(value) and int(value, 16))
    return value


@dataclass(frozen=True)
class Activation:
    boot_id: str
    activation_id: str
    lease_sha256: str
    profile_sha256: str
    buddy_invocation: str
    buddy_start_micros: int
    stock_sha256: str


class PackageRecovery:
    def __init__(self, transport, deadline):
        self.sampler = Sampler(transport, deadline)

    def read(self, script, cap=32768):
        code, out, err = self.sampler.command(script, cap)
        require(code == 0 and not err and len(out) <= cap)
        return out

    def boot(self):
        raw = self.read(f"cat {BOOT}", 64).decode("ascii")
        require(raw.endswith("\n") and UUID.fullmatch(raw[:-1]))
        return raw[:-1]

    def service(self, unit):
        require(unit in UNITS)
        props = " ".join(f"--property={name}" for name in PROPERTIES)
        raw = self.read(f"/bin/systemctl --system --no-pager --no-ask-password --all show {props} -- {unit}")
        state = {}
        for line in raw.decode("ascii").splitlines():
            key, sep, value = line.partition("=")
            require(sep and key in PROPERTIES and key not in state)
            state[key] = value
        require(set(state) == set(PROPERTIES) and state["Id"] == unit and state["LoadState"] == "loaded"
                and state["ControlPID"] == "0" and not state["Job"] and state["NeedDaemonReload"] == "no")
        require(state["FragmentPath"] == f"{UNIT_DIR}/{unit}")
        dropins = "" if unit in (BUDDY, HELPER) else f"{UNIT_DIR}/{unit}.d/{unit[:-8]}-service-override.conf"
        require(state["DropInPaths"] == dropins)
        return state

    def protected(self, path, *, private=False):
        path = shlex.quote(path)
        prefix = f"test ! -L {path} && test -f {path} && test \"$(readlink -f {path})\" = {path} && "
        command = f"{prefix}stat -c '%d:%i:%u:%g:%a:%h:%s:%Y:%Z' {path}"
        before = self.read(command, 192)
        require(re.fullmatch(rb"[0-9]+(?::[0-9]+){8}\n", before))
        _, _, uid, gid, mode, links, length, _, _ = before.decode().strip().split(":")
        require(uid == gid == "0" and links == "1" and 0 < int(length) <= 32768)
        require((int(mode, 8) == 0o600) if private else (int(mode, 8) & 0o022 == 0))
        data = self.read(f"{prefix}dd if={path} bs=32769 count=1 2>/dev/null")
        require(len(data) == int(length) and self.read(command, 192) == before)
        return data

    def package_files(self, profile):
        require(profile["version"] == 6 and profile["firmware"] == "3.28.0.172"
                and profile["companion"] == "rm2-3.28.0.172-v1"
                and profile["source_mode"] == "resident-installed-output-v1")
        for path, field, mode, limit in PACKAGE_FILES:
            checksum = digest_field(profile[field])
            quoted = shlex.quote(path)
            stat = f"stat -c '%d:%i:%u:%g:%a:%h:%s:%Y:%Z' {quoted}"
            raw = self.read(
                f'test ! -L {quoted} && test -f {quoted} && '
                f'test "$(readlink -f {quoted})" = {quoted} && '
                f'test "$(stat -c %s {quoted})" -le {limit} && '
                f'{stat} && sha256sum {quoted} && {stat}', 512)
            before, observed, after = raw.splitlines()
            require(before == after and re.fullmatch(rb"[0-9]+(?::[0-9]+){8}", before))
            _, _, uid, gid, permissions, links, length, _, _ = before.decode().split(":")
            require(uid == gid == "0" and permissions == mode and links == "1"
                    and 0 < int(length) <= limit
                    and observed == f"{checksum}  {path}".encode())

    def runtime(self):
        require(self.read(f"test ! -L {RUNTIME} && test -d {RUNTIME} && "
                          f'test "$(readlink -f {RUNTIME})" = {RUNTIME} && '
                          f"stat -c '%u:%g:%a' {RUNTIME}", 32) == b"0:0:700\n")

    def capture_activation(self):
        boot = self.boot()
        buddy = self.service(BUDDY)
        require(buddy["ActiveState"] == "active" and buddy["SubState"] == "running")
        pid = positive(buddy["MainPID"])
        inv = invocation(buddy["InvocationID"])
        started = positive(buddy["ExecMainStartTimestampMonotonic"])
        self.runtime()
        lease = self.protected(ACTIVE_LEASE, private=True)
        record = json_record(lease)
        activation = record["activation"]
        require(isinstance(activation, str) and UUID.fullmatch(activation) and int(activation.replace("-", ""), 16))
        group = record["group"]
        require(record["version"] == 3 and group["unit"] == BUDDY and group["context"]["boot"] == boot
                and group["parent"]["pid"] == pid and record["buddy_invocation"] == inv
                and record["buddy_start_micros"] == started and isinstance(record["companion"], str))
        profile_raw = self.protected(PROFILE)
        profile = json_record(profile_raw)
        profile_sha = digest_field(record["recovery_profile_sha256"])
        require(sha256(profile_raw) == profile_sha)
        stock_sha = digest_field(record["stock"]["executable_sha256"])
        require(stock_sha == digest_field(profile["stock_executable_sha256"]))
        self.package_files(profile)
        require(pid < 2**32 and self.read(f"readlink /proc/{pid}/exe", 256) == (APP + "\n").encode())
        require(self.service(BUDDY) == buddy and self.boot() == boot
                and self.protected(ACTIVE_LEASE, private=True) == lease
                and self.protected(PROFILE) == profile_raw)
        return Activation(boot, activation, sha256(lease), profile_sha, inv, started, stock_sha)

    def vendor_process(self, state, executable, checksum, after):
        require(state["ActiveState"] == "active" and state["SubState"] == "running"
                and state["Result"] == "success")
        pid = positive(state["MainPID"])
        require(pid < 2**32 and positive(state["ExecMainStartTimestampMonotonic"]) > after)
        inv = invocation(state["InvocationID"])
        path = f"/proc/{pid}/exe"
        require(self.read(f"readlink {path}", 256) == (executable + "\n").encode())
        require(self.read(f"sha256sum {path}", 256) == f"{checksum}  {path}\n".encode())
        return inv

    def observe_recovery(self, expected):
        require(isinstance(expected, Activation) and UUID.fullmatch(expected.activation_id)
                and all(DIGEST.fullmatch(value) for value in
                        (expected.lease_sha256, expected.profile_sha256, expected.stock_sha256)))
        require(self.boot() == expected.boot_id)
        self.runtime()
        archived = f"{RUNTIME}/recovered-{expected.activation_id}.json"
        require(sha256(self.protected(archived, private=True)) == expected.lease_sha256)
        profile_raw = self.protected(PROFILE)
        require(sha256(profile_raw) == expected.profile_sha256)
        states = {unit: self.service(unit) for unit in UNITS}
        for unit in (BUDDY, HELPER):
            state = states[unit]
            require(state["ActiveState"] == "inactive" and state["SubState"] == "dead"
                    and state["MainPID"] == "0" and state["Result"] == "success")
        require(states[BUDDY]["InvocationID"] == expected.buddy_invocation)
        helper = states[HELPER]
        helper_start = positive(helper["ExecMainStartTimestampMonotonic"])
        require(helper["ExecMainCode"] == "1" and helper["ExecMainStatus"] == "0"
                and positive(helper["ExecMainExitTimestampMonotonic"]) >= helper_start
                and helper_start > expected.buddy_start_micros)
        helper_inv = invocation(helper["InvocationID"])
        stock_inv = self.vendor_process(states[STOCK], STOCK_EXE, expected.stock_sha256, helper_start)
        sync_inv = self.vendor_process(states[SYNC], SYNC_EXE, SYNC_SHA256, helper_start)
        self.package_files(json_record(profile_raw))
        require(states == {unit: self.service(unit) for unit in UNITS})
        self.read(f"test ! -e {ACTIVE_LEASE} && test ! -L {ACTIVE_LEASE}", 32)
        require(sha256(self.protected(archived, private=True)) == expected.lease_sha256
                and sha256(self.protected(PROFILE)) == expected.profile_sha256
                and self.boot() == expected.boot_id)
        return {"boot_id": expected.boot_id, "activation_id": expected.activation_id,
                "lease_sha256": expected.lease_sha256, "recovery_invocation": helper_inv,
                "reader_invocation": stock_inv, "sync_invocation": sync_inv}
