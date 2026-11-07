"""Coordinate one reviewed removal through Manager's private wired transport."""

from dataclasses import asdict
import os

import resident_package_disable as disable
import resident_package_transition as transition
import resident_package_uninstall as uninstall
from resident_package_recovery import PackageRecovery


def review(config, profile_sha256, deadline, *, approved_version):
    """Read the exact installed activation and sole-package solver plan together."""
    def inspect(transport):
        recovery = PackageRecovery(transport, deadline)
        plan = recovery.removal_plan(approved_version)
        active = recovery.capture_activation()
        transition.require_approved(active, profile_sha256)
        transition.require_removal_plan(plan, active.boot_id, approved_version)
        recovery.require_takeover()
        return {"activation": asdict(active), "removal_plan": plan}

    return transition.on_wire(config, inspect)


def execute(config, connection, active, plan, profile_sha256, deadline, *, approved_version):
    """Apply one host-approved review, using a single deadline for all phases."""
    transition.require_removal_plan(plan, active.boot_id, approved_version)
    transition.prepare(config, connection, active, profile_sha256, deadline,
                       approved_version=approved_version, removal=True, expected_plan=plan)
    args = (config, connection, active.boot_id, active.activation_id, profile_sha256, deadline)
    try:
        disable.execute(*args, approved_version=approved_version)
        return uninstall.execute(*args, approved_version=approved_version)
    except transition.RecoveryPending:
        raise
    except Exception as error:
        raise transition.RecoveryPending("Removal stopped after verified stock recovery") from error


def observe(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Reconcile the latest retained phase without resubmitting any command."""
    args = (config, connection, boot, activation, profile_sha256, deadline)
    if os.path.lexists(uninstall.removal_path(config, boot, activation)):
        return {"phase": "removal", **uninstall.observe(*args, approved_version=approved_version)}
    if os.path.lexists(disable.disable_path(config, boot, activation)):
        phase, receipt = "disable", disable.observe(*args, approved_version=approved_version)
    else:
        phase, receipt = "stop", transition.observe(*args, approved_version=approved_version)
    transition.require("removal_plan" in receipt)
    return {"phase": phase, **receipt}


# Public package coordination stays in this existing finite boundary. No caller
# can select a command or skip a predecessor; a continuation advances one phase.
def _replacement(goal):
    import resident_package_replacement as replacement
    r = goal['replacement']
    return replacement, replacement.ApprovedReplacement(**r['candidate']), r


def _paths(config, boot, activation):
    import resident_package_replacement as replacement
    return (disable.disable_path(config, boot, activation),
            uninstall.removal_path(config, boot, activation),
            replacement.replacement_path(config, boot, activation))


def _reconcile(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    """Caller holds original intent lease. A failed proof never means absent."""
    from resident_package_goal import validate_goal
    expected, stop, plan = transition.load_intent(config, connection, boot, activation,
                                                profile_sha256, approved_version)
    transition.require(stop['version'] == 4)
    goal = validate_goal(stop['goal'], stop['ownership'], plan)
    args = (config, connection, boot, activation, profile_sha256, deadline)
    dp, rp, xp = _paths(config, boot, activation)
    d, r, x = (os.path.lexists(p) for p in (dp, rp, xp))
    for path, present in ((dp, d), (rp, r), (xp, x)):
        if not present:
            continue
        record = transition.json_record(transition.shared.private_bytes(path, parent_private=True, maximum=4096))
        fields = {'version', 'stop', 'stock'} | ({'candidate', 'profile_sha256', 'plan'} if path == xp else set())
        transition.require(set(record) == fields and type(record['version']) is int
                           and record['version'] == 1 and record['stop'] == stop)
        if path == xp:
            transition.require(all(record[k] == goal['replacement'][k]
                                   for k in ('candidate', 'profile_sha256', 'plan')))

    transition.require(not (r and x) and (not r or goal['operation'] == 'remove')
                       and (not x or goal['operation'] == 'replace'))
    if r:
        proof = uninstall.observe(*args, approved_version=approved_version)
        return {'state': 'completed', 'phase': 'package', 'outcome': 'removed', 'goal': goal, 'proof': proof}
    if x:
        replacement, candidate, entry = _replacement(goal)
        proof = replacement.observe(*args, approved_version=approved_version, candidate=candidate,
                                    replacement_profile_sha256=entry['profile_sha256'], approved_plan=entry['plan'])
        return {'state': 'completed', 'phase': 'package', 'outcome': 'replaced', 'goal': goal, 'proof': proof}
    if d:
        proof = disable.observe(*args, approved_version=approved_version)
    else:
        proof = transition.observe(*args, approved_version=approved_version)
        # Existing disable helper deliberately emits no record if already disabled.
        def inspect(transport):
            recovery = PackageRecovery(transport, deadline)
            state = recovery.unit_file_state(disable.BUDDY)
            if state == b'disabled\n':
                disable.observe_disabled(recovery, expected, approved_version, stop, plan, proof['recovery'])
                return True
            transition.require(state == b'enabled\n')
            return False
        d = transition.on_wire(config, inspect, connection)
    if goal['operation'] == 'replace':
        replacement, candidate, entry = _replacement(goal)
        transition.require(replacement.preview(config, connection, approved_version, candidate, deadline)
                           ['replacement_plan'] == entry['plan'])
    if d and goal['operation'] == 'disable':
        return {'state': 'completed', 'phase': 'disable', 'outcome': 'disabled', 'goal': goal, 'proof': proof}
    return {'state': 'continuable', 'phase': 'disable' if d else 'recovery',
            'outcome': 'disabled' if d else 'prepared', 'goal': goal, 'proof': proof}


def review_continuation(config, connection, boot, activation, profile_sha256, deadline, *, approved_version):
    from resident_package_goal import retained_lease
    with retained_lease(transition.intent_path(config, boot, activation)):
        return _reconcile(config, connection, boot, activation, profile_sha256, deadline,
                          approved_version=approved_version)


def continue_transition(config, connection, boot, activation, profile_sha256, deadline, *,
                        approved_version, expected):
    """Fresh review and exactly one proven unsubmitted phase, under a native lease."""
    from resident_package_goal import retained_lease
    with retained_lease(transition.intent_path(config, boot, activation)):
        current = _reconcile(config, connection, boot, activation, profile_sha256, deadline,
                             approved_version=approved_version)
        from resident_package_transport import fingerprint
        transition.require(fingerprint(current) == expected and current['state'] == 'continuable')
        args = (config, connection, boot, activation, profile_sha256, deadline)
        if current['outcome'] == 'prepared':
            disable.execute(*args, approved_version=approved_version)
        elif current['goal']['operation'] == 'remove':
            uninstall.execute(*args, approved_version=approved_version)
        else:
            replacement, candidate, entry = _replacement(current['goal'])
            replacement.execute(*args, approved_version=approved_version, candidate=candidate,
                                replacement_profile_sha256=entry['profile_sha256'], approved_plan=entry['plan'])
        return _reconcile(config, connection, boot, activation, profile_sha256, deadline,
                          approved_version=approved_version)


def execute_goal(config, connection, active, plan, profile_sha256, deadline, *, approved_version, goal):
    """Initial sequence only; a retained Stop can enter solely through continuation."""
    from resident_package_goal import initial_lease, validate_goal
    ownership = plan['ownership'] if plan is not None else None
    if ownership is None:
        ownership = transition.observe_package_ownership(config, approved_version, deadline, connection)['ownership']
    validate_goal(goal, ownership, plan)
    with initial_lease():
        transition.prepare(config, connection, active, profile_sha256, deadline, approved_version=approved_version,
                           removal=goal['operation'] == 'remove', expected_plan=plan, goal=goal)
        args = (config, connection, active.boot_id, active.activation_id, profile_sha256, deadline)
        disable.execute(*args, approved_version=approved_version)
        if goal['operation'] == 'remove':
            uninstall.execute(*args, approved_version=approved_version)
        elif goal['operation'] == 'replace':
            replacement, candidate, entry = _replacement(goal)
            replacement.execute(*args, approved_version=approved_version, candidate=candidate,
                                replacement_profile_sha256=entry['profile_sha256'], approved_plan=entry['plan'])
        return _reconcile(config, connection, active.boot_id, active.activation_id, profile_sha256,
                          deadline, approved_version=approved_version)
