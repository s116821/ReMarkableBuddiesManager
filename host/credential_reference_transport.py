"""Bounded saved-credential-reference selectors using existing identity-verified wired callbacks."""
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
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --credential-reference-operation '
SELECTORS = {'inspect', 'prepare', 'apply', 'status'}


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


def change(value):
    if not isinstance(value, dict):
        raise ValueError('input refused')
    if value.get('action') == 'clear':
        exact(value, 'action')
    else:
        exact(value, 'action value')
        if value['action'] != 'set' or not isinstance(value['value'], str) or not re.fullmatch('[A-Za-z0-9_-]{1,80}', value['value']):
            raise ValueError('input refused')


def fields(value):
    exact(value, 'model_credential')
    p = value['model_credential']
    exact(p, 'origin present')
    if p['origin'] not in ('default', 'declared', 'declared-null') or type(p['present']) is not bool or p['present'] != (p['origin'] == 'declared'):
        raise ValueError('report refused')


def intent(value):
    exact(value, 'credential_reference_version operation base_sha256 target_sha256 config_path_sha256 changes_sha256')
    if (type(value['credential_reference_version']) is not int or value['credential_reference_version'] != 1 or not uuid(value['operation'])
            or not all(digest(value[k]) for k in ('base_sha256', 'target_sha256', 'config_path_sha256', 'changes_sha256'))
            or value['base_sha256'] == value['target_sha256']):
        raise ValueError('input refused')


def report_shape(report, selector):
    exact(report, 'report_version operation status outcome disk_readback_verified runtime_activation data')
    if (type(report['report_version']) is not int or report['report_version'] != 1 or report['operation'] != selector
            or report['status'] not in ('ok', 'invalid-input', 'unavailable', 'unsupported', 'busy', 'conflict', 'failed')):
        raise ValueError('report refused')
    data = report['data']
    if report['status'] != 'ok':
        allowed = ('read-only',) if selector in ('inspect', 'status') else ('not-dispatched', 'unknown') if selector == 'apply' and report['status'] == 'failed' else ('not-dispatched',)
        if data is not None or report['outcome'] not in allowed or report['disk_readback_verified'] is not False or report['runtime_activation'] != 'unverified':
            raise ValueError('report refused')
        return
    outcomes = {'inspect': ('read-only',), 'prepare': ('prepared', 'no-change'), 'apply': ('verified',), 'status': ('desired-file-observed', 'unresolved')}
    if (report['outcome'] not in outcomes[selector] or report['disk_readback_verified'] is not (selector == 'apply')
            or report['runtime_activation'] != 'unverified'):
        raise ValueError('report refused')
    if selector == 'status' and report['outcome'] == 'unresolved':
        if data is not None:
            raise ValueError('report refused')
        return
    if selector == 'inspect':
        exact(data, 'schema_version base_sha256 config_path_sha256 current')
        if type(data['schema_version']) is not int or data['schema_version'] != 1 or not all(digest(data[k]) for k in ('base_sha256', 'config_path_sha256')):
            raise ValueError('report refused')
        fields(data['current'])
    elif selector == 'prepare':
        if report['outcome'] == 'no-change':
            exact(data, 'current base_sha256 changes_sha256')
            if not all(digest(data[k]) for k in ('base_sha256', 'changes_sha256')):
                raise ValueError('report refused')
            fields(data['current'])
        else:
            exact(data, 'before after intent')
            fields(data['before'])
            fields(data['after'])
            intent(data['intent'])
    else:
        exact(data, 'current target_sha256' if selector == 'apply' else 'current observed_sha256')
        if not digest(data['target_sha256' if selector == 'apply' else 'observed_sha256']):
            raise ValueError('report refused')
        fields(data['current'])


def request(raw):
    v = parse(raw, MAX_REQUEST)
    if (not isinstance(v, dict) or set(v) != {'connection_id', 'boot_id', 'selector', 'input_base64', 'budget_ms'}
            or not isinstance(v['connection_id'], str) or not re.fullmatch('[a-f0-9]{64}', v['connection_id'])
            or not isinstance(v['boot_id'], str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', v['boot_id'])
            or v['boot_id'] == '00000000-0000-0000-0000-000000000000'):
        raise ValueError('input refused')
    if type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000:
        raise ValueError('input refused')
    if v['selector'] not in SELECTORS:
        raise ValueError('input refused')
    if v['selector'] == 'inspect':
        if v['input_base64'] is not None:
            raise ValueError('input refused')
        return v
    if not isinstance(v['input_base64'], str):
        raise ValueError('input refused')
    body = base64.b64decode(v['input_base64'], validate=True)
    if base64.b64encode(body).decode('ascii') != v['input_base64']:
        raise ValueError('input refused')
    value = parse(body, 16384)
    if v['selector'] == 'prepare':
        exact(value, 'credential_reference_version operation base_sha256 config_path_sha256 change')
        if (type(value['credential_reference_version']) is not int or value['credential_reference_version'] != 1 or not uuid(value['operation'])
                or not digest(value['base_sha256']) or not digest(value['config_path_sha256'])):
            raise ValueError('input refused')
        change(value['change'])
    else:
        exact(value, 'intent change' if v['selector'] == 'apply' else 'intent')
        intent(value['intent'])
        if v['selector'] == 'apply':
            change(value['change'])
            import hashlib
            canonical = json.dumps(value['change'], sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            if hashlib.sha256(b'urn:remarkable-buddies:credential-reference-patch:v1:' + canonical).hexdigest() != value['intent']['changes_sha256']:
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
    output = bytearray()
    try:
        channel.settimeout(min(2, remaining()))
        remaining()
        channel.exec_command(PREFIX + v['selector'] + ('' if v['selector'] == 'inspect' else ' --credential-reference-input -'))
        if v['selector'] != 'inspect':
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
        before['_credential_reference_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
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
                'credential_reference_raw': {'status': 'unavailable', 'stdout_base64': None}}
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
        mode = observation.pop('_credential_reference_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'credential_reference_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
