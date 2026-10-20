"""Bounded prepared-forget selectors using existing identity-verified wired callbacks."""
import base64
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 360448
MAX_RESPONSE = 262144
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --memory-operation '
SELECTORS = {'prepare-forget', 'forget', 'forget-receipt'}


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


def key(value):
    exact(value, 'profile scope fact')
    exact(value['scope'], 'kind')
    if value['scope']['kind'] != 'global':
        raise ValueError('input refused')


def intent(value):
    exact(value, 'prepared_version operation key expected binding')
    key(value['key'])
    if not isinstance(value['expected'], list) or len(value['expected']) != 1:
        raise ValueError('input refused')
    for entry in value['expected']:
        exact(entry, 'revision sha256')
    b = value['binding']
    exact(b, 'config_sha256 mode actor store_generation domain')
    exact(b['mode'], 'actor sha256')
    d = b['domain']
    if d.get('kind') == 'local':
        exact(d, 'kind')
    else:
        exact(d, 'kind identity pins')
        if d['kind'] != 'selected' or not isinstance(d['pins'], list) or not 1 <= len(d['pins']) <= 65:
            raise ValueError('input refused')
        exact(d['identity'], 'group profile binding_sha256')
        for pin in d['pins']:
            exact(pin, 'scope store_generation aggregate_generation accepted_base_sha256 selection_sha256 head_sha256')
            exact(pin['scope'], 'group key_sha256 binding_sha256')


def report_shape(report, selector):
    exact(report, 'report_version operation status incomplete data')
    data = report['data']
    if data is None:
        return
    if selector == 'prepare-forget':
        exact(data, 'schema_version preview intent')
        intent(data['intent'])
        e = data['preview']
        exact(e, 'envelope_version namespace domain_schema_version record_id revision_id parents operation_id actor_id kind payload media_descriptors')
        fact = e['payload']
        exact(fact, 'key claim value subject tags provenance confidence_basis_points observed_ms expires_ms')
        key(fact['key'])
        exact(fact['provenance'], 'basis description conversation turn source')
    elif data.get('outcome') == 'acknowledged':
        exact(data, 'schema_version outcome operation transaction')
    else:
        exact(data, 'schema_version outcome')


def request(raw):
    v = parse(raw, MAX_REQUEST)
    if (not isinstance(v, dict) or set(v) != {'connection_id', 'boot_id', 'selector', 'input_base64'}
            or not isinstance(v['connection_id'], str) or not re.fullmatch('[a-f0-9]{64}', v['connection_id'])
            or not isinstance(v['boot_id'], str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', v['boot_id'])
            or v['boot_id'] == '00000000-0000-0000-0000-000000000000'):
        raise ValueError('input refused')
    if v['selector'] not in SELECTORS or not isinstance(v['input_base64'], str):
        raise ValueError('input refused')
    body = base64.b64decode(v['input_base64'], validate=True)
    value = parse(body, 131072)
    if not isinstance(value, dict):
        raise ValueError('input refused')
    if v['selector'] == 'prepare-forget':
        exact(value, 'prepared_version operation key')
        key(value['key'])
    else:
        exact(value, 'intent')
        intent(value['intent'])
    return v


def execute(transport, v):
    before = shared.inspect(transport)
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    channel = transport.open_session(timeout=2)
    try:
        channel.settimeout(2)
        channel.exec_command(PREFIX + v['selector'] + ' --memory-input -')
        channel.sendall(base64.b64decode(v['input_base64'], validate=True))
        try:
            channel.shutdown_write()
        except (OSError, EOFError):
            pass
        output, discarded = bytearray(), 0
        deadline = time.monotonic() + 8
        while True:
            if time.monotonic() > deadline:
                raise shared.Refusal('timeout')
            while channel.recv_ready():
                output.extend(channel.recv(4096))
                if len(output) > MAX_RESPONSE:
                    raise ValueError('oversized response')
            while channel.recv_stderr_ready():
                discarded += len(channel.recv_stderr(4096))
                if discarded > 16384:
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
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        before['_forget_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
        return before
    finally:
        channel.close()


def main():
    timer = None
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'forget_raw': {'status': 'unavailable', 'stdout_base64': None}}
    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)
    try:
        v = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
        if sys.platform not in ('linux', 'win32'):
            raise shared.Refusal('unsupported-host')
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise shared.Refusal('unconfigured')
        def expire():
            respond(failure('timeout'))
            os._exit(0)
        timer = threading.Timer(12, expire)
        timer.daemon = True
        timer.start()
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = windows_wired.observe(config, shared, inspection=lambda t: execute(t, v), expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=lambda t: execute(t, v), expected_connection=v['connection_id'])
        mode = observation.pop('_forget_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'forget_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
