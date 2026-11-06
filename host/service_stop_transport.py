"""Read-only Stop qualification boundary. No production shutdown tuple is enabled."""
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared
from service_stop_sampler import Sampler, run_fixed, TypedHookRefusal

MAX_REQUEST = 4096
# Source/release gate only, never device metadata or a caller-controlled flag.
# Enablement requires reviewed same-release host tuples and actual qualification.
QUALIFIED_PROFILES = ()
STOP_COMMAND = '/bin/systemctl --system --no-pager --no-ask-password --no-block --job-mode=fail stop -- reader-buddy.service'


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


def empty_raw(selector,reason='lifecycle-unqualified'):
    return dict(selector=selector, command='not-submitted', reason=reason,
                buddy=None, helper=None, stock=None, process=None, platform=None, artifacts=None,
                recovery_profile_base64=None, lease_base64=None, lease_observation='not-read',
                configuration=dict(read='not-read', effective_mode='unverified'),
                companion=None,companion_group=None,vendor_policy=None)


def execute(transport, v, deadline=None, on_submission=lambda:None):
    if v['selector'] == 'stop' and v['expected']['profile'] not in QUALIFIED_PROFILES:
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
    raw=empty_raw(v['selector'],None if v['selector']=='inspect' else 'lifecycle-unqualified')
    # Current OS inspection stays independent of lifecycle admission and must
    # remain useful after Buddy is inactive or an earlier stop is unknown.
    if QUALIFIED_PROFILES and v['selector']!='inspect':
        sampler=Sampler(transport,deadline)
        observed=dict(before,connection_id=v['connection_id'])
        profiles=[v['expected']['profile']] if v['selector']=='stop' else QUALIFIED_PROFILES
        found=False
        for profile in profiles:
            try:
                facts,digest=sampler.bracket(profile,observed,empty_raw)
                found=True
                break
            except TypedHookRefusal:
                raise
            except Exception:
                if v['selector']=='stop':raise
        if not found:raise shared.Refusal('observation-unavailable')
        raw=dict(facts,selector=v['selector'])
        if v['selector']=='stop':
            if digest!=v['expected']['sample_sha256']:
                raise shared.Refusal('observation-unavailable')
            if time.monotonic()>=deadline:raise shared.Refusal('timeout')
            on_submission()  # Original uncertainty starts before the fixed send.
            raw['command']='unknown';raw['reason']='unavailable'
            code,out,err=run_fixed(transport,STOP_COMMAND,deadline,1024)
            if code==0 and not out and not err:
                raw['command']='request-accepted';raw['reason']=None
        after=shared.inspect(transport)
        if after['boot_id']!=before['boot_id'] or time.monotonic()>=deadline:
            raise shared.Refusal('cable-lost')
        before=after
    before['_service_stop_raw'] = raw
    return before


def main():
    timer = None
    selector = 'inspect'
    possible = False
    lock, responded = threading.Lock(), False
    def failure(status):
        raw=empty_raw(selector)
        if possible:raw.update(command='unknown',reason='unavailable')
        return {'contract_version': 1, 'status': status, 'observation': None,
                'service_stop_raw': raw}
    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)
    try:
        v = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
        selector = v['selector']
        if selector == 'stop' and v['expected']['profile'] not in QUALIFIED_PROFILES:
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
        def submitted():
            nonlocal possible
            possible=True
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = windows_wired.observe(config, shared, inspection=lambda t: execute(t, v, deadline, submitted), expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=lambda t: execute(t, v, deadline, submitted), expected_connection=v['connection_id'])
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
