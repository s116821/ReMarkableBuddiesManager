"""Actual bounded channel/SSH observations; route/key/notice and reports are explicit fixtures."""
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'host'))
sys.path.insert(0, str(root / 'tests/wired'))
import memory_query_transport as q
import wired_observer as o
from test_observer import Peer, Files
import paramiko

TEXT = 'gravity units\r\n第二行 🦊'
BOOT = '11111111-1111-1111-1111-111111111111'
BASELINE = {'generation': 1}
IDENTITY = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()
REQUEST = {'connection_id': IDENTITY, 'boot_id': BOOT, 'text': TEXT}

class Notice:
    def recv(self, _):
        time.sleep(.01)
        raise socket.timeout()
    def close(self):
        pass

class QueryPeer(Peer):
    def __init__(self, code=0):
        super().__init__()
        self.code, self.received = code, None
    def check_channel_exec_request(self, channel, command):
        if command.decode() == o.COMMAND:
            return super().check_channel_exec_request(channel, command)
        self.commands.append(command.decode())
        if command.decode() != q.COMMAND:
            return False
        def send():
            raw = bytearray()
            while part := channel.recv(4096):
                raw.extend(part)
            self.received = json.loads(raw)
            channel.sendall(b'{"report_version":1,"operation":"query","status":"invalid-input","incomplete":false,"data":null}\n')
            channel.send_stderr(b'PRIVATE_STDERR_SENTINEL')
            channel.send_exit_status(self.code)
            channel.shutdown_write()
        threading.Thread(target=send, daemon=True).start()
        return True

class Transport(unittest.TestCase):
    def test_exact_request_utf8_duplicate_unknown_and_private_refusal(self):
        self.assertEqual(q.request(json.dumps(REQUEST).encode())['text'], TEXT)
        for v in [dict(REQUEST, text='\0'), dict(REQUEST, text=' '), dict(REQUEST, text='🦊'*513), dict(REQUEST, path='/arbitrary')]:
            with self.assertRaises(ValueError): q.request(json.dumps(v).encode())
        for raw in [b'\xff', b'{"text":"one","text":"two"}', b'x'*16385, b'NaN']:
            with self.assertRaises((ValueError, UnicodeError)): q.request(raw)
        r = subprocess.run([sys.executable, str(root/'host/memory_query_transport.py')], input=b'PRIVATE_QUERY_CANARY', capture_output=True, timeout=3)
        self.assertEqual(r.returncode, 0); self.assertEqual(r.stderr, b''); self.assertNotIn(b'PRIVATE_QUERY_CANARY', r.stdout)
    def test_wrong_boot_and_connection_refuse_before_dispatch(self):
        t = Mock()
        with patch.object(q.shared, 'inspect', return_value={'boot_id': '22222222-2222-2222-2222-222222222222'}):
            with self.assertRaises(o.Refusal): q.execute(t, REQUEST)
        t.open_session.assert_not_called()
        with self.assertRaises(o.Refusal):
            o.observe({}, snapshot=lambda _: BASELINE, dial=t, expected_connection='a'*64)
        t.assert_not_called()
    def test_actual_channel_bounds_newline_duplicate_exit_and_post_boot_cleanup(self):
        for raw, code in [(b'x'*131073, 0), (b'{"status":0,"status":1}\n', 0), (b'\xff\n', 0), (b'{}', 0), (b'PRIVATE_STDOUT_CANARY\n', 1)]:
            channel = Mock(); channel.recv_ready.side_effect = [True, False, False]
            channel.recv.return_value = raw; channel.recv_stderr_ready.return_value = False
            channel.exit_status_ready.return_value = True; channel.recv_exit_status.return_value = code
            t = Mock(); t.open_session.return_value = channel
            with patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
                try:
                    value = q.execute(t, REQUEST)
                    self.assertIsNone(value['_memory_query']['report'])
                except (ValueError, UnicodeError):
                    pass
            channel.close.assert_called_once()
        channel = Mock(); channel.recv_ready.return_value = False; channel.recv_stderr_ready.return_value = False
        channel.exit_status_ready.return_value = True; channel.recv_exit_status.return_value = 0
        t = Mock(); t.open_session.return_value = channel
        with patch.object(q.shared, 'inspect', side_effect=[{'boot_id': BOOT}, {'boot_id': 'changed'}]):
            with self.assertRaises(o.Refusal): q.execute(t, REQUEST)
        channel.close.assert_called_once()
    @unittest.skipUnless(sys.platform == 'linux', 'POSIX SSH fixture, not native Windows USB qualification')
    def test_actual_ssh_fixed_command_stdin_eof_and_older_cli_refusal(self):
        for code in [0, 2, 127]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as folder:
                key = paramiko.RSAKey.generate(2048); path = Path(folder)/'identity'; key.write_private_key_file(str(path)); path.chmod(0o600)
                hostkey = paramiko.RSAKey.generate(2048); client, server = socket.socketpair(); peer = QueryPeer(code)
                transport = paramiko.Transport(server); transport.add_server_key(hostkey); transport.set_subsystem_handler('sftp', paramiko.SFTPServer, Files)
                transport.start_server(event=threading.Event(), server=peer)
                try:
                    observed = o.observe({'host_key_sha256': o.fingerprint(hostkey), 'identity_file': str(path)}, snapshot=lambda _: BASELINE, dial=lambda _: client,
                        notices=Notice(), expected_connection=IDENTITY, inspection=lambda t: q.execute(t, REQUEST))
                    self.assertEqual(peer.commands, [o.COMMAND, q.COMMAND, o.COMMAND]); self.assertNotIn(TEXT, repr(peer.commands))
                    self.assertEqual(set(peer.received), {'document', 'text', 'now_ms', 'current_claims', 'max_matches', 'max_context_bytes'})
                    self.assertEqual(peer.received['text'], TEXT); self.assertIsNone(peer.received['document']); self.assertEqual(peer.received['current_claims'], [])
                    self.assertEqual(peer.received['max_matches'], 8); self.assertEqual(peer.received['max_context_bytes'], 8192); self.assertIsInstance(peer.received['now_ms'], int)
                    result = observed['_memory_query']; self.assertNotIn('PRIVATE_', json.dumps(observed))
                    self.assertEqual(result['status'], 'reported' if code == 0 else 'unsupported')
                    if code == 0: self.assertEqual(result['report']['status'], 'invalid-input')
                finally:
                    transport.close(); client.close(); server.close()

if __name__ == '__main__': unittest.main()
