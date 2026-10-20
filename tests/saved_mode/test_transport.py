"""Fixed-command SSH/channel controls; route, notices and report replay are fixtures."""
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
import saved_mode_transport as q
import wired_observer as o
from test_observer import Peer, Files
import paramiko
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization

BOOT = '11111111-1111-1111-1111-111111111111'
BASELINE = {'generation': 1}
IDENTITY = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()
REQUEST = {'connection_id': IDENTITY, 'boot_id': BOOT}
CORPUS = json.loads((root/'tests/fixtures/main-b1-saved-mode-reports.json').read_text())
REPORT = (json.dumps(CORPUS['reports']['unconfigured.json'], separators=(',', ':'))+'\n').encode()


class Notice:
    def recv(self, _):
        time.sleep(.01)
        raise socket.timeout()
    def close(self):
        pass


class ModePeer(Peer):
    def __init__(self, code):
        super().__init__()
        self.code, self.received = code, None
    def check_channel_exec_request(self, channel, command):
        if command.decode() == o.COMMAND:
            return super().check_channel_exec_request(channel, command)
        self.commands.append(command.decode())
        if command.decode() != q.COMMAND:
            return False
        def send():
            self.received = bytearray()
            while part := channel.recv(4096):
                self.received.extend(part)
            channel.sendall(REPORT)
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

    def test_exact_identity_only_request_and_inclusive_input_bound(self):
        raw = json.dumps(REQUEST).encode()
        self.assertEqual(q.request(raw), REQUEST)
        self.assertEqual(q.request(raw+b' '*(256-len(raw))), REQUEST)
        for value in [dict(REQUEST, command='choose'), dict(REQUEST, path='/private'), dict(REQUEST, expected={}),
                      dict(REQUEST, boot_id=BOOT+'\n'), dict(REQUEST, connection_id=IDENTITY+'\n'), {}, None]:
            with self.assertRaises(ValueError):
                q.request(json.dumps(value).encode())
        for raw in [b'\xff', b'{"boot_id":"one","boot_id":"two"}', b'x'*257, b'NaN']:
            with self.assertRaises((ValueError, UnicodeError)):
                q.request(raw)

    def test_request_failure_never_echoes_private_input(self):
        run = subprocess.run([sys.executable, str(root/'host/saved_mode_transport.py')], input=b'PRIVATE_INPUT_CANARY',
                             capture_output=True, timeout=3)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, b'')
        self.assertNotIn(b'PRIVATE_INPUT_CANARY', run.stdout)
        self.assertEqual(len(run.stdout.splitlines()), 1)
        self.assertIsNone(json.loads(run.stdout)['saved_mode']['report'])

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
            self.assertEqual(q.execute(transport, REQUEST)['_saved_mode']['report'], CORPUS['reports']['unconfigured.json'])
        channel.shutdown_write.assert_called_once_with()
        channel.sendall.assert_not_called()
        channel.exec_command.assert_called_once_with(q.COMMAND)
        channel.close.assert_called_once()
        for raw, code in [(b'x'*16385, 0), (b'{"status":0,"status":1}\n', 0), (b'\xff\n', 0),
                          (b'{}', 0), (b'{}\n{}\n', 0), (b'PRIVATE_OUTPUT_CANARY\n', 1)]:
            with self.subTest(code=code, size=len(raw)):
                transport, channel = self.channel(raw, code)
                with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
                    try:
                        value = q.execute(transport, REQUEST)
                        self.assertIsNone(value['_saved_mode']['report'])
                        self.assertNotIn('PRIVATE_OUTPUT_CANARY', json.dumps(value))
                    except (ValueError, UnicodeError):
                        pass
                channel.close.assert_called_once()

    def test_timeout_stderr_bound_and_post_identity_change_close_channel(self):
        transport, channel = self.channel(REPORT)
        channel.recv_ready.return_value = False
        channel.recv_ready.side_effect = None
        channel.exit_status_ready.return_value = False
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}), patch.object(q.time, 'monotonic', side_effect=[0, 9]):
            with self.assertRaises(o.Refusal):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()
        transport, channel = self.channel(REPORT)
        channel.recv_stderr_ready.return_value = True
        channel.recv_stderr.return_value = b'x'*16385
        with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            with self.assertRaises(ValueError):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()
        transport, channel = self.channel(REPORT)
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': 'changed'}]):
            with self.assertRaises(o.Refusal):
                q.execute(transport, REQUEST)
        channel.close.assert_called_once()

    def test_outer_deadline_and_completion_cannot_append_two_reports(self):
        class ExpiredTimer:
            def __init__(self, _, callback): self.callback = callback
            def start(self): self.callback()
            def cancel(self): pass
        output = io.StringIO()
        observation = {'boot_id': BOOT, '_saved_mode': {'status': 'reported', 'report': CORPUS['reports']['unconfigured.json']}}
        with patch.object(q.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(REQUEST).encode()))), \
                patch.object(q.sys, 'stdout', output), patch.object(q.threading, 'Timer', ExpiredTimer), \
                patch.object(q.os, '_exit'), patch.dict(os.environ, {'MANAGER_WIRED_CONFIG': '/fixture'}), \
                patch.object(q.shared, 'load_config', return_value={}), patch.object(q.shared, 'observe', return_value=observation):
            q.main()
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())['status'], 'timeout')

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX SSH peer, not native Windows USB qualification')
    def test_actual_ssh_peer_fixed_command_empty_stdin_and_capability_refusal(self):
        for code in [0, 2, 127]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as folder:
                client_bytes, _ = fixed_fixture_key(bytes(range(32)))
                _, hostkey = fixed_fixture_key(bytes([7])*32)
                key_path = Path(folder)/'public-fixture-identity'
                key_path.write_bytes(client_bytes)
                key_path.chmod(0o600)
                client, server = socket.socketpair()
                peer = ModePeer(code)
                transport = paramiko.Transport(server)
                transport.add_server_key(hostkey)
                transport.set_subsystem_handler('sftp', paramiko.SFTPServer, Files)
                transport.start_server(event=threading.Event(), server=peer)
                try:
                    observed = o.observe({'host_key_sha256': o.fingerprint(hostkey), 'identity_file': str(key_path)},
                        snapshot=lambda _: BASELINE, dial=lambda _: client, notices=Notice(), expected_connection=IDENTITY,
                        inspection=lambda t: q.execute(t, REQUEST))
                    self.assertEqual(peer.commands, [o.COMMAND, q.COMMAND, o.COMMAND])
                    self.assertEqual(peer.received, b'')
                    self.assertNotIn('--sync-mode-input', q.COMMAND)
                    self.assertNotIn('PRIVATE_STDERR_CANARY', json.dumps(observed))
                    mode = observed['_saved_mode']
                    self.assertEqual(mode['status'], 'reported' if code == 0 else 'unsupported')
                    if code == 0: self.assertEqual(mode['report'], CORPUS['reports']['unconfigured.json'])
                finally:
                    transport.close()
                    client.close()
                    server.close()


if __name__ == '__main__':
    unittest.main()
