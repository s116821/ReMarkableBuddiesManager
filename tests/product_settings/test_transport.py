"""Mock channel and local subprocess tests only. No SSH connections or devices."""
import base64
import io
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'host'))
sys.path.insert(0, str(root / 'tests/wired'))
import product_settings_transport as q
import wired_observer as o





BOOT = '11111111-1111-1111-1111-111111111111'
BASELINE = {'generation': 1}
IDENTITY = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()
CORPUS = json.loads((root/'tests/fixtures/product-settings-c3d095c-vectors.json').read_text())
NAMES = {'inspect': 'inspect-defaults', 'prepare': 'prepare-reader-false', 'apply': 'apply-restart-required', 'status': 'status-unresolved'}
CASES = {selector: {'stdout_utf8': next(c for c in CORPUS['raw_protocol'] if c['id'] == name)['raw_utf8']} for selector, name in NAMES.items()}
ref = CORPUS['reference']
for selector, case in CASES.items():
    body = None if selector == 'inspect' else {'product_settings_version': 1, 'operation': ref['operation'], 'base_sha256': ref['base_sha256'], 'config_path_sha256': ref['config_path_sha256'], 'changes': ref['intent']['changes']} if selector == 'prepare' else {'intent': ref['intent']}
    case['stdin_base64'] = None if body is None else base64.b64encode(json.dumps(body).encode()).decode()
REPORT = CASES['inspect']['stdout_utf8'].encode()
REQUEST = {'connection_id': IDENTITY, 'boot_id': BOOT, 'selector': 'inspect', 'input_base64': None, 'budget_ms': 12000}


def command(selector):
    return q.PREFIX + selector + ('' if selector == 'inspect' else ' --product-settings-input -')


def request_for(selector):
    return dict(REQUEST, selector=selector, input_base64=CASES[selector]['stdin_base64'])



class Notice:
    def recv(self, _):
        time.sleep(.01)
        raise socket.timeout()
    def close(self):
        pass


class Transport(unittest.TestCase):
    def channel(self, raw, code=0):
        channel = Mock()
        channel.recv_ready.side_effect = [True, False, False]
        channel.recv.return_value = raw
        channel.recv_stderr_ready.return_value = False
        channel.exit_status_ready.return_value = True
        channel.recv_exit_status.return_value = code
        transport = Mock()
        transport.open_session.return_value = channel
        return transport, channel

    def test_fixed_private_requests_and_inclusive_input_bound(self):
        raw = json.dumps(REQUEST).encode()
        self.assertEqual(q.request(raw), REQUEST)
        self.assertEqual(q.request(raw+b' '*(q.MAX_REQUEST-len(raw))), REQUEST)
        for value in [dict(REQUEST, command='choose'), dict(REQUEST, path='/private'), dict(REQUEST, expected={}), dict(REQUEST, selector='choose'), dict(REQUEST, input_base64='e30='), dict(REQUEST, budget_ms=0), dict(REQUEST, budget_ms=True), dict(REQUEST, budget_ms=12001),
                      dict(REQUEST, boot_id=BOOT+'\n'), dict(REQUEST, connection_id=IDENTITY+'\n'), {}, None]:
            with self.assertRaises(ValueError):
                q.request(json.dumps(value).encode())
        for selector in ('prepare', 'apply', 'status'):
            self.assertEqual(q.request(json.dumps(request_for(selector)).encode()), request_for(selector))
        for raw in [b'\xff', b'{"boot_id":"one","boot_id":"two"}', b'x'*(q.MAX_REQUEST+1), b'NaN']:
            with self.assertRaises((ValueError, UnicodeError)):
                q.request(raw)

    def test_request_failure_never_echoes_private_input(self):
        run = subprocess.run([sys.executable, str(root/'host/product_settings_transport.py')], input=b'PRIVATE_INPUT_CANARY',
                             capture_output=True, timeout=3)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, b'')
        self.assertNotIn(b'PRIVATE_INPUT_CANARY', run.stdout)
        self.assertEqual(len(run.stdout.splitlines()), 1)
        self.assertIsNone(json.loads(run.stdout)['product_settings_raw']['stdout_base64'])

    def test_boot_or_connection_change_refuses_before_dispatch(self):
        transport = Mock()
        with patch.object(q.shared, 'inspect', return_value={'boot_id': 'changed'}):
            with self.assertRaises(o.Refusal):
                q.execute(transport, REQUEST)
        transport.open_session.assert_not_called()
        dial = Mock()
        with self.assertRaises(o.Refusal):
            o.observe({}, snapshot=lambda _: BASELINE, dial=dial, expected_connection='a'*64)
        dial.assert_not_called()

    def test_raw_output_bounds_duplicates_partial_utf8_and_nonzero_exit(self):
        padded = REPORT[:-1]+b' '*(q.MAX_RESPONSE-len(REPORT))+b'\n'
        self.assertEqual(len(padded), q.MAX_RESPONSE)
        transport, channel = self.channel(padded)
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            self.assertEqual(q.execute(transport, REQUEST)['_product_settings_raw']['stdout_base64'], base64.b64encode(padded).decode())
        channel.shutdown_write.assert_called_once_with()
        channel.sendall.assert_not_called()
        channel.exec_command.assert_called_once_with(command('inspect'))
        channel.close.assert_called_once()
        for raw, code in [(b'x'*(q.MAX_RESPONSE+1), 0), (b'{"status":0,"status":1}\n', 0), (b'\xff\n', 0),
                          (b'{}', 0), (b'{}\n{}\n', 0), (b'PRIVATE_OUTPUT_CANARY\n', 1)]:
            with self.subTest(code=code, size=len(raw)):
                transport, channel = self.channel(raw, code)
                with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
                    try:
                        value = q.execute(transport, REQUEST)
                        self.assertIsNone(value['_product_settings_raw']['stdout_base64'])
                        self.assertNotIn('PRIVATE_OUTPUT_CANARY', json.dumps(value))
                    except (ValueError, UnicodeError):
                        pass
                channel.close.assert_called_once()

    def test_timeout_stderr_bound_and_post_identity_change_close_channel(self):
        transport, channel = self.channel(REPORT)
        channel.recv_ready.return_value = False
        channel.recv_ready.side_effect = None
        channel.exit_status_ready.return_value = False
        clock=[0]
        def advance(_):
            clock[0]=13
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}), patch.object(q.time, 'monotonic', side_effect=lambda:clock[0]), patch.object(q.time, 'sleep', side_effect=advance):
            with self.assertRaises(o.Refusal):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()
        transport, channel = self.channel(REPORT)
        channel.recv_stderr_ready.side_effect = [True, False, False]
        channel.recv_stderr.return_value = b'x'*8192
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            self.assertEqual(q.execute(transport, REQUEST)['_product_settings_raw']['stdout_base64'], base64.b64encode(REPORT).decode())
        channel.close.assert_called_once()
        transport, channel = self.channel(REPORT)
        channel.recv_stderr_ready.return_value = True
        channel.recv_stderr.return_value = b'x'*8193
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            with self.assertRaises(ValueError):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()
        transport, channel = self.channel(REPORT)
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': 'changed'}]):
            with self.assertRaises(o.Refusal):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()

    def test_inherited_remaining_budget_caps_channel_and_prevents_late_command(self):
        transport, channel = self.channel(REPORT)
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}), patch.object(q.time, 'monotonic', return_value=0):
            q.execute(transport, dict(REQUEST, budget_ms=1500))
        transport.open_session.assert_called_once_with(timeout=1.5)
        channel.settimeout.assert_called_once_with(1.5)
        transport = Mock()
        clock=[0]
        def late_identity(_):
            clock[0]=2
            return {'boot_id': BOOT}
        with patch.object(q.shared, 'inspect', side_effect=late_identity), patch.object(q.time, 'monotonic', side_effect=lambda:clock[0]):
            with self.assertRaises(o.Refusal):
                q.execute(transport, dict(REQUEST, budget_ms=1000))
        transport.open_session.assert_not_called()

    def test_outer_deadline_and_completion_cannot_append_two_reports(self):
        class ExpiredTimer:
            def __init__(self, _, callback): self.callback = callback
            def start(self): self.callback()
            def cancel(self): pass
        output = io.StringIO()
        observation = {'boot_id': BOOT, '_product_settings_raw': {'status': 'reported', 'stdout_base64': base64.b64encode(REPORT).decode()}}
        with patch.object(q.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(REQUEST).encode()))), \
                patch.object(q.sys, 'stdout', output), patch.object(q.threading, 'Timer', ExpiredTimer), \
                patch.object(q.os, '_exit'), patch.dict(os.environ, {'MANAGER_WIRED_CONFIG': '/fixture'}), \
                patch.object(q.shared, 'load_config', return_value={}), patch.object(q.shared, 'observe', return_value=observation):
            q.main()
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())['status'], 'timeout')


if __name__ == '__main__':
    unittest.main()
