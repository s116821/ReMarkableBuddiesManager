"""Fixed private package boundary. No production binding is enrolled."""
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import time

import resident_package_removal as coordinator
import resident_package_transition as transition
import resident_package_replacement as replacement
from resident_package_recovery import Activation, require
from service_stop_transport import parse, exact, digest, uuid

QUALIFIED_PACKAGE_BINDINGS = ()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')).hexdigest()


def request(raw):
    q = parse(raw, 4096)
    exact(q, 'selector operation connection_id boot_id budget_ms policy_id expected invocation')
    require(q['selector'] in ('review', 'execute', 'observe', 'review-continuation', 'continue'))
    require(q['operation'] in ('disable', 'remove', 'replace') and digest(q['connection_id'])
            and uuid(q['boot_id']) and digest(q['policy_id']) and uuid(q['invocation']))
    require(type(q['budget_ms']) is int and 1 <= q['budget_ms'] <= 12000)
    if q['selector'] == 'review':
        require(q['expected'] is None)
    else:
        exact(q['expected'], 'activation proof_sha256 operation_id')
        require(uuid(q['expected']['activation']) and digest(q['expected']['proof_sha256'])
                and uuid(q['expected']['operation_id']))
    return q


def current(binding, phase='review', outcome='ready'):
    return {'phase': phase, 'outcome': outcome, 'installed_version': binding['installed_version'],
            'candidate_version': binding['replacement']['candidate']['version'] if binding['replacement'] else None,
            'data_preserved': True}


def review(config, q, b, deadline):
    if q['operation'] == 'remove':
        v = coordinator.review(config, b['profile_sha256'], deadline, approved_version=b['installed_version'])
        active, plan = v['activation'], v['removal_plan']
        ownership = plan['ownership']
    else:
        active = transition.review(config, b['profile_sha256'], deadline)['activation']
        ownership = transition.observe_package_ownership(config, b['installed_version'], deadline,
                                                         q['connection_id'])['ownership']
        plan = None
    require(active['boot_id'] == q['boot_id'])
    if q['operation'] == 'replace':
        r = b['replacement']
        require(r is not None)
        candidate = replacement.ApprovedReplacement(**r['candidate'])
        require(replacement.preview(config, q['connection_id'], b['installed_version'], candidate, deadline)
                ['replacement_plan'] == r['plan'])
    return {'activation': active, 'plan': plan, 'ownership': ownership, 'replacement': b['replacement']}


def discover(config, q, b):
    """Finite protected admission, not completion or replay authority."""
    parent = Path(config).parent
    require(transition.checked_root(parent) is not None)
    names = []
    with os.scandir(parent) as entries:
        for item in entries:
            if not item.name.startswith(('resident-stop-', 'resident-disable-', 'resident-remove-', 'resident-replace-')):
                continue
            require(len(names) < 32 and re.fullmatch(r'resident-(?:stop|disable|remove|replace)-[0-9a-f-]{36}-[0-9a-f-]{36}\.json', item.name))
            require(not item.is_symlink() and item.is_file(follow_symlinks=False))
            names.append(item.name)
    admitted = []
    for name in sorted(names):
        raw = transition.shared.private_bytes(parent / name, parent_private=True, maximum=4096)
        record = transition.json_record(raw)
        stop = record if name.startswith('resident-stop-') else record.get('stop')
        require(isinstance(stop, dict))
        # Only original Stop records produce rows. Validate every admitted chain on Check.
        if not name.startswith('resident-stop-'):
            fields = {'version', 'stop', 'stock'} | ({'candidate', 'profile_sha256', 'plan'} if name.startswith('resident-replace-') else set())
            require(set(record) == fields and type(record['version']) is int and record['version'] == 1)
            original = stop['activation']
            expected_name = 'resident-' + name.split('-')[1] + '-' + original['boot_id'] + '-' + original['activation_id'] + '.json'
            require(name == expected_name)
            _, validated, _ = transition.load_intent(config, q['connection_id'], original['boot_id'], original['activation_id'], b['profile_sha256'], b['installed_version'])
            require(validated == stop)
            continue
        if stop.get('connection_id') != q['connection_id']:
            raise ValueError('Foreign retained operation')
        if stop.get('version') != 4:
            # Legacy remains read-only; do not infer a public package goal.
            raise ValueError('Legacy retained operation cannot admit a new goal')
        a = stop['activation']
        _, validated, _ = transition.load_intent(config, q['connection_id'], a['boot_id'], a['activation_id'],
                                                b['profile_sha256'], b['installed_version'])
        require(validated == stop and a['boot_id'] == q['boot_id'])
        require(name == transition.intent_path(config, a['boot_id'], a['activation_id']).name)
        goal = stop['goal']
        require(goal['operation'] == q['operation'] and goal['installed_version'] == b['installed_version'] and goal['replacement'] == b['replacement'])
        require(len(admitted) < 8)
        admitted.append({'operation': goal['operation'], 'boot_id': a['boot_id'],
                         'activation': a['activation_id'], 'proof_sha256': fingerprint(stop), 'operation_id': goal['operation_id']})
    return admitted


def dispatch(q, config, deadline, binding):
    """Only main's immutable policy can reach this function in product builds."""
    b = binding
    require(q['policy_id'] == b['id'] and q['operation'] == b['operation'] and (q['operation'] != 'replace' or b['replacement'] is not None))
    # Verify the approved platform and same USB/boot before reading or mutating a goal.
    observation = transition.on_wire(config, transition.shared.inspect, q['connection_id'])
    require(observation['boot_id'] == q['boot_id'] and not observation['firmware_conflict']
            and all(observation[k] == b[k] for k in ('model', 'architecture', 'firmware')))
    retained = []
    if q['selector'] == 'review':
        retained = discover(config, q, b)
        if retained:
            return observation, {'state': 'unknown', 'current': None, 'context': None, 'retained': retained}
        v = review(config, q, b, deadline)
        return observation, {'state': 'ready', 'current': current(b), 'context': {
            'activation': v['activation']['activation_id'], 'proof_sha256': fingerprint(v), 'operation_id': None}, 'retained': []}
    e = q['expected']
    if q['selector'] == 'execute':
        v = review(config, q, b, deadline)
        require(v['activation']['activation_id'] == e['activation'] and fingerprint(v) == e['proof_sha256']
                and e['operation_id'] == q['invocation'])
        goal = {'operation': q['operation'], 'operation_id': q['invocation'],
                'installed_version': b['installed_version'], 'replacement': b['replacement']}
        v = coordinator.execute_goal(config, q['connection_id'], Activation(**v['activation']), v['plan'],
                                     b['profile_sha256'], deadline, approved_version=b['installed_version'], goal=goal)
    else:
        args = (config, q['connection_id'], q['boot_id'], e['activation'], b['profile_sha256'], deadline)
        _, stop, _ = transition.load_intent(*args[:5], b['installed_version'])
        require(stop['version'] == 4 and stop['goal']['operation'] == q['operation']
                and stop['goal']['replacement'] == b['replacement']
                and stop['goal']['operation_id'] == e['operation_id'])
        if q['selector'] == 'continue':
            v = coordinator.continue_transition(*args, approved_version=b['installed_version'], expected=e['proof_sha256'])
        else:
            v = coordinator.review_continuation(*args, approved_version=b['installed_version'])
    require(time.monotonic() < deadline)
    observation = transition.on_wire(config, transition.shared.inspect, q['connection_id'])
    require(observation['boot_id'] == q['boot_id'])
    return observation, {'state': v['state'], 'current': current(b, v['phase'], v['outcome']),
                         'context': {'activation': e['activation'], 'proof_sha256': fingerprint(v), 'operation_id': e['operation_id']}, 'retained': []}


def main():
    timer = None
    def failure():
        return {'contract_version': 1, 'status': 'unconfigured', 'observation': None,
                'resident_package_raw': {'state': 'unknown', 'current': None, 'context': None, 'retained': []}}
    try:
        q = request(sys.stdin.buffer.read(4097))
        b = next((b for b in QUALIFIED_PACKAGE_BINDINGS if b['id'] == q['policy_id']), None)
        if b is None:
            print(json.dumps(failure()), flush=True)
            return  # Empty policy never opens configuration, a file or SSH.
        deadline = time.monotonic() + q['budget_ms'] / 1000
        def expire():
            os._exit(0)  # Parent retains unknown; kernel releases original intent lease.
        timer = threading.Timer(max(0, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        observation, raw = dispatch(q, os.environ['MANAGER_WIRED_CONFIG'], deadline, b)
        print(json.dumps({'contract_version': 1, 'status': 'observed', 'observation': observation,
                          'resident_package_raw': raw}), flush=True)
    except Exception:
        print(json.dumps(failure()), flush=True)
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
