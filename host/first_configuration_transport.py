"""Fixed offline first-configuration selectors over the existing wired channel."""
import json
import os
import sys
import threading
import time

import storage_initialization_transport as transport_common
import wired_observer as shared


MAX_OUTPUT = 4096
PREFIX = ('/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin '
          'REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json '
          '/opt/bin/reader-buddy --configuration-operation ')
STATES = {'check-initial': ('missing', 'present', 'blocked'),
          'create-initial': ('created', 'present', 'blocked', 'unknown')}


def request(raw):
    value = transport_common.parse(raw, transport_common.MAX_REQUEST)
    transport_common.exact(value, 'connection_id boot_id selector budget_ms service')
    service = value['service']
    transport_common.exact(service, 'LoadState ActiveState SubState')
    if (value['selector'] not in STATES
            or not transport_common.digest(value['connection_id']) or not transport_common.uuid(value['boot_id'])
            or type(value['budget_ms']) is not int or not 1 <= value['budget_ms'] <= 12000
            or service['LoadState'] not in ('loaded', 'not-found')
            or service['ActiveState'] != 'inactive' or service['SubState'] != 'dead'):
        raise ValueError('first configuration request refused')
    return value


def execute(transport, value, deadline, submitted):
    before = shared.inspect(transport)
    if before['boot_id'] != value['boot_id'] or before['service'] != value['service']:
        raise shared.Refusal('cable-lost')
    selector = value['selector']
    output = bytearray()
    try:
        code = transport_common.exchange_no_input(
            transport, PREFIX + selector, deadline, output, MAX_OUTPUT, submitted, require_eof=True)
        if code or not output.endswith(b'\n') or output.count(b'\n') != 1:
            raise ValueError('first configuration output refused')
        report = transport_common.parse(output, MAX_OUTPUT)
        transport_common.exact(report, 'operation report_version state')
        if report['operation'] != selector or type(report['report_version']) is not int \
                or report['report_version'] != 1 or report['state'] not in STATES[selector]:
            raise ValueError('first configuration report refused')
        if time.monotonic() >= deadline or shared.inspect(transport) != before or time.monotonic() >= deadline:
            raise shared.Refusal('cable-lost')
        before['_first_config'] = report
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

    def respond(observation=None, report=None):
        nonlocal responded
        with lock:
            if responded:
                return
            responded = True
            print(json.dumps({'dispatch': 'possible' if possible else 'not-dispatched',
                              'observation': observation, 'report': report}), flush=True)

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
        report = observation.pop('_first_config')
        if time.monotonic() >= deadline:
            respond()
        else:
            respond(observation, report)
    except Exception:
        respond()
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
