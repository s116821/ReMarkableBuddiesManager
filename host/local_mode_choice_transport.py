"""Bounded saved-mode controls using existing identity-verified wired callbacks."""
import base64
import hashlib
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 24576
MAX_RESPONSE = 16384
MAX_DRIVE_INPUT = 68 * 1024
MAX_DRIVE_CREDENTIAL = 48 * 1024
MAX_DRIVE_REQUEST = ((MAX_DRIVE_INPUT + 2) // 3) * 4 + 512
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --sync-mode-operation '
PROVISION = 'provision-isolated-backup'
DRIVE = 'drive-credential'
REQUEST_BUDGET_MS = {'inspect': 12000, 'choose': 12000, PROVISION: 45000, DRIVE: 12000}
DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
DRIVE_REFUSALS = ('invalid-input', 'unsupported', 'busy', 'conflict', 'unavailable')
DRIVE_EVIDENCE = {'inspect': ('observed',), 'apply': ('verified',),
                  'readback': ('desired-state-observed', 'original-state-observed')}


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


def original(value, selector):
    if selector == PROVISION:
        exact(value, 'control_version operation expected')
        if type(value['control_version']) is not int or value['control_version'] != 1:
            raise ValueError('input refused')
    else:
        exact(value, 'operation expected choice')
        exact(value['choice'], 'kind')
        if value['choice']['kind'] != 'local-only':
            raise ValueError('input refused')
    exact(value['expected'], 'actor sha256')
    if (not uuid(value['operation']) or not uuid(value['expected']['actor'])
            or not digest(value['expected']['sha256'])):
        raise ValueError('input refused')


def report_shape(report, selector):
    exact(report, 'report_version operation status incomplete activation_performed data')
    if (type(report['report_version']) is not int or report['report_version'] != 1
            or report['operation'] != selector or type(report['incomplete']) is not bool
            or report['activation_performed'] is not False
            or report['status'] not in ('ok', 'invalid-input', 'unsupported', 'unavailable', 'busy', 'conflict', 'failed')):
        raise ValueError('report refused')


def drive_check(valid):
    if not valid:
        raise ValueError('Drive credential control refused')


def decode_base64(encoded, limit):
    drive_check(isinstance(encoded, str) and len(encoded) <= ((limit + 2) // 3) * 4)
    body = base64.b64decode(encoded, validate=True)
    drive_check(len(body) <= limit and base64.b64encode(body).decode('ascii') == encoded)
    return body


def drive_token(token):
    exact(token, 'actor sha256')
    drive_check(uuid(token['actor']) and digest(token['sha256']))


def drive_slot(slot, metadata=False):
    if isinstance(slot, dict) and slot.get('kind') == 'absent':
        exact(slot, 'kind')
        return
    exact(slot, 'kind sha256 binding_sha256 collection' + (' metadata_sha256' if metadata else ''))
    drive_check(slot['kind'] == 'present' and digest(slot['sha256']) and digest(slot['binding_sha256'])
                and uuid(slot['collection']) and (not metadata or digest(slot['metadata_sha256'])))


def drive_original(value):
    exact(value, 'config_sha256 credential_path_sha256 parent_identity_sha256 device epoch mode mode_token slot')
    drive_check(all(digest(value[key]) for key in ('config_sha256', 'credential_path_sha256', 'parent_identity_sha256'))
                and uuid(value['device']) and uuid(value['epoch']))
    drive_token(value['mode_token'])
    slot, mode = value['slot'], value['mode']
    drive_slot(slot, metadata=True)
    if isinstance(mode, dict) and mode.get('kind') == 'local-only':
        exact(mode, 'kind')
        return
    exact(mode, 'kind backup binding_sha256')
    drive_check(mode['kind'] == 'isolated-backup' and uuid(mode['backup']) and digest(mode['binding_sha256'])
                and (slot['kind'] == 'absent' or slot['binding_sha256'] == mode['binding_sha256']))


def drive_same_binding(original_value, value):
    mode, slot = original_value['mode'], original_value['slot']
    binding = value['binding_sha256']
    drive_check(digest(binding) and uuid(value['collection'])
                and (mode['kind'] == 'local-only' or mode['binding_sha256'] == binding)
                and (slot['kind'] == 'absent' or
                     (slot['binding_sha256'] == binding and slot['collection'] == value['collection'])))


def drive_matches(slot, desired):
    return all(slot.get(key) == value for key, value in desired.items())


def drive_credential_digest(change):
    raw = decode_base64(change['credential_b64'], MAX_DRIVE_CREDENTIAL)
    value = parse(raw, MAX_DRIVE_CREDENTIAL)
    fields = 'credential_version client_id access_token refresh_token expires_at scopes account_permission_id collection'
    exact(value, fields + (' client_secret' if isinstance(value, dict) and 'client_secret' in value else ''))
    expires_at = value['expires_at']
    now = int(time.time())
    drive_check(type(value['credential_version']) is int and value['credential_version'] == 1
                and type(expires_at) is int and now < expires_at <= now + 86400
                and value['scopes'] == [DRIVE_SCOPE] and value['collection'] == change['collection'])
    for key, limit in (('client_id', 256), ('account_permission_id', 200), ('access_token', 16384),
                       ('refresh_token', 16384), ('client_secret', 1024)):
        text = value.get(key)
        if key == 'client_secret' and text is None:
            continue
        drive_check(isinstance(text, str) and 0 < len(text) <= limit and re.fullmatch(r'[\x21-\x7e]+', text))
    binding = json.dumps([value['client_id'], value['account_permission_id'], value['collection']],
                         separators=(',', ':')).encode('ascii')
    drive_check(hashlib.sha256(binding).hexdigest() == change['binding_sha256'])
    return hashlib.sha256(raw).hexdigest()


def drive_request(body):
    value = parse(body, MAX_DRIVE_INPUT)
    action = value.get('action') if isinstance(value, dict) else None
    if action == 'inspect':
        exact(value, 'action control_version expected_mode')
        drive_token(value['expected_mode'])
        expected = {'action': action, 'operation': None, 'expected_mode': value['expected_mode']}
    else:
        drive_check(action in ('apply', 'readback'))
        exact(value, 'action control_version operation original ' + ('change' if action == 'apply' else 'desired'))
        drive_check(uuid(value['operation']))
        original_value = value['original']
        drive_original(original_value)
        slot = original_value['slot']
        if action == 'apply':
            change = value['change']
            kind = change.get('kind') if isinstance(change, dict) else None
            drive_check(kind in ('create', 'replace', 'remove') and (kind == 'create') == (slot['kind'] == 'absent'))
            exact(change, 'kind collection binding_sha256' + ('' if kind == 'remove' else ' credential_b64'))
            drive_same_binding(original_value, change)
            desired = {'kind': 'absent'} if kind == 'remove' else {
                'kind': 'present', 'collection': change['collection'], 'binding_sha256': change['binding_sha256'],
                'sha256': drive_credential_digest(change)}
        else:
            desired = value['desired']
            drive_slot(desired)
            if desired['kind'] == 'present':
                drive_same_binding(original_value, desired)
        drive_check(not drive_matches(slot, desired))
        expected = {'action': action, 'operation': value['operation'], 'original': original_value, 'desired': desired}
    drive_check(type(value['control_version']) is int and value['control_version'] == 1)
    return expected


def drive_report(report, expected):
    exact(report, 'report_version action operation outcome current disk_readback_verified')
    drive_check(type(report['report_version']) is int and report['report_version'] == 1)
    action, outcome, current = report['action'], report['outcome'], report['current']
    if action is None:
        drive_check(report['operation'] is None and outcome in ('invalid-input', 'unsupported')
                    and current is None and report['disk_readback_verified'] is False)
        return
    drive_check(action == expected['action'] and report['operation'] == expected['operation'])
    if (outcome in DRIVE_REFUSALS or (action == 'apply' and outcome == 'outcome-unknown')
            or (action == 'readback' and outcome == 'unresolved')):
        drive_check(current is None and report['disk_readback_verified'] is False)
        return
    drive_check(outcome in DRIVE_EVIDENCE[action] and report['disk_readback_verified'] is True)
    drive_original(current)
    if action == 'inspect':
        drive_check(current['mode_token'] == expected['expected_mode'])
    else:
        original_value = expected['original']
        drive_check(all(value == original_value[key] for key, value in current.items() if key != 'slot'))
        if outcome == 'original-state-observed':
            drive_check(current['slot'] == original_value['slot'])
        else:
            drive_check(drive_matches(current['slot'], expected['desired']))


def request(raw):
    v = parse(raw, MAX_DRIVE_REQUEST)
    exact(v, 'connection_id boot_id selector input_base64 budget_ms')
    selector = v['selector']
    if (not digest(v['connection_id']) or not uuid(v['boot_id'])
            or not isinstance(selector, str) or selector not in REQUEST_BUDGET_MS
            or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= REQUEST_BUDGET_MS[selector]):
        raise ValueError('input refused')
    if selector == DRIVE:
        drive_request(decode_base64(v['input_base64'], MAX_DRIVE_INPUT))
        return v
    if len(raw) > MAX_REQUEST:
        raise ValueError('input refused')
    if selector == 'inspect':
        if v['input_base64'] is not None:
            raise ValueError('input refused')
    else:
        if not isinstance(v['input_base64'], str):
            raise ValueError('input refused')
        body = base64.b64decode(v['input_base64'], validate=True)
        if base64.b64encode(body).decode('ascii') != v['input_base64']:
            raise ValueError('input refused')
        original(parse(body, 16384), selector)
    return v


def execute(transport, v, deadline=None):
    if deadline is None:
        deadline = time.monotonic() + v['budget_ms'] / 1000
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise shared.Refusal('timeout')
        return value
    selector = v['selector']
    drive = selector == DRIVE
    if drive:
        body = decode_base64(v['input_base64'], MAX_DRIVE_INPUT)
        expected = drive_request(body)
    remaining()
    before = shared.inspect(transport)
    remaining()
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    provisioning = selector == PROVISION
    bounded_ack = provisioning or drive
    command_deadline = min(deadline, time.monotonic() + (35 if provisioning else 8)) if bounded_ack else None
    channel = transport.open_session(timeout=min(2, remaining()))
    timed_out = threading.Event()
    timer = None
    def command_remaining():
        if timed_out.is_set() or (command_deadline is not None and time.monotonic() >= command_deadline):
            raise shared.Refusal('timeout')
        return remaining()
    def expire_command():
        timed_out.set()
        try:
            channel.close()
        except Exception:
            pass
    try:
        if bounded_ack:
            # Paramiko's exec acknowledgment can wait independently of the
            # channel read timeout. Closing the channel also bounds that wait.
            timer = threading.Timer(command_deadline - time.monotonic(), expire_command)
            timer.daemon = True
            timer.start()
        channel.settimeout(min(2, command_remaining()))
        channel.exec_command(PREFIX + selector + ('' if selector == 'inspect' else ' --sync-mode-input -'))
        command_remaining()
        if selector != 'inspect':
            channel.sendall(body if drive else base64.b64decode(v['input_base64'], validate=True))
        command_remaining()
        try:
            channel.shutdown_write()
        except (OSError, EOFError):
            if bounded_ack:
                raise
        output, discarded = bytearray(), 0
        if not bounded_ack:
            command_deadline = min(deadline, time.monotonic() + 8)
        while True:
            command_remaining()
            while channel.recv_ready():
                command_remaining()
                output.extend(channel.recv(4096))
                if len(output) > MAX_RESPONSE:
                    raise ValueError('oversized response')
            while channel.recv_stderr_ready():
                command_remaining()
                discarded += len(channel.recv_stderr(4096))
                if discarded > 8192:
                    raise ValueError('oversized diagnostics')
            if drive and channel.closed and not channel.eof_received:
                raise ValueError('Drive credential response EOF missing')
            if ((not drive or channel.eof_received) and channel.exit_status_ready()
                    and not channel.recv_ready() and not channel.recv_stderr_ready()):
                break
            time.sleep(.01)
        code = channel.recv_exit_status()
        command_remaining()
    finally:
        if timer:
            timer.cancel()
        try:
            if not timed_out.is_set():
                channel.close()
        finally:
            if timed_out.is_set():
                raise shared.Refusal('timeout')
    one_line = output.endswith(b'\n') and output.count(b'\n') == 1
    report = parse(output, MAX_RESPONSE) if code == 0 and one_line and (not drive or not discarded) else None
    if report is not None:
        if drive:
            drive_report(report, expected)
        else:
            report_shape(report, selector)
    status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
    remaining()
    if shared.inspect(transport) != before:
        raise shared.Refusal('cable-lost')
    remaining()
    before['_local_mode_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
    return before


def main():
    timer = None
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'local_mode_raw': {'status': 'unavailable', 'stdout_base64': None}}
    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)
    try:
        v = request(sys.stdin.buffer.read(MAX_DRIVE_REQUEST + 1))
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
        mode = observation.pop('_local_mode_raw')
        result = {'contract_version': 1, 'status': 'observed', 'observation': observation, 'local_mode_raw': mode}
        if v['selector'] == DRIVE and len(json.dumps(result).encode('ascii')) + 1 > MAX_REQUEST:
            raise ValueError('Drive credential response too large')
        respond(result)
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
