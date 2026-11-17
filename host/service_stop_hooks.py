"""Pure bounded busctl-call JSON decoder. No collector or admission logic."""

import json


PROPERTIES = ("ExecStop", "ExecStopPost")
SIGNATURE = "a(sasbttttuii)"
STDOUT_LIMIT = 32768
STDERR_LIMIT = 8192
COMMAND_LIMIT = 32
ARGV_LIMIT = 256
STRING_LIMIT = 4096


class _Invalid(ValueError):
    pass


def _reject_number(_value):
    raise _Invalid()


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _Invalid()
        result[key] = value
    return result


def _string(value):
    if type(value) is not str or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-8", "strict")) <= STRING_LIMIT
    except UnicodeError:
        return False


def _integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def _command(value):
    return (
        type(value) is list
        and len(value) == 10
        and _string(value[0])
        and type(value[1]) is list
        and len(value[1]) <= ARGV_LIMIT
        and all(_string(arg) for arg in value[1])
        and type(value[2]) is bool
        and all(_integer(v, 0, (1 << 64) - 1) for v in value[3:7])
        and _integer(value[7], 0, (1 << 32) - 1)
        and all(_integer(v, -(1 << 31), (1 << 31) - 1) for v in value[8:10])
    )


def decode_hook(property_id, stdout, stderr, exit_code, *, complete):
    """Reduce an already bounded, fully captured reply; never return input data.

    The caller owns transport completion, output caps, provenance, identity and
    freshness. This function does not verify any of them or authorize Stop.
    Invalid programmer property IDs raise only a fixed, value-free error.
    """
    if type(property_id) is not str or property_id not in PROPERTIES:
        raise ValueError("invalid-property-id")

    def result(reason, observation="unknown", verified=False):
        return {"property": property_id, "observation": observation,
                "type_verified": verified, "reason": reason}

    if complete is not True:
        return result("transport-incomplete")
    if type(stdout) is not bytes or type(stderr) is not bytes:
        return result("invalid-input")
    if len(stdout) > STDOUT_LIMIT or len(stderr) > STDERR_LIMIT:
        return result("response-limit")
    if type(exit_code) is not int or not 0 <= exit_code <= 255:
        return result("invalid-exit-status")
    if exit_code != 0:
        return result("client-error")
    if stderr:
        return result("unexpected-stderr")
    try:
        reply = json.loads(stdout.decode("utf-8", "strict"),
                           object_pairs_hook=_object,
                           parse_float=_reject_number,
                           parse_constant=_reject_number)
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        return result("malformed-json")

    if (type(reply) is not dict or set(reply) != {"type", "data"}
            or reply["type"] != "v" or type(reply["data"]) is not list
            or len(reply["data"]) != 1):
        return result("wrong-envelope")
    variant = reply["data"][0]
    if type(variant) is not dict or set(variant) != {"type", "data"}:
        return result("wrong-envelope")
    if variant["type"] != SIGNATURE:
        return result("wrong-signature")
    commands = variant["data"]
    if type(commands) is not list or len(commands) > COMMAND_LIMIT:
        return result("invalid-command-array")
    if not all(_command(command) for command in commands):
        return result("invalid-command-array")
    if commands:
        return result("typed-nonempty", "observed-nonempty", True)
    return result("typed-empty", "observed-empty", True)


# Private fixed command/data grammar; no I/O or admission is performed here.
import re
import shlex
CLIENT = '/usr/bin/busctl'
EXPECTED_SHA256 = '16163b78bf052fa4d74654086216fde42184294e455ae86a1b44808d94930c21'
EXPECTED_BYTES = 71172
METADATA_KEYS = ('device','inode','uid','gid','mode','bytes','links','mtime','ctime')
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/usr/bin:/bin LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat /bin/sh -c '
BUS_PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/usr/bin:/bin LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket /bin/sh -c '
CALL_PREFIX = (CLIENT,'--system','--no-pager','--json=short','--expect-reply=yes','--auto-start=no','--allow-interactive-authorization=no','--timeout=2s','call')

IDENTITY_SCRIPT = "printf 'CAPCLIENT1\\n'\nif test -L /usr/bin/busctl; then printf 'symlink\\n'\nelif test ! -e /usr/bin/busctl; then printf 'absent\\n'\nelif test ! -f /usr/bin/busctl || test ! -x /usr/bin/busctl; then printf 'ineligible\\n'\nelif test -L /usr || test -L /usr/bin; then printf 'parent-alias\\n'\nelse\n printf 'present\\n'\n stat -c '%d %i %u %g %f %s %h %Y %Z' -- / /usr /usr/bin /usr/bin/busctl &&\n sha256sum -- /usr/bin/busctl\nfi"

def owner_valid(value):
    return type(value) is str and re.fullmatch(r':[0-9]{1,10}(?:\.[0-9]{1,10}){1,3}', value) is not None

def scalar(code, out, err, signature):
    if type(code) is not int or code != 0 or err or type(out) is not bytes or not 0 < len(out) <= 4096:
        raise ValueError('client-reply-invalid')
    try:
        value = json.loads(out.decode('utf-8', 'strict'), object_pairs_hook=_object,
                           parse_float=_reject_number, parse_constant=_reject_number)
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        raise ValueError('client-reply-invalid') from None
    if (type(value) is not dict or set(value) != {'type', 'data'} or value['type'] != signature
            or type(value['data']) is not list or len(value['data']) != 1):
        raise ValueError('client-reply-invalid')
    result = value['data'][0]
    if signature in ('s', 'o'):
        if type(result) is not str or len(result) > 256 or any(ord(c) < 33 or ord(c) > 126 for c in result):
            raise ValueError('client-reply-invalid')
    elif signature == 'u':
        if type(result) is not int or not 0 <= result < 2**32:
            raise ValueError('client-reply-invalid')
    else:
        raise ValueError('host-schema')
    return result

def bus_id(code, out, err):
    value = scalar(code, out, err, 's')
    if re.fullmatch('[0-9a-f]{32}', value) is None:
        raise ValueError('client-reply-invalid')
    return value

def bus_owner(code, out, err):
    value = scalar(code, out, err, 's')
    if not owner_valid(value):
        raise ValueError('client-reply-invalid')
    return value

def pid_one(code, out, err):
    if scalar(code, out, err, 'u') != 1:
        raise ValueError('pid-not-one')
    return True

def identity(code, out, err):
    if type(code) is not int or code != 0 or err or len(out) > 4096:
        raise ValueError('client-identity-invalid')
    lines = out.decode('ascii').splitlines()
    if len(lines) == 2 and lines[0] == 'CAPCLIENT1' and lines[1] in ('absent', 'symlink', 'ineligible', 'parent-alias'):
        return dict(state=lines[1], metadata=None, sha256=None)
    if len(lines) != 7 or lines[:2] != ['CAPCLIENT1', 'present']:
        raise ValueError('client-identity-invalid')
    records = []
    for index, line in enumerate(lines[2:6]):
        values = line.split(' ')
        if len(values) != 9 or any(not re.fullmatch('[0-9a-f]+' if i == 4 else '[0-9]+', v) for i, v in enumerate(values)):
            raise ValueError('client-identity-invalid')
        numbers = [int(v, 16 if i == 4 else 10) for i, v in enumerate(values)]
        if any(n >= 2**64 for n in numbers) or numbers[0] == 0 or numbers[1] == 0 or numbers[6] == 0:
            raise ValueError('client-identity-invalid')
        mode = numbers[4]
        if numbers[2:4] != [0, 0] or mode & 0o022 or mode & 0o170000 != (0o100000 if index == 3 else 0o040000):
            raise ValueError('client-identity-invalid')
        if index == 3 and (not mode & 0o111 or mode & 0o6000 or not 0 < numbers[5] <= 16 * 1024**2):
            raise ValueError('client-identity-invalid')
        records.append(dict(zip(METADATA_KEYS, numbers)))
    match = re.fullmatch('([0-9a-f]{64})  /usr/bin/busctl', lines[6])
    if not match:
        raise ValueError('client-identity-invalid')
    return dict(state='present', metadata=records, sha256=match[1])
