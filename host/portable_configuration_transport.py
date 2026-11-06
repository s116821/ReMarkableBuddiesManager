"""Fixed bounded portable preference callbacks; no artifact spool or Config writer."""
import base64
import hashlib
import json
import os
import sys
import threading
import time
import wired_observer as shared
from ordinary_export_transport import parse, exact, digest, uuid

MAX_REQUEST = 360448
CONFIG = '/home/root/.config/remarkable-buddies/config.json'
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=' + CONFIG + ' /opt/bin/reader-buddy --portable-configuration-operation '
EXPORT = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin /opt/bin/reader-buddy --export-portable-configuration ' + CONFIG
SELECTORS = {'export', 'inspect', 'prepare', 'apply', 'status'}
NAMES = {'product_settings', 'personalization', 'research_policy'}
PATH_HASH = hashlib.sha256(b'remarkable-buddies-portable-import-path-v1\0' + CONFIG.encode()).hexdigest()


def artifact(v):
    exact(v, 'portable_configuration_version settings')
    if type(v['portable_configuration_version']) is not int or v['portable_configuration_version'] != 1 or type(v['settings']) is not dict or not set(v['settings']) <= NAMES:
        raise ValueError('input refused')
    for name, value in v['settings'].items():
        if name == 'research_policy':
            if value not in (None, 'required', 'disabled'):
                raise ValueError('input refused')
            continue
        if value is None and name == 'product_settings':
            continue
        allowed = {'schema_version', 'reader_enabled', 'writer_enabled', 'export_destination'} if name == 'product_settings' else {'schema_version', 'enabled', 'text'}
        if type(value) is not dict or not set(value) <= allowed:
            raise ValueError('input refused')
        for key, field in value.items():
            if key == 'schema_version':
                valid = type(field) is int and field == 1
            elif key in ('reader_enabled', 'writer_enabled', 'enabled'):
                valid = type(field) is bool
            elif key == 'export_destination':
                valid = field in ('mem', 'disabled')
            else:
                valid = isinstance(field, str) and '\0' not in field and len(field.encode('utf-8')) <= 16384
            if not valid:
                raise ValueError('input refused')
    compact = json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if len(compact) > 131072:
        raise ValueError('input refused')


def intent(v):
    exact(v, 'portable_import_version operation base_sha256 target_sha256 config_path_sha256 artifact_sha256')
    if type(v['portable_import_version']) is not int or v['portable_import_version'] != 1 or not uuid(v['operation']) or not all(digest(v[k]) for k in ('base_sha256', 'target_sha256', 'config_path_sha256', 'artifact_sha256')) or v['base_sha256'] == v['target_sha256'] or v['config_path_sha256'] != PATH_HASH:
        raise ValueError('input refused')


def report_shape(v, selector):
    exact(v, 'report_version operation status runtime_activation artifact summary' if selector == 'export' else 'report_version operation status outcome disk_readback_verified runtime_activation data')
    if type(v['report_version']) is not int or v['report_version'] != 1 or v['operation'] != selector or v['runtime_activation'] != 'unverified' or v['status'] not in ('ok', 'invalid-input', 'unsupported', 'unavailable', 'busy', 'conflict', 'failed'):
        raise ValueError('report refused')
    if selector == 'export' and v['status'] == 'ok':
        artifact(v['artifact'])
        exact(v['summary'], 'artifact_sha256 declared_settings personalization_included')
        if not digest(v['summary']['artifact_sha256']) or type(v['summary']['declared_settings']) is not int or type(v['summary']['personalization_included']) is not bool:
            raise ValueError('report refused')
    elif selector != 'export' and type(v['disk_readback_verified']) is not bool:
        raise ValueError('report refused')


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id selector input_base64 budget_ms')
    if not digest(v['connection_id']) or not uuid(v['boot_id']) or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000 or v['selector'] not in SELECTORS:
        raise ValueError('input refused')
    if v['selector'] in ('export', 'inspect'):
        if v['input_base64'] is not None:
            raise ValueError('input refused')
        return v
    if not isinstance(v['input_base64'], str):
        raise ValueError('input refused')
    body = base64.b64decode(v['input_base64'], validate=True)
    if base64.b64encode(body).decode('ascii') != v['input_base64']:
        raise ValueError('input refused')
    value = parse(body, 262144)
    if v['selector'] == 'prepare':
        exact(value, 'portable_import_version operation base_sha256 config_path_sha256 artifact')
        if type(value['portable_import_version']) is not int or value['portable_import_version'] != 1 or not uuid(value['operation']) or not digest(value['base_sha256']) or value['config_path_sha256'] != PATH_HASH:
            raise ValueError('input refused')
        artifact(value['artifact'])
    else:
        exact(value, 'intent artifact' if v['selector'] == 'apply' else 'intent')
        intent(value['intent'])
        if v['selector'] == 'apply':
            artifact(value['artifact'])
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
        selector = v['selector']
        command = EXPORT if selector == 'export' else PREFIX + selector + ('' if selector == 'inspect' else ' --portable-configuration-input -')
        channel.exec_command(command)
        if v['input_base64'] is not None:
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
                if len(output) > (131072 if v['selector'] == 'export' else 16384):
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
        report = parse(output, 131072 if v['selector'] == 'export' else 16384) if code == 0 and one_line else None
        if report is not None:
            report_shape(report, v['selector'])
        status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
        remaining()
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        remaining()
        before['_portable_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
        return before
    finally:
        channel.close()


def main():
    timer = None
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'portable_configuration_raw': {'status': 'unavailable', 'stdout_base64': None}}
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
        mode = observation.pop('_portable_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'portable_configuration_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
