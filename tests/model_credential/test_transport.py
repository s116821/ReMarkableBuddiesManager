"""Fixed-command SSH/channel controls; route, notices and response bytes are fixtures."""
import base64
import hashlib
import io
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
import model_credential_transport as q
import wired_observer as o
from test_observer import Peer, Files
import paramiko
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization

BOOT = '11111111-1111-1111-1111-111111111111'
BASELINE = {'generation': 1}
IDENTITY = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()
# Newly constructed synthetic reference reports; no historical producer corpus replay.
BASE = {'config_sha256': 'a'*64, 'config_path_sha256': 'b'*64, 'credential_path_sha256': 'c'*64, 'parent_identity_sha256': 'd'*64, 'state': {'kind': 'absent'}}
CHANGES = {'action': 'install', 'value': 'SYNTHETIC_KEY\r\n tail α '}
INTENT = {'credential_version': 1, 'operation': '77777777-7777-4777-8777-777777777777', 'base': BASE, 'action': 'install', 'target': {'kind': 'present', 'sha256': hashlib.sha256(CHANGES['value'].encode()).hexdigest(), 'mode': 384}}
PREPARE = {'credential_version': 1, 'operation': INTENT['operation'], 'base': BASE, 'change': CHANGES}
CASES = {}
for selector, outcome, data, body in [
    ('inspect', 'read-only', {'schema_version': 1, 'binding': BASE}, None),
    ('prepare', 'prepared', {'intent': INTENT}, PREPARE),
    ('apply', 'verified', {'present': True}, {'intent': INTENT, 'change': CHANGES}),
    ('status', 'desired-file-observed', {'present': True}, {'intent': INTENT})]:
    value = {'report_version': 1, 'operation': selector, 'status': 'ok', 'outcome': outcome,
             'disk_readback_verified': selector == 'apply', 'runtime_activation': 'unverified', 'data': data}
    CASES[selector] = {'stdout_utf8': json.dumps(value, separators=(',', ':')) + '\n',
                       'stdin_base64': None if body is None else base64.b64encode(json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode()).decode()}
REPORT = CASES['inspect']['stdout_utf8'].encode()
REQUEST = {'connection_id': IDENTITY, 'boot_id': BOOT, 'selector': 'inspect', 'input_base64': None, 'budget_ms': 12000}


def command(selector):
    return q.PREFIX + selector + ('' if selector == 'inspect' else ' --model-credential-input -')


def request_for(selector):
    return dict(REQUEST, selector=selector, input_base64=CASES[selector]['stdin_base64'])



class Notice:
    def recv(self, _):
        time.sleep(.01)
        raise socket.timeout()
    def close(self):
        pass


class ModePeer(Peer):
    def __init__(self, code, selector):
        super().__init__()
        self.code, self.selector, self.received = code, selector, None
    def check_channel_exec_request(self, channel, command):
        if command.decode() == o.COMMAND:
            return super().check_channel_exec_request(channel, command)
        self.commands.append(command.decode())
        if command.decode() != globals()['command'](self.selector):
            return False
        def send():
            self.received = bytearray()
            while part := channel.recv(4096):
                self.received.extend(part)
            channel.sendall(CASES[self.selector]['stdout_utf8'].encode())
            channel.send_stderr(b'PRIVATE_STDERR_CANARY')
            channel.send_exit_status(self.code)
            channel.shutdown_write()
        threading.Thread(target=send, daemon=True).start()
        return True


def fixed_fixture_key(seed):
    # Public deterministic test bytes; never a user identity or generated secret.
    private = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
    raw = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                serialization.NoEncryption())
    return raw, paramiko.Ed25519Key.from_private_key(io.StringIO(raw.decode()))


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
        run = subprocess.run([sys.executable, str(root/'host/model_credential_transport.py')], input=b'PRIVATE_INPUT_CANARY',
                             capture_output=True, timeout=3)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, b'')
        self.assertNotIn(b'PRIVATE_INPUT_CANARY', run.stdout)
        self.assertEqual(len(run.stdout.splitlines()), 1)
        self.assertIsNone(json.loads(run.stdout)['model_credential_raw']['stdout_base64'])

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
            self.assertEqual(q.execute(transport, REQUEST)['_model_credential_raw']['stdout_base64'], base64.b64encode(padded).decode())
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
                        self.assertIsNone(value['_model_credential_raw']['stdout_base64'])
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
            self.assertEqual(q.execute(transport, REQUEST)['_model_credential_raw']['stdout_base64'], base64.b64encode(REPORT).decode())
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
        observation = {'boot_id': BOOT, '_model_credential_raw': {'status': 'reported', 'stdout_base64': base64.b64encode(REPORT).decode()}}
        with patch.object(q.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(REQUEST).encode()))), \
                patch.object(q.sys, 'stdout', output), patch.object(q.threading, 'Timer', ExpiredTimer), \
                patch.object(q.os, '_exit'), patch.dict(os.environ, {'MANAGER_WIRED_CONFIG': '/fixture'}), \
                patch.object(q.shared, 'load_config', return_value={}), patch.object(q.shared, 'observe', return_value=observation):
            q.main()
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())['status'], 'timeout')

    def test_synthetic_shape_patch_binding_and_runtime_claims(self):
        for selector, row in CASES.items():
            q.report_shape(json.loads(row['stdout_utf8']), selector)
        for value in ('SYNTHETIC\0KEY\r\n \t', '\ufeff', 'a'*8192):
            q.change({'action': 'replace', 'value': value})
        for value in (None, 1, True, '', 'x'*8193, '\u0085', '\ud800'):
            with self.assertRaises((ValueError, UnicodeError)):
                q.change({'action': 'install', 'value': value})
        for bad in ({}, {'action': 'remove', 'value': 'private'}, {'action': 'install', 'value': 'valid', 'other': 1}):
            with self.assertRaises(ValueError):
                q.change(bad)
        body = json.loads(base64.b64decode(request_for('apply')['input_base64']))
        body['change']['value'] = 'SYNTHETIC_Other'
        with self.assertRaises(ValueError):
            q.request(json.dumps(dict(REQUEST, selector='apply', input_base64=base64.b64encode(json.dumps(body).encode()).decode())).encode())
        status = request_for('status')
        body = json.loads(base64.b64decode(status['input_base64']))
        body['change'] = CHANGES
        with self.assertRaises(ValueError):
            q.request(json.dumps(dict(status, input_base64=base64.b64encode(json.dumps(body).encode()).decode())).encode())
        malformed = json.loads(CASES['inspect']['stdout_utf8'])
        malformed['data']['binding']['state'] = {'kind': 'absent', 'value': 'SYNTHETIC'}
        with self.assertRaises(ValueError):
            q.report_shape(malformed, 'inspect')
        malformed = json.loads(CASES['apply']['stdout_utf8'])
        malformed['runtime_activation'] = 'restart-required'
        with self.assertRaises(ValueError):
            q.report_shape(malformed, 'apply')

    @unittest.skipUnless(sys.platform == 'linux', 'Local POSIX SSH peer, not native Windows USB qualification')
    def test_actual_ssh_peer_fixed_selectors_original_stdin_and_capability_refusal(self):
        for selector in ('inspect', 'prepare', 'apply', 'status'):
            for code in [0, 2, 127]:
                with self.subTest(selector=selector, code=code), tempfile.TemporaryDirectory() as folder:
                    client_bytes, _ = fixed_fixture_key(bytes(range(32)))
                    _, hostkey = fixed_fixture_key(bytes([7])*32)
                    key_path = Path(folder)/'public-fixture-identity'
                    key_path.write_bytes(client_bytes)
                    key_path.chmod(0o600)
                    client, server = socket.socketpair()
                    peer = ModePeer(code, selector)
                    transport = paramiko.Transport(server)
                    transport.add_server_key(hostkey)
                    transport.set_subsystem_handler('sftp', paramiko.SFTPServer, Files)
                    transport.start_server(event=threading.Event(), server=peer)
                    try:
                        request = request_for(selector)
                        observed = o.observe({'host_key_sha256': o.fingerprint(hostkey), 'identity_file': str(key_path)},
                            snapshot=lambda _: BASELINE, dial=lambda _: client, notices=Notice(), expected_connection=IDENTITY,
                            inspection=lambda t: q.execute(t, request))
                        self.assertEqual(peer.commands, [o.COMMAND, command(selector), o.COMMAND])
                        self.assertEqual(peer.received, b'' if selector == 'inspect' else base64.b64decode(request['input_base64']))
                        self.assertNotIn('--config', command(selector).split())
                        self.assertEqual('--model-credential-input' in command(selector).split(), selector != 'inspect')
                        self.assertNotIn('PRIVATE_STDERR_CANARY', json.dumps(observed))
                        raw = observed['_model_credential_raw']
                        self.assertEqual(raw['status'], 'reported' if code == 0 else 'unsupported')
                        if code == 0:
                            self.assertEqual(base64.b64decode(raw['stdout_base64']), CASES[selector]['stdout_utf8'].encode())
                        else:
                            self.assertIsNone(raw['stdout_base64'])
                    finally:
                        transport.close()
                        client.close()
                        server.close()


if __name__ == '__main__':
    unittest.main()
