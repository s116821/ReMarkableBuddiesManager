"""Bounded selected archive selectors using existing identity-verified wired callbacks."""
import base64
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 24576
MAX_RESPONSE = 16384
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --archive-operation '
SELECTORS = {'inspect', 'export-selected'}


def parse(raw, limit):
    if len(raw) > limit:
        raise ValueError('input refused')
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('duplicate field')
            value[key] = item
        return value
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError('input refused')))
    def scalar(v):
        if isinstance(v, str):
            v.encode('utf-8')
        elif isinstance(v, dict):
            for k, item in v.items():
                scalar(k)
                scalar(item)
        elif isinstance(v, list):
            for item in v:
                scalar(item)
    scalar(value)
    return value


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError('input refused')


def digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value)


def uuid(value):
    return (isinstance(value, str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value)
            and value != '00000000-0000-0000-0000-000000000000')


def source_path(value):
    return (isinstance(value, str) and value.startswith('/') and value != '/'
            and '\x00' not in value
            and len(value.encode('utf-8')) <= 4096)


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id selector input_base64 budget_ms')
    if (not digest(v['connection_id']) or not uuid(v['boot_id'])
            or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000
            or not isinstance(v['selector'], str) or v['selector'] not in SELECTORS
            or not isinstance(v['input_base64'], str)):
        raise ValueError('input refused')
    decoded = base64.b64decode(v['input_base64'], validate=True)
    if base64.b64encode(decoded).decode('ascii') != v['input_base64']:
        raise ValueError('input refused')
    body = parse(decoded, 16384)
    exact(body, 'path')
    if not source_path(body['path']):
        raise ValueError('input refused')
    return v


def report_shape(report, selector):
    # Complete semantic/original admission occurs in the private Node coordinator.
    # Preserve future versions privately for its action-sensitive reduction.
    if not isinstance(report, dict) or type(report.get('report_version')) is not int or report['report_version'] < 1:
        raise ValueError('report refused')
    if report['report_version'] != 1:
        return
    exact(report, 'report_version operation status incomplete activation_performed data')
    if (report['operation'] != selector or report['activation_performed'] is not False
            or type(report['incomplete']) is not bool):
        raise ValueError('report refused')


def execute(transport, v, deadline=None):
    if deadline is None:
        deadline = time.monotonic() + v['budget_ms'] / 1000
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise shared.Refusal('timeout')
        return value
    remaining()
    before = shared.inspect(transport)
    remaining()
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    channel = transport.open_session(timeout=min(2, remaining()))
    output = bytearray()
    try:
        channel.settimeout(min(2, remaining()))
        remaining()
        channel.exec_command(PREFIX + v['selector'] + ' --archive-input -')
        channel.sendall(base64.b64decode(v['input_base64'], validate=True))
        try:
            channel.shutdown_write()
        except (OSError, EOFError):
            pass
        discarded = 0
        command_deadline = min(deadline, time.monotonic() + 8)
        while True:
            if time.monotonic() >= command_deadline:
                raise shared.Refusal('timeout')
            while channel.recv_ready():
                output.extend(channel.recv(4096))
                if len(output) > MAX_RESPONSE:
                    raise ValueError('oversized response')
            while channel.recv_stderr_ready():
                discarded += len(channel.recv_stderr(4096))
                if discarded > 8192:
                    raise ValueError('oversized diagnostics')
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                break
            time.sleep(.01)
        code = channel.recv_exit_status()
        one_line = output.endswith(b'\n') and output.count(b'\n') == 1
        report = parse(output, MAX_RESPONSE) if code == 0 and one_line else None
        if report is not None:
            report_shape(report, v['selector'])
        status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
        remaining()
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        remaining()
        before['_archive_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
        return before
    finally:
        output[:] = b'\x00' * len(output)
        output.clear()
        channel.close()


def main():
    timer = None
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'archive_raw': {'status': 'unavailable', 'stdout_base64': None}}
    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)
    try:
        v = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
        deadline = time.monotonic() + v['budget_ms'] / 1000
        def expire():
            respond(failure('timeout'))
            os._exit(0)
        timer = threading.Timer(max(0, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        if sys.platform not in ('linux', 'win32'):
            raise shared.Refusal('unsupported-host')
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise shared.Refusal('unconfigured')
        if time.monotonic() >= deadline:
            raise shared.Refusal('timeout')
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = windows_wired.observe(config, shared, inspection=lambda t: execute(t, v, deadline), expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=lambda t: execute(t, v, deadline), expected_connection=v['connection_id'])
        mode = observation.pop('_archive_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'archive_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
