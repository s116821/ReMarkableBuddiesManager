"""Bounded ordinary conversation candidate inventory selectors using existing identity-verified wired callbacks."""
import base64
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 256
MAX_RESPONSE = 8192
COMMAND = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --inspect-conversations'


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


def report_shape(r):
    if not isinstance(r, dict):
        raise ValueError('report refused')
    if type(r.get('report_version')) is not int or not 1 <= r['report_version'] <= 9007199254740991:
        raise ValueError('report refused')
    if r['report_version'] != 1:
        return
    exact(r, 'report_version status scope complete candidates candidate_count eligibility_evaluated mutation_authority native_authority runtime_unverified physical_reclamation local_only service_observation')
    if (r['scope'] != 'ordinary-current-root-candidates'
            or r['status'] not in ('complete', 'too-large', 'unsupported', 'busy', 'unavailable', 'conflict')
            or r['runtime_unverified'] is not True or r['local_only'] is not True
            or any(r[k] is not False for k in ('eligibility_evaluated', 'mutation_authority', 'native_authority', 'physical_reclamation'))):
        raise ValueError('report refused')
    if r['status'] != 'complete':
        if r['complete'] is not False or r['candidates'] is not None or r['candidate_count'] is not None or r['service_observation'] != 'unverified':
            raise ValueError('report refused')
        return
    if (r['complete'] is not True or r['service_observation'] != 'inactive'
            or not isinstance(r['candidates'], list) or type(r['candidate_count']) is not int
            or not 0 <= r['candidate_count'] <= 16 or len(r['candidates']) != r['candidate_count']):
        raise ValueError('report refused')
    previous = None
    for candidate in r['candidates']:
        if not uuid(candidate) or previous is not None and previous >= candidate:
            raise ValueError('report refused')
        previous = candidate


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id budget_ms')
    if not digest(v['connection_id']) or not uuid(v['boot_id']) or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000:
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
        channel.exec_command(COMMAND)
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
            report_shape(report)
        status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
        remaining()
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        remaining()
        before['_conversation_inventory_raw'] = {'status': status, 'stdout_base64': base64.b64encode(output).decode('ascii') if report is not None else None}
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
                'conversation_inventory_raw': {'status': 'unavailable', 'stdout_base64': None}}
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
        mode = observation.pop('_conversation_inventory_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'conversation_inventory_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
