"""Bounded saved-mode controls using existing identity-verified wired callbacks."""
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
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --sync-mode-operation '
PROVISION = 'provision-isolated-backup'
REQUEST_BUDGET_MS = {'inspect': 12000, 'choose': 12000, PROVISION: 45000}


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


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id selector input_base64 budget_ms')
    selector = v['selector']
    if (not digest(v['connection_id']) or not uuid(v['boot_id'])
            or not isinstance(selector, str) or selector not in REQUEST_BUDGET_MS
            or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= REQUEST_BUDGET_MS[selector]):
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
    remaining()
    before = shared.inspect(transport)
    remaining()
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    selector = v['selector']
    provisioning = selector == PROVISION
    command_deadline = min(deadline, time.monotonic() + 35) if provisioning else None
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
        if provisioning:
            # Paramiko's exec acknowledgment can wait independently of the
            # channel read timeout. Closing the channel also bounds that wait.
            timer = threading.Timer(command_deadline - time.monotonic(), expire_command)
            timer.daemon = True
            timer.start()
        channel.settimeout(min(2, command_remaining()))
        channel.exec_command(PREFIX + selector + ('' if selector == 'inspect' else ' --sync-mode-input -'))
        command_remaining()
        if selector != 'inspect':
            channel.sendall(base64.b64decode(v['input_base64'], validate=True))
        command_remaining()
        try:
            channel.shutdown_write()
        except (OSError, EOFError):
            if provisioning:
                raise
        output, discarded = bytearray(), 0
        if not provisioning:
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
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
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
    report = parse(output, MAX_RESPONSE) if code == 0 and one_line else None
    if report is not None:
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
        mode = observation.pop('_local_mode_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'local_mode_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
