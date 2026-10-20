"""Bounded ordinary-export selectors using existing identity-verified wired callbacks."""
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
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --ordinary-export-operation '
SELECTORS = {'prepare', 'apply', 'status'}


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
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('input refused')))


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError('input refused')


def digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value)


def uuid(value):
    return (isinstance(value, str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value)
            and value != '00000000-0000-0000-0000-000000000000')


def destination(value):
    return isinstance(value, str) and value.startswith('/') and value != '/' and '\0' not in value and len(value.encode('utf-8')) <= 4096


def summary(value):
    exact(value, 'format manifests objects complete_media configuration_included')
    if (type(value['format']) is not int or value['format'] != 1
            or not all(type(value[k]) is int and 0 <= value[k] <= 4096 for k in ('manifests', 'objects'))
            or not all(type(value[k]) is bool for k in ('complete_media', 'configuration_included'))):
        raise ValueError('report refused')


def intent(value):
    exact(value, 'export_version operation config_path_sha256 config_sha256 destination_path_sha256 actor mode_sha256 base_generation base_history_sha256 configuration_snapshot_sha256 archive_sha256 complete_media')
    if (type(value['export_version']) is not int or value['export_version'] != 1
            or not all(uuid(value[k]) for k in ('operation', 'actor', 'base_generation'))
            or not all(digest(value[k]) for k in ('config_path_sha256', 'config_sha256', 'destination_path_sha256', 'mode_sha256', 'base_history_sha256', 'archive_sha256'))
            or value['configuration_snapshot_sha256'] is not None and not digest(value['configuration_snapshot_sha256'])
            or type(value['complete_media']) is not bool):
        raise ValueError('input refused')


def report_shape(report, selector):
    exact(report, 'report_version operation status outcome disk_readback_verified runtime_activation data')
    if (type(report['report_version']) is not int or report['report_version'] != 1 or report['operation'] != selector
            or report['status'] not in ('ok', 'invalid-input', 'unavailable', 'unsupported', 'busy', 'conflict', 'failed')
            or report['runtime_activation'] != 'unverified'):
        raise ValueError('report refused')
    data = report['data']
    if report['status'] != 'ok':
        allowed = ('read-only',) if selector == 'status' else ('not-dispatched', 'not-published', 'unknown') if selector == 'apply' and report['status'] == 'failed' else ('not-dispatched',)
        if data is not None or report['outcome'] not in allowed or report['disk_readback_verified'] is not False:
            raise ValueError('report refused')
        return
    outcomes = {'prepare': ('prepared',), 'apply': ('verified',), 'status': ('desired-archive-observed', 'unresolved')}
    if report['outcome'] not in outcomes[selector] or report['disk_readback_verified'] is not (selector == 'apply'):
        raise ValueError('report refused')
    if selector == 'status' and report['outcome'] == 'unresolved':
        if data is not None:
            raise ValueError('report refused')
        return
    if selector == 'prepare':
        exact(data, 'source intent')
        summary(data['source'])
        intent(data['intent'])
        if data['source']['complete_media'] != data['intent']['complete_media']:
            raise ValueError('report refused')
    else:
        exact(data, 'archive_sha256 inspection')
        if not digest(data['archive_sha256']):
            raise ValueError('report refused')
        summary(data['inspection'])


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id selector input_base64 budget_ms')
    if (not digest(v['connection_id']) or not uuid(v['boot_id'])
            or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000
            or v['selector'] not in SELECTORS or not isinstance(v['input_base64'], str)):
        raise ValueError('input refused')
    body = base64.b64decode(v['input_base64'], validate=True)
    if base64.b64encode(body).decode('ascii') != v['input_base64']:
        raise ValueError('input refused')
    value = parse(body, 16384)
    if v['selector'] == 'prepare':
        exact(value, 'export_version operation destination')
        if type(value['export_version']) is not int or value['export_version'] != 1 or not uuid(value['operation']):
            raise ValueError('input refused')
    else:
        exact(value, 'destination intent')
        intent(value['intent'])
    if not destination(value['destination']):
        raise ValueError('input refused')
    if v['selector'] != 'prepare':
        import hashlib
        path_hash = hashlib.sha256(b'urn:remarkable-buddies:ordinary-export-path:v1:' + value['destination'].encode('utf-8')).hexdigest()
        config_hash = hashlib.sha256(b'urn:remarkable-buddies:ordinary-export-config:v1:/home/root/.config/remarkable-buddies/config.json').hexdigest()
        if value['intent']['destination_path_sha256'] != path_hash or value['intent']['config_path_sha256'] != config_hash:
            raise ValueError('input refused')
    return v


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
    try:
        channel.settimeout(min(2, remaining()))
        remaining()
        channel.exec_command(PREFIX + v['selector'] + ' --ordinary-export-input -')
        channel.sendall(base64.b64decode(v['input_base64'], validate=True))
        try:
            channel.shutdown_write()
        except (OSError, EOFError):
            pass
        output, discarded = bytearray(), 0
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
        before['_export_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
        return before
    finally:
        channel.close()


def main():
    timer = None
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'export_raw': {'status': 'unavailable', 'stdout_base64': None}}
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
        mode = observation.pop('_export_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'export_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
