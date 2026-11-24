"""Fixed offline first-configuration selectors over the existing wired channel."""
import json
import os
import re
import sys
import threading
import time

import storage_initialization_transport as transport_common
import wired_observer as shared
from personalization_transport import COMMAND_PREFIX, RESIDENT, STANDALONE, select_executable


MAX_OUTPUT = 4096
STATES = {
    'check-initial': ('missing', 'present', 'blocked'),
    'create-initial': ('created', 'present', 'blocked', 'unknown'),
    'check-existing-default': ('missing', 'present', 'blocked'),
    'create-existing-default': ('created', 'present', 'blocked', 'unknown'),
}


def resident_identity(transport, service, deadline):
    if select_executable(transport, service['LoadState'], without_arguments=True) != RESIDENT:
        raise shared.Refusal('observation-unavailable')
    output = bytearray()
    code = transport_common.exchange_no_input(
        transport, f'/usr/bin/env -i PATH=/usr/bin:/bin sha256sum {RESIDENT}',
        deadline, output, 512, require_eof=True)
    match = re.fullmatch(rb'([a-f0-9]{64})  ' + re.escape(RESIDENT.encode('ascii')) + rb'\n', output)
    if code or not match:
        raise shared.Refusal('observation-unavailable')
    return match[1].decode('ascii')


def request(raw):
    value = transport_common.parse(raw, transport_common.MAX_REQUEST)
    transport_common.exact(value, 'connection_id boot_id selector budget_ms service expected_executable_sha256')
    service = value['service']
    expected = value['expected_executable_sha256']
    existing = value['selector'] in ('check-existing-default', 'create-existing-default')
    transport_common.exact(service, 'LoadState ActiveState SubState')
    if (value['selector'] not in STATES
            or not transport_common.digest(value['connection_id']) or not transport_common.uuid(value['boot_id'])
            or type(value['budget_ms']) is not int or not 1 <= value['budget_ms'] <= 12000
            or service['LoadState'] not in (('loaded',) if existing else ('loaded', 'not-found'))
            or (not transport_common.digest(expected) if value['selector'] == 'create-existing-default'
                else expected is not None)
            or service['ActiveState'] != 'inactive' or service['SubState'] != 'dead'):
        raise ValueError('first configuration request refused')
    return value


def execute(transport, value, deadline, submitted):
    before = shared.inspect(transport)
    if before['boot_id'] != value['boot_id'] or before['service'] != value['service']:
        raise shared.Refusal('cable-lost')
    selector = value['selector']
    existing = selector.endswith('existing-default')
    executable = RESIDENT if existing else STANDALONE
    identity = resident_identity(transport, before['service'], deadline) if existing else None
    if value['expected_executable_sha256'] not in (None, identity):
        raise shared.Refusal('observation-unavailable')
    output = bytearray()
    try:
        code = transport_common.exchange_no_input(
            transport, f'{COMMAND_PREFIX} {executable} --configuration-operation {selector}',
            deadline, output, MAX_OUTPUT, submitted, require_eof=True)
        if code or not output.endswith(b'\n') or output.count(b'\n') != 1:
            raise ValueError('first configuration output refused')
        report = transport_common.parse(output, MAX_OUTPUT)
        transport_common.exact(report, 'operation report_version state')
        if report['operation'] != selector or type(report['report_version']) is not int \
                or report['report_version'] != 1 or report['state'] not in STATES[selector]:
            raise ValueError('first configuration report refused')
        if time.monotonic() >= deadline or shared.inspect(transport) != before or time.monotonic() >= deadline:
            raise shared.Refusal('cable-lost')
        if existing and resident_identity(transport, before['service'], deadline) != identity:
            raise shared.Refusal('observation-unavailable')
        before['_first_config'] = (report, identity)
        return before
    finally:
        output[:] = b'\x00' * len(output)
        output.clear()


def main():
    timer = None
    lock = threading.Lock()
    possible, responded = False, False

    def submitted():
        nonlocal possible
        with lock:
            if responded or time.monotonic() >= deadline:
                raise shared.Refusal('timeout')
            possible = True

    def respond(observation=None, report=None, executable_sha256=None):
        nonlocal responded
        with lock:
            if responded:
                return
            responded = True
            print(json.dumps({'dispatch': 'possible' if possible else 'not-dispatched',
                              'observation': observation, 'report': report, 'executable_sha256': executable_sha256}), flush=True)

    try:
        sys.stdout.write('READY\n')
        sys.stdout.flush()
        value = request(sys.stdin.buffer.read(transport_common.MAX_REQUEST + 1))
        deadline = time.monotonic() + value['budget_ms'] / 1000
        if sys.platform not in ('linux', 'win32'):
            raise ValueError('unsupported host')
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise ValueError('unsupported transport')
        def expire():
            respond()
            os._exit(0)
        timer = threading.Timer(max(0, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        def inspect(transport):
            return execute(transport, value, deadline, submitted)
        config_path = os.environ['MANAGER_WIRED_CONFIG']
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(config_path)
            observation = windows_wired.observe(config, shared, inspection=inspect,
                                                expected_connection=value['connection_id'])
        else:
            config = shared.load_config(config_path)
            observation = shared.observe(config, inspection=inspect, expected_connection=value['connection_id'])
        report, executable_sha256 = observation.pop('_first_config')
        if time.monotonic() >= deadline:
            respond()
        else:
            respond(observation, report, executable_sha256)
    except Exception:
        respond()
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
