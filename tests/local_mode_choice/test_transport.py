"""Synthetic channel controls; no SSH/device/provider contact."""
import base64
import json
from pathlib import Path
import subprocess
import sys
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
