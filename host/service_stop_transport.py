"""Read-only Stop qualification boundary. No production shutdown tuple is enabled."""
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 4096
MAX_RESPONSE = 16384


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
    def integer(token):
        if not re.fullmatch(r'0|[1-9][0-9]*', token):
            raise ValueError('numeric token refused')
        return int(token)
    def fraction(_):
        raise ValueError('numeric token refused')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_int=integer, parse_float=fraction,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('input refused')))


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError('input refused')


def digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value)


def uuid(value):
    return (isinstance(value, str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value)
            and value != '00000000-0000-0000-0000-000000000000')


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id selector budget_ms expected')
    if (v['selector'] not in ('review', 'stop', 'inspect') or not digest(v['connection_id']) or not uuid(v['boot_id'])
            or type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000):
        raise ValueError('input refused')
    if v['selector'] == 'stop':
        exact(v['expected'], 'profile sample_sha256')
        if v['expected']['profile'] not in ('ordinary-manual', 'resident-installed') or not digest(v['expected']['sample_sha256']):
            raise ValueError('input refused')
    elif v['expected'] is not None:
        raise ValueError('input refused')
    return v


def empty_raw(selector):
    return dict(selector=selector, command='not-submitted', reason='lifecycle-unqualified',
                buddy=None, helper=None, stock=None, process=None, platform=None, artifacts=None,
                recovery_profile_base64=None, lease_base64=None, lease_observation='not-read',
                configuration=dict(read='not-read', effective_mode='unverified'))


def execute(transport, v, deadline=None):
    # The production tuple registry is empty. Reject stop before even read-only
    # channel I/O; an observed hash/lease cannot enroll an arbitrary deployment.
    if v['selector'] == 'stop':
        raise shared.Refusal('observation-unavailable')
    if deadline is None:
        deadline = time.monotonic() + v['budget_ms'] / 1000
    if time.monotonic() >= deadline:
        raise shared.Refusal('timeout')
    before = shared.inspect(transport)
    if time.monotonic() >= deadline:
        raise shared.Refusal('timeout')
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    before['_service_stop_raw'] = empty_raw(v['selector'])
    return before


def main():
    timer = None
    selector = 'inspect'
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'service_stop_raw': empty_raw(selector)}
    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)
    try:
        v = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
        selector = v['selector']
        if selector == 'stop':
            respond(failure('unconfigured'))
            return
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
        mode = observation.pop('_service_stop_raw')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'service_stop_raw': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
