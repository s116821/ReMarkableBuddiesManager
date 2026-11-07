"""Typed sampler integration through owned injected replies; no client/device I/O."""
import copy
import json
import shlex
import time
import unittest
from unittest.mock import Mock, patch

from test_sampler import Files, s, t


def method(command):
    if 'DBUS_SYSTEM_BUS_ADDRESS=' not in command:
        return None
    args = shlex.split(shlex.split(command)[-1])
    return args[args.index('call') + 4]


class TypedHooks(unittest.TestCase):
    def test_original_brackets_have_finite_counts_and_fresh_all_slot_hooks(self):
        for profile, maximum, counts in (
            ('ordinary-manual', 18, {s.BUDDY: 4}),
            ('resident-installed', 40, {s.BUDDY: 4, s.HELPER: 2, s.STOCK: 2, s.COMPANION: 4}),
        ):
            f = Files(profile)
            sampler = f.sampler()
            raw, _ = sampler.bracket(profile, f.vector['observation'], t.empty_raw)
            typed = [c for c in f.commands if method(c) or 'CAPCLIENT1' in c]
            self.assertEqual(len(typed), maximum)
            self.assertIsNone(sampler._hooks)
            for unit, count in counts.items():
                for prop in s.hooks.PROPERTIES:
                    calls = [c for c in typed if method(c) == 'Get'
                             and s.UNIT_OBJECTS[unit] in c and c.endswith(prop + "'")]
                    self.assertEqual(len(calls), count, (unit, prop))
            for command in f.commands:
                if command.startswith('/bin/systemctl '):
                    self.assertNotIn('--property=ExecStop', command)
            self.assertEqual(raw['buddy']['hooks']['ExecStop']['reason'], 'typed-empty')

    def test_nonempty_in_every_required_slot_and_property_refuses(self):
        for name in ('buddy', 'helper', 'stock', 'companion'):
            for prop in s.hooks.PROPERTIES:
                f = Files('resident-installed')
                f.raw[name]['hooks'][prop].update(observation='observed-nonempty', reason='typed-nonempty')
                sampler = f.sampler()
                with self.assertRaisesRegex(s.TypedHookRefusal, '^typed hook observation refused$'):
                    sampler.bracket(f.profile, f.vector['observation'], t.empty_raw)
                self.assertIsNone(sampler._hooks)
                self.assertFalse(any(c == t.STOP_COMMAND for c in f.commands))

    def test_other_text_remains_strict_after_valid_typed_context(self):
        for fault in ('missing', 'duplicate', 'unknown'):
            f = Files()
            original = f.run
            def run(*args):
                reply = original(*args)
                if args[1].startswith('/bin/systemctl '):
                    code, out, err = reply
                    if fault == 'missing':
                        out = out.replace(b'User=root\n', b'')
                    elif fault == 'duplicate':
                        out += b'User=root\n'
                    else:
                        out += b'PRIVATE_UNKNOWN=PRIVATE_VALUE\n'
                    return code, out, err
                return reply
            sampler = s.Sampler(Mock(), time.monotonic()+12, run=run)
            with self.assertRaises(ValueError) as error:
                sampler.service(s.BUDDY)
            self.assertNotIsInstance(error.exception, s.TypedHookRefusal)
            self.assertFalse(any(method(c) == 'Get' for c in f.commands))
            self.assertIsNone(sampler._hooks)

    def test_complete_hook_validation_and_stream_failure_are_fatal(self):
        good = ['PRIVATE_COMMAND_CANARY', ['PRIVATE_ARGUMENT_CANARY'], False, 0, 0, 0, 0, 0, 0, 0]
        bad = copy.deepcopy(good)
        bad[-1] = 2**31
        wrapper = lambda commands: json.dumps({'type': 'v', 'data': [{'type': s.hooks.SIGNATURE, 'data': commands}]}).encode()
        for reply in ((0, wrapper([good, bad]), b''), (1, wrapper([]), b''),
                      (0, wrapper([]), b'PRIVATE_ERROR_CANARY'), (0, b'{}', b''),
                      (0, b'x' * 32769, b''), (0, wrapper([]), b'x' * 8193)):
            f = Files()
            original = f.run
            calls = []
            def run(*args):
                calls.append(args[1])
                return reply if method(args[1]) == 'Get' else original(*args)
            sampler = s.Sampler(Mock(), time.monotonic()+12, run=run)
            with self.assertRaises(s.TypedHookRefusal) as error:
                sampler.service(s.BUDDY)
            self.assertNotIn('PRIVATE', str(error.exception))
            self.assertEqual(method(calls[-1]), 'Get')
            self.assertIsNone(sampler._hooks)

    def test_closing_context_and_client_drift_refuse(self):
        for target in ('GetId', 'GetNameOwner', 'GetConnectionUnixProcessID', 'GetUnit', 'client'):
            f = Files()
            original = f.run
            counts = {}
            def run(*args):
                command = args[1]
                key = 'client' if 'CAPCLIENT1' in command else method(command)
                counts[key] = counts.get(key, 0)+1
                reply = original(*args)
                if key == target and counts[key] == 2:
                    if target == 'client':
                        return reply[0], reply[1].replace(b'71172 1 1 1', b'71172 1 2 1'), reply[2]
                    value = {'GetId': ('s', 'b'*32), 'GetNameOwner': ('s', ':1.1'),
                             'GetConnectionUnixProcessID': ('u', 2), 'GetUnit': ('o', '/wrong')}[target]
                    return 0, json.dumps({'type': value[0], 'data': [value[1]]}).encode(), b''
                return reply
            sampler = s.Sampler(Mock(), time.monotonic()+12, run=run)
            with self.assertRaises(s.TypedHookRefusal):
                sampler.service(s.BUDDY)
            self.assertIsNone(sampler._hooks)

    def test_deadline_expiry_does_not_issue_another_query(self):
        f = Files()
        original = f.run
        calls = []
        deadline = time.monotonic()+12
        def run(*args):
            self.assertEqual(args[2], deadline)
            calls.append(args[1])
            reply = original(*args)
            if method(args[1]) == 'Get':
                sampler.deadline = time.monotonic()-1
            return reply
        sampler = s.Sampler(Mock(), deadline, run=run)
        with self.assertRaises(s.TypedHookRefusal):
            sampler.service(s.BUDDY)
        self.assertEqual(sum(method(c) == 'Get' for c in calls), 1)
        self.assertIsNone(sampler._hooks)

    def test_uncertainty_escapes_the_actual_two_candidate_loop(self):
        f = Files()
        original = f.run
        def run(*args):
            if method(args[1]) == 'GetId':
                raise TimeoutError('PRIVATE_TRANSPORT_CANARY')
            return original(*args)
        sampler = s.Sampler(Mock(), time.monotonic()+12, run=run)
        sampler.bracket = Mock(wraps=sampler.bracket)
        q = dict(selector='review', budget_ms=12000, expected=None,
                 boot_id=f.vector['observation']['boot_id'], connection_id='a'*64)
        with patch.object(t, 'QUALIFIED_PROFILES', tuple(s.APPS)), \
             patch.object(t.shared, 'inspect', return_value=f.vector['observation']), \
             patch.object(t, 'Sampler', return_value=sampler):
            with self.assertRaises(s.TypedHookRefusal):
                t.execute(Mock(), q)
        self.assertEqual(sampler.bracket.call_count, 1)
        self.assertIsNone(sampler._hooks)

    def test_failed_group_is_cleared_and_a_new_owned_call_has_fresh_state(self):
        f = Files()
        original = f.run
        groups = []
        real_group = s._TypedHooks
        def factory(*args):
            group = real_group(*args)
            groups.append(group)
            return group
        sampler = s.Sampler(Mock(), time.monotonic()+12,
                            run=lambda *args: (1, b'', b'') if method(args[1]) == 'GetId' else original(*args))
        with patch.object(s, '_TypedHooks', side_effect=factory):
            with self.assertRaises(s.TypedHookRefusal):
                sampler.service(s.BUDDY)
            sampler.run = original
            sampler.service(s.BUDDY)  # A distinct explicit owned-fixture invocation.
        self.assertEqual(len(groups), 2)
        self.assertIsNot(groups[0], groups[1])
        for group in groups:
            self.assertEqual((group.owner, group.bus, group.client, group.units), (None, None, None, []))
        self.assertEqual(groups[1].commands, 12)

    def test_unsafe_owner_and_unknown_unit_never_enter_hook_argv(self):
        f = Files()
        original = f.run
        commands = []
        def run(*args):
            commands.append(args[1])
            if method(args[1]) == 'GetNameOwner':
                return 0, b'{"type":"s","data":[":1.0;PRIVATE_INJECTION"]}', b''
            return original(*args)
        sampler = s.Sampler(Mock(), time.monotonic()+12, run=run)
        with self.assertRaises(s.TypedHookRefusal):
            sampler.service(s.BUDDY)
        self.assertFalse(any(method(c) == 'GetUnit' for c in commands))
        before = len(commands)
        with self.assertRaises(ValueError):
            sampler.service('foreign.service')
        self.assertEqual(len(commands), before)


if __name__ == '__main__':
    unittest.main()
