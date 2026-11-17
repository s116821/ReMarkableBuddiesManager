import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'host'))
import capacities_oauth_transport as oauth

USB = {'fixture': 'wired'}
SHA = 'a' * 64
ATTESTATION = oauth.ATTEST_PREFIX + SHA.encode() + b'\n'
BINDING = {
    'tablet_id': str(uuid4()), 'boot_id': str(uuid4()), 'operation_id': str(uuid4()), 'grant_id': str(uuid4()),
    'config_sha256': 'b' * 64,
    'connection_id': hashlib.sha256(json.dumps(USB, sort_keys=True).encode()).hexdigest(),
}
PROOF = {
    'code': 'synthetic+code', 'verifier': 'v' * 43, 'client_id': 'fixture-client',
    'redirect_uri': 'http://127.0.0.1:48761/oauth/capacities/callback', 'resource': 'https://api.capacities.io',
}
CAPTURE = {'contract_version': 1, 'status': 'captured',
           **{name: BINDING[name] for name in oauth.CAPTURE_FIELDS.split()}}


class CapacitiesTransport(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Linux proc executable identity')
    def test_running_elf_excludes_in_place_write_and_outlives_named_replacement(self):
        with tempfile.TemporaryDirectory() as base:
            original = Path(base) / 'original'
            replacement = Path(base) / 'replacement'
            shutil.copy2('/bin/cat', original)
            original_bytes = original.read_bytes()
            self.assertEqual(original_bytes[:4], b'\x7fELF')
            # Some runners ship multiple coreutils names as identical multicall
            # ELF bytes. Build a distinct replacement and keep cat's argv[0].
            replacement.write_bytes(original_bytes + b'\0capacities-replacement-fixture\n')
            replacement.chmod(0o755)
            with subprocess.Popen(['cat'], executable=original, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
                try:
                    with self.assertRaises(OSError) as error:
                        original.open('r+b')
                    self.assertEqual(error.exception.errno, errno.ETXTBSY)
                    os.replace(replacement, original)
                    self.assertEqual(Path(f'/proc/{child.pid}/exe').read_bytes(), original_bytes)
                    self.assertNotEqual(original.read_bytes(), original_bytes)
                    stdout, stderr = child.communicate(b'synthetic-input\n', timeout=3)
                    self.assertEqual((child.returncode, stdout, stderr), (0, b'synthetic-input\n', b''))
                finally:
                    if child.poll() is None:
                        child.kill()

    def test_exec_charges_final_admission_before_first_confidential_byte(self):
        transport = Mock()
        channel = transport.open_session.return_value
        elapsed = 0
        def pre_send():
            nonlocal elapsed
            elapsed = 26.1
        exchange = oauth.Exchange(PROOF, SHA, pre_send)
        channel.recv.return_value = ATTESTATION
        sent = []
        channel.sendall.side_effect = lambda body: sent.append(bytes(body))
        with patch.object(oauth.time, 'monotonic', side_effect=lambda: elapsed):
            with self.assertRaises(oauth.shared.Refusal) as error:
                oauth.actor(transport, 'exchange', BINDING, 60, exchange)
        self.assertEqual(error.exception.status, 'timeout')
        self.assertEqual(elapsed, 26.1)
        channel.exec_command.assert_called_once_with(oauth.EXCHANGE_COMMAND)
        self.assertEqual(sent, [])
        self.assertFalse(exchange.possible)
        channel.close.assert_called_once()

    def test_secret_is_once_in_stdin_and_status_without_eof_is_insufficient(self):
        transport = Mock()
        channel = transport.open_session.return_value
        committed = {'contract_version': 1, 'status': 'committed', **BINDING,
                     'installed_config_sha256': SHA, 'space_id': str(uuid4())}
        data = json.dumps(committed).encode() + b'\n'
        channel.recv.side_effect = [ATTESTATION[:14], ATTESTATION[14:], socket.timeout(), data, b'']
        channel.recv_stderr.side_effect = [b'']
        channel.recv_exit_status.return_value = 0
        seen = []
        channel.sendall.side_effect = lambda body: seen.append(bytes(body))
        pre_send = Mock()
        exchange = oauth.Exchange(PROOF, SHA, pre_send)
        output = oauth.actor(transport, 'exchange', BINDING, time.monotonic() + 60, exchange)
        self.assertEqual(output, committed)
        pre_send.assert_called_once()
        self.assertEqual(channel.recv.call_count, 5)
        self.assertTrue(exchange.possible)
        self.assertEqual(len(seen), 1)
        self.assertEqual(json.loads(seen[0]), {'contract_version': 1, 'selector': 'exchange',
                                              'budget_ms': 30000, 'binding': BINDING, 'proof': PROOF})
        self.assertNotIn(PROOF['code'], channel.exec_command.call_args.args[0])
        channel.shutdown_write.assert_called_once()
        channel.close.assert_called_once()

    def test_same_session_capture_and_usb_guard_precede_secret(self):
        body = {'selector': 'exchange', 'budget_ms': 60000, 'binding': BINDING,
                'executable_sha256': SHA, 'proof': PROOF}
        value = oauth.request(json.dumps(body).encode())
        sftp = Mock()
        transport = Mock()
        deadline = time.monotonic() + 60
        def changed_usb():
            raise oauth.shared.Refusal('cable-lost')
        exchange = oauth.Exchange(PROOF, SHA, changed_usb)
        with patch.object(oauth.shared, 'inspect', return_value={'boot_id': BINDING['boot_id']}), \
             patch.object(oauth, 'installed_metadata', return_value=('same',)), \
             patch.object(oauth, 'actor', return_value=dict(CAPTURE, tablet_id=str(uuid4()))) as call:
            with self.assertRaises(oauth.shared.Refusal):
                oauth.execute(transport, value, deadline, lambda _: sftp, exchange)
            call.assert_called_once()
            self.assertEqual(call.call_args.args[0:2], (transport, 'capture'))
        sftp.close.assert_called_once()

        def fake_actor(session, selector, _binding, _deadline, exchange=None):
            self.assertIs(session, transport)
            if selector == 'capture':
                self.assertIsNone(exchange)
                return CAPTURE
            exchange.pre_send()
            self.fail('a changed USB path must refuse before the send')

        with patch.object(oauth.shared, 'inspect', return_value={'boot_id': BINDING['boot_id']}), \
             patch.object(oauth, 'installed_metadata', return_value=('same',)), \
             patch.object(oauth, 'actor', side_effect=fake_actor):
            with self.assertRaises(oauth.shared.Refusal) as error:
                oauth.execute(transport, value, deadline, lambda _: sftp, exchange)
            self.assertEqual(error.exception.status, 'cable-lost')

    def test_running_executable_refusal_and_partial_send_are_distinguishable(self):
        transport = Mock()
        channel = transport.open_session.return_value
        exchange = oauth.Exchange(PROOF, SHA, Mock())
        channel.recv.return_value = oauth.ATTEST_PREFIX + b'b' * 64 + b'\n'
        with self.assertRaises(ValueError):
            oauth.actor(transport, 'exchange', BINDING, time.monotonic() + 60, exchange)
        self.assertFalse(exchange.possible)
        channel.sendall.assert_not_called()
        self.assertIn('REMARKABLE_BUDDIES_CAPACITIES_ATTEST=1', oauth.EXCHANGE_COMMAND)
        self.assertTrue(oauth.EXCHANGE_COMMAND.endswith('/opt/bin/reader-buddy --capacities-oauth'))

        channel.reset_mock()
        channel.recv.return_value = ATTESTATION
        channel.sendall.side_effect = EOFError()
        with self.assertRaises(EOFError):
            oauth.actor(transport, 'exchange', BINDING, time.monotonic() + 60, exchange)
        self.assertTrue(exchange.possible)
        self.assertEqual(channel.sendall.call_count, 1)

    def test_status_frame_has_no_secret_or_substituted_original(self):
        body = {'selector': 'status', 'budget_ms': 12000, 'binding': BINDING, 'proof': PROOF}
        with self.assertRaises(ValueError):
            oauth.request(json.dumps(body).encode())
        wrong = {'contract_version': 1, 'status': 'staged', **BINDING, 'operation_id': str(uuid4())}
        with self.assertRaises(ValueError):
            oauth.receipt(wrong, 'status', BINDING)
        raw = b'{"selector":"status","selector":"exchange","binding":{}}'
        with self.assertRaises(ValueError):
            oauth.request(raw)
