"""Synthetic channel controls; no SSH/device/provider contact."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'host'))
import local_mode_choice_transport as q

BOOT = '11111111-1111-4111-8111-111111111111'
ORIGINAL = {'operation': BOOT, 'expected': {'actor': BOOT, 'sha256': 'a'*64}, 'choice': {'kind': 'local-only'}}
REQUEST = {'connection_id': 'b'*64, 'boot_id': BOOT, 'selector': 'inspect', 'input_base64': None, 'budget_ms': 12000}
REPORT = {'report_version': 1, 'operation': 'inspect', 'status': 'unavailable', 'incomplete': True, 'activation_performed': False, 'data': None}


def choose(body=ORIGINAL):
    return dict(REQUEST, selector='choose', input_base64=base64.b64encode(json.dumps(body).encode()).decode())


PROVISION_ORIGINAL = {'control_version': 1, 'operation': BOOT, 'expected': ORIGINAL['expected']}

COLLECTION = '44444444-4444-4444-8444-444444444444'
DRIVE_BINDING = hashlib.sha256(
    b'["synthetic-desktop-client","fixture-account","44444444-4444-4444-8444-444444444444"]').hexdigest()
DRIVE_ORIGINAL = {'config_sha256': 'b' * 64, 'credential_path_sha256': 'c' * 64, 'parent_identity_sha256': 'd' * 64,
                  'device': BOOT, 'epoch': COLLECTION, 'mode': {'kind': 'local-only'}, 'mode_token': ORIGINAL['expected'],
                  'slot': {'kind': 'absent'}}
DRIVE_INSPECT = {'control_version': 1, 'action': 'inspect', 'expected_mode': ORIGINAL['expected']}


def drive_input(body):
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    return dict(REQUEST, selector=q.DRIVE, input_base64=base64.b64encode(body).decode('ascii'))


def drive_credential():
    return {'credential_version': 1, 'client_id': 'synthetic-desktop-client', 'client_secret': None,
            'access_token': 'synthetic-access', 'refresh_token': 'synthetic-refresh',
            'expires_at': int(time.time()) + 3600, 'scopes': [q.DRIVE_SCOPE],
            'account_permission_id': 'fixture-account', 'collection': COLLECTION}


def drive_apply(credential):
    if isinstance(credential, dict):
        credential = json.dumps(credential).encode()
    return {'control_version': 1, 'action': 'apply', 'operation': BOOT, 'original': DRIVE_ORIGINAL,
            'change': {'kind': 'create', 'collection': COLLECTION, 'binding_sha256': DRIVE_BINDING,
                       'credential_b64': base64.b64encode(credential).decode('ascii')}}


def drive_report(action, outcome, current=None):
    return {'report_version': 1, 'action': action, 'operation': None if action in ('inspect', None) else BOOT,
            'outcome': outcome, 'current': current, 'disk_readback_verified': current is not None}


def provision(body=None, budget_ms=45000):
    if body is None:
        body = json.dumps(PROVISION_ORIGINAL).encode()
    return dict(REQUEST, selector='provision-isolated-backup', budget_ms=budget_ms,
                input_base64=base64.b64encode(body).decode())


class Transport(unittest.TestCase):
    def channel(self, raw=None, code=0):
        channel = Mock()
        channel.recv_ready.side_effect = [True, False, False]
        channel.recv.return_value = json.dumps(REPORT).encode()+b'\n' if raw is None else raw
        channel.recv_stderr_ready.return_value = False
        channel.exit_status_ready.return_value = True
        channel.recv_exit_status.return_value = code
        transport = Mock()
        transport.open_session.return_value = channel
        return transport, channel

    def test_drive_opens_only_the_existing_fixed_selector_and_preserves_exact_bytes(self):
        raw_credential = json.dumps(drive_credential()).encode()
        raw_credential = raw_credential.ljust(48 * 1024, b' ')
        raw_request = json.dumps(drive_apply(raw_credential), indent=2).encode().ljust(68 * 1024, b' ')
        self.assertEqual(len(raw_request), 68 * 1024)
        outbound = json.dumps(drive_input(raw_request)).encode()
        v = q.request(outbound)
        self.assertGreater(len(outbound), q.MAX_REQUEST)
        self.assertLessEqual(len(outbound), q.MAX_DRIVE_REQUEST)
        current = dict(DRIVE_ORIGINAL, slot={'kind': 'present', 'sha256': hashlib.sha256(raw_credential).hexdigest(),
            'metadata_sha256': 'e' * 64, 'binding_sha256': DRIVE_BINDING, 'collection': COLLECTION})
        reply = json.dumps(drive_report('apply', 'verified', current)).encode().ljust(q.MAX_RESPONSE-1, b' ') + b'\n'
        transport, channel = self.channel(reply)
        channel.eof_received = True
        channel.closed = False
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': BOOT}]) as inspect:
            result = q.execute(transport, v)
        self.assertEqual(inspect.call_count, 2)
        channel.exec_command.assert_called_once_with(q.PREFIX + 'drive-credential --sync-mode-input -')
        channel.sendall.assert_called_once_with(raw_request)
        channel.shutdown_write.assert_called_once()
        channel.close.assert_called_once()
        self.assertEqual(base64.b64decode(result['_local_mode_raw']['stdout_base64']), reply)
        envelope = dict(contract_version=1, status='observed',
                        observation={'boot_id': BOOT, 'connection_id': 'b'*64},
                        local_mode_raw=result['_local_mode_raw'])
        self.assertLess(len(json.dumps(envelope).encode()) + 1, q.MAX_REQUEST)
        self.assertNotIn('synthetic-refresh', json.dumps(envelope))

    def test_drive_request_bounds_and_rejected_shape_precede_inspection(self):
        credential = drive_credential()
        raw = json.dumps(credential).encode()
        inspect = json.dumps(DRIVE_INSPECT).encode()
        original = drive_apply(credential)
        invalid = (
            drive_input(inspect.ljust(68 * 1024 + 1, b' ')),
            drive_input(drive_apply(raw.ljust(48 * 1024 + 1, b' '))),
            drive_input(drive_apply(b'{"credential_version":1,' + raw[1:])),
            drive_input(drive_apply(dict(credential, scopes=['unexpected']))),
            drive_input(drive_apply(dict(credential, expires_at=1))),
            drive_input(drive_apply(dict(credential, refresh_token='unsafe\nvalue'))),
            drive_input(dict(original, original=dict(DRIVE_ORIGINAL, mode={'kind': 'shared-group'}))),
            drive_input(dict(original, change=dict(original['change'], binding_sha256='f'*64))),
            drive_input(dict(DRIVE_INSPECT, control_version=1.0)),
            drive_input(dict(DRIVE_INSPECT, config_path='unexpected')),
            drive_input(b'{"control_version":1,"action":"inspect","action":"apply"}'),
            dict(drive_input(DRIVE_INSPECT), budget_ms=12001),
            dict(drive_input(DRIVE_INSPECT), input_base64='Zh=='),
        )
        for v in invalid:
            with self.assertRaises(ValueError):
                q.request(json.dumps(v).encode())
        for v in (REQUEST, choose(), provision()):
            raw_old = json.dumps(v).encode().ljust(q.MAX_REQUEST + 1, b' ')
            with self.assertRaises(ValueError):
                q.request(raw_old)
        with patch.object(q.shared, 'inspect') as inspect_call:
            with self.assertRaises(ValueError):
                q.execute(Mock(), invalid[0])
        inspect_call.assert_not_called()

    def test_drive_receipts_require_eof_exit_and_same_mode_context(self):
        v = drive_input(DRIVE_INSPECT)
        good = json.dumps(drive_report('inspect', 'observed', DRIVE_ORIGINAL)).encode() + b'\n'
        for raw, eof, closed in [
            (good, False, True),
            (good + b' ', True, False),
            (good[:-1].ljust(q.MAX_RESPONSE, b' ') + b'\n', True, False),
            (json.dumps(drive_report('inspect', 'observed', dict(DRIVE_ORIGINAL,
                        mode_token={'actor': BOOT, 'sha256': 'e'*64}))).encode() + b'\n', True, False),
            (json.dumps(dict(drive_report('inspect', 'observed', DRIVE_ORIGINAL),
                             refresh_token='PRIVATE_CANARY')).encode() + b'\n', True, False),
        ]:
            transport, channel = self.channel(raw)
            channel.eof_received, channel.closed = eof, closed
            with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
                try:
                    result = q.execute(transport, v)
                except ValueError as error:
                    self.assertNotIn('PRIVATE_CANARY', str(error))
                else:
                    self.assertEqual(result['_local_mode_raw'], {'status': 'unavailable', 'stdout_base64': None})
            channel.sendall.assert_called_once()
            channel.close.assert_called_once()
        transport, channel = self.channel(good)
        channel.eof_received, channel.closed = True, False
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': COLLECTION}]):
            with self.assertRaises(q.shared.Refusal) as error:
                q.execute(transport, v)
        self.assertEqual(error.exception.status, 'cable-lost')
        channel.sendall.assert_called_once()
        channel.close.assert_called_once()

    def test_provision_accepts_only_the_exact_v1_input_with_its_own_budget(self):
        raw = json.dumps(PROVISION_ORIGINAL, indent=2).encode() + b' \n'
        exact_limit = raw + b' ' * (16384 - len(raw))
        self.assertEqual(q.request(json.dumps(provision(exact_limit)).encode()), provision(exact_limit))
        for v in [
                provision(exact_limit + b' '), provision(b'\xff'),
                provision(b'{"control_version":1,"control_version":1}'),
                provision(b'{}'), provision(b'\xef\xbb\xbf' + raw),
                provision(raw + b'{}'), provision(budget_ms=45001), provision(budget_ms=True),
                dict(provision(), input_base64=None), dict(provision(), input_base64='Zh=='),
                dict(provision(), selector=q.PROVISION + ' --anything'),
                dict(provision(), selector=['inspect']), dict(choose(), budget_ms=12001),
                dict(REQUEST, budget_ms=12001),
        ]:
            with self.subTest(v=str(v)[:110]), self.assertRaises((ValueError, UnicodeError)):
                q.request(json.dumps(v).encode())
        for body in [
                dict(PROVISION_ORIGINAL, control_version=True),
                dict(PROVISION_ORIGINAL, control_version=1.0),
                dict(PROVISION_ORIGINAL, control_version=2),
                dict(PROVISION_ORIGINAL, endpoint='refused'),
                dict(PROVISION_ORIGINAL, expected=dict(ORIGINAL['expected'], extra=True)),
                ORIGINAL,
        ]:
            with self.assertRaises(ValueError):
                q.request(json.dumps(provision(json.dumps(body).encode())).encode())

    def test_provision_sends_original_bytes_once_and_preserves_report_frame(self):
        original_bytes = b'  ' + json.dumps(PROVISION_ORIGINAL, indent=2).encode() + b'\n '
        report = json.dumps(dict(REPORT, operation=q.PROVISION)).encode() + b'\n'
        transport, channel = self.channel(report)
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': BOOT}]) as inspect:
            result = q.execute(transport, q.request(json.dumps(provision(original_bytes)).encode()))
        self.assertEqual(inspect.call_count, 2)
        channel.exec_command.assert_called_once_with(q.PREFIX + q.PROVISION + ' --sync-mode-input -')
        channel.sendall.assert_called_once_with(original_bytes)
        channel.shutdown_write.assert_called_once()
        channel.close.assert_called_once()
        self.assertEqual(base64.b64decode(result['_local_mode_raw']['stdout_base64']), report)

    def test_provision_deadline_closes_the_channel_even_during_exec_ack(self):
        transport, channel = self.channel()
        closed = threading.Event()
        channel.close.side_effect = closed.set
        def blocked_exec(_):
            self.assertTrue(closed.wait(2), 'exec wait was not interrupted')
            raise OSError('ignored diagnostic')
        channel.exec_command.side_effect = blocked_exec
        real_timer = threading.Timer
        def accelerated(delay, callback):
            self.assertAlmostEqual(delay, 35, delta=.2)
            return real_timer(.02, callback)
        with (patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}),
              patch.object(q.threading, 'Timer', side_effect=accelerated)):
            with self.assertRaises(q.shared.Refusal) as error:
                q.execute(transport, provision())
        self.assertEqual(error.exception.status, 'timeout')
        channel.exec_command.assert_called_once()
        channel.sendall.assert_not_called()
        channel.close.assert_called_once()

    def test_ordinary_command_still_expires_after_eight_seconds(self):
        transport, channel = self.channel()
        channel.recv_ready.side_effect = None
        channel.recv_ready.return_value = False
        channel.exit_status_ready.return_value = False
        clock = [0]
        def advance(_):
            clock[0] = 8.01
        with (patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}),
              patch.object(q.time, 'monotonic', side_effect=lambda: clock[0]),
              patch.object(q.time, 'sleep', side_effect=advance)):
            with self.assertRaises(q.shared.Refusal) as error:
                q.execute(transport, REQUEST)
        self.assertEqual(error.exception.status, 'timeout')
        channel.close.assert_called_once()

    def test_provision_keeps_post_send_failures_unacknowledged(self):
        valid = json.dumps(dict(REPORT, operation=q.PROVISION)).encode() + b'\n'
        transport, channel = self.channel(valid)
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': 'changed'}]):
            with self.assertRaises(q.shared.Refusal) as error:
                q.execute(transport, provision())
        self.assertEqual(error.exception.status, 'cable-lost')
        channel.sendall.assert_called_once()
        channel.close.assert_called_once()
        transport, channel = self.channel(valid)
        channel.shutdown_write.side_effect = OSError('synthetic EOF failure')
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            with self.assertRaises(OSError):
                q.execute(transport, provision())
        channel.sendall.assert_called_once()
        channel.recv_exit_status.assert_not_called()
        for raw, code in [(valid[:-1], 0), (valid + valid, 0), (b'PRIVATE_CANARY', 1)]:
            transport, channel = self.channel(raw, code)
            with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
                result = q.execute(transport, provision())
            self.assertEqual(result['_local_mode_raw'], {'status': 'unavailable', 'stdout_base64': None})
            channel.sendall.assert_called_once()

    def test_private_request_exactness_and_inclusive_bounds(self):
        for v in [REQUEST, choose()]:
            raw = json.dumps(v).encode()
            self.assertEqual(q.request(raw), v)
            self.assertEqual(q.request(raw+b' '*(q.MAX_REQUEST-len(raw))), v)
        for v in [dict(REQUEST, selector='initialize'), dict(REQUEST, selector='status'), dict(REQUEST, command='whoami'), dict(REQUEST, path='/tmp/file'), dict(REQUEST, budget_ms=True), dict(REQUEST, budget_ms=12001), dict(REQUEST, input_base64='e30='), dict(choose(), input_base64='e30='), dict(REQUEST, connection_id='b'*64+'\n')]:
            with self.assertRaises(ValueError):
                q.request(json.dumps(v).encode())
        for raw in [b'x'*(q.MAX_REQUEST+1), b'{"selector":"inspect","selector":"choose"}', b'\xff', b'NaN']:
            with self.assertRaises((ValueError, UnicodeError)):
                q.request(raw)
        for mutation in [dict(ORIGINAL, extra=True), dict(ORIGINAL, choice={'kind': 'shared-group'}), dict(ORIGINAL, choice={'kind': 'local-only', 'extra': True}), dict(ORIGINAL, expected={'actor': BOOT, 'sha256': 'bad'})]:
            with self.assertRaises(ValueError):
                q.request(json.dumps(choose(mutation)).encode())

    def test_fixed_command_single_write_and_eof(self):
        for selector in ['inspect', 'choose']:
            report = dict(REPORT, operation=selector)
            transport, channel = self.channel(json.dumps(report).encode()+b'\n')
            v = REQUEST if selector == 'inspect' else choose()
            with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
                result = q.execute(transport, v)
            channel.exec_command.assert_called_once_with(q.PREFIX+selector+(' --sync-mode-input -' if selector == 'choose' else ''))
            channel.shutdown_write.assert_called_once_with()
            if selector == 'choose':
                channel.sendall.assert_called_once_with(base64.b64decode(v['input_base64']))
            else:
                channel.sendall.assert_not_called()
            self.assertEqual(result['_local_mode_raw']['status'], 'reported')
            channel.close.assert_called_once()

    def test_post_write_failure_never_resends_original(self):
        transport, channel = self.channel()
        channel.sendall.side_effect = OSError('synthetic failure')
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            with self.assertRaises(OSError):
                q.execute(transport, choose())
        channel.sendall.assert_called_once()
        channel.exec_command.assert_called_once()
        channel.close.assert_called_once()

    def test_changed_boot_refuses_before_command_and_changed_after_refuses(self):
        transport, channel = self.channel()
        with patch.object(q.shared, 'inspect', return_value={'boot_id': 'changed'}):
            with self.assertRaises(q.shared.Refusal):
                q.execute(transport, REQUEST)
        transport.open_session.assert_not_called()
        transport, channel = self.channel()
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': 'changed'}]):
            with self.assertRaises(q.shared.Refusal):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()

    def test_exact_output_cap_and_invalid_framing(self):
        raw=json.dumps(REPORT).encode()
        padded=raw+b' '*(q.MAX_RESPONSE-len(raw)-1)+b'\n'
        transport, channel=self.channel(padded)
        with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):
            result=q.execute(transport,REQUEST)
        self.assertEqual(base64.b64decode(result['_local_mode_raw']['stdout_base64']),padded)
        for raw,code in [(b'x'*(q.MAX_RESPONSE+1),0),(b'{"status":1,"status":2}\n',0),(b'\xff\n',0),(b'{}',0),(b'{}\n{}\n',0),(b'PRIVATE_CANARY',1)]:
            transport,channel=self.channel(raw,code)
            with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):
                try:
                    result=q.execute(transport,REQUEST)
                    self.assertIsNone(result['_local_mode_raw']['stdout_base64'])
                    self.assertNotIn('PRIVATE_CANARY',json.dumps(result))
                except (ValueError,UnicodeError):
                    pass
            channel.close.assert_called_once()

    def test_remaining_budget_and_stderr_bounds(self):
        transport,channel=self.channel()
        with patch.object(q.time,'monotonic',return_value=5):
            with self.assertRaises(q.shared.Refusal):
                q.execute(transport,REQUEST,deadline=4)
        transport.open_session.assert_not_called()
        transport,channel=self.channel()
        channel.recv_stderr_ready.return_value=True
        channel.recv_stderr.return_value=b'x'*8193
        with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):
            with self.assertRaises(ValueError):
                q.execute(transport,REQUEST)
        channel.close.assert_called_once()

    def test_invalid_input_subprocess_emits_one_sanitized_failure(self):
        result=subprocess.run([sys.executable,str(ROOT/'host/local_mode_choice_transport.py')],input=b'PRIVATE_INPUT_CANARY',capture_output=True,timeout=3)
        self.assertEqual(result.returncode,0)
        self.assertEqual(result.stderr,b'')
        self.assertNotIn(b'PRIVATE_INPUT_CANARY',result.stdout)
        self.assertEqual(len(result.stdout.splitlines()),1)
        self.assertIsNone(json.loads(result.stdout)['local_mode_raw']['stdout_base64'])


if __name__ == '__main__':
    unittest.main()
