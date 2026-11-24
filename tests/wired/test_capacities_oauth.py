import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'host'))
import capacities_oauth_transport as oauth
import personalization_transport as launcher

USB = {'fixture': 'wired'}
SHA = 'a' * 64
ATTESTATION = oauth.ATTEST_PREFIX + SHA.encode() + b'\n'
BINDING = {
    'tablet_id': str(uuid4()), 'boot_id': str(uuid4()), 'operation_id': str(uuid4()), 'grant_id': str(uuid4()),
    'config_sha256': 'b' * 64,
    'connection_id': hashlib.sha256(json.dumps(USB, sort_keys=True).encode()).hexdigest(),
}
OBSERVATION = {'boot_id': BINDING['boot_id'], 'service': {'LoadState': 'loaded'}}
PROOF = {
    'code': 'synthetic+code', 'verifier': 'v' * 43, 'client_id': 'fixture-client',
    'redirect_uri': 'http://127.0.0.1:48761/oauth/capacities/callback', 'resource': 'https://api.capacities.io',
}
CAPTURE = {'contract_version': 1, 'status': 'captured',
           **{name: BINDING[name] for name in oauth.CAPTURE_FIELDS.split()}}


class CapacitiesTransport(unittest.TestCase):
    def test_child_stdout_uses_lf_even_with_windows_text_translation(self):
        script = Path(oauth.__file__).resolve()
        translated = (
            'import runpy, sys; sys.stdout.reconfigure(newline="\\r\\n"); '
            'sys.path.insert(0, sys.argv[1]); runpy.run_path(sys.argv[2], run_name="__main__")'
        )
        for args in ([str(script)], ['-c', translated, str(script.parent), str(script)]):
            with self.subTest(args=args):
                child = subprocess.run([sys.executable, '-B', *args], input=b'{}',
                                       capture_output=True, timeout=10, check=True)
                self.assertEqual(child.stderr, b'')
                ready, response, tail = child.stdout.split(b'\n')
                self.assertEqual((ready, tail), (b'capacities-oauth-ready-v1', b''))
                self.assertNotIn(b'\r', child.stdout)
                self.assertEqual(json.loads(response)['status'], 'observation-unavailable')

    def test_capture_uses_the_selected_executable_for_hash_and_actor(self):
        for executable, load_state, parents in [
            (launcher.STANDALONE, 'not-found', ('/opt', '/opt/bin')),
            (launcher.RESIDENT, 'loaded', ('/home', '/home/root', '/home/root/.local',
                                           '/home/root/.local/lib', '/home/root/.local/lib/remarkable-buddies')),
        ]:
            with self.subTest(executable=executable):
                query, digest, actor = Mock(), Mock(), Mock()
                transport, sftp = Mock(), Mock()
                transport.open_session.side_effect = [query, digest, actor]
                digest.recv.side_effect = [f'{SHA}  {executable}\n'.encode('ascii'), b'']
                actor.recv.side_effect = [json.dumps(CAPTURE).encode() + b'\n', b'']
                sent = []
                actor.sendall.side_effect = lambda body: sent.append(json.loads(body))
                for channel in (digest, actor):
                    channel.recv_stderr.return_value = b''
                    channel.exit_status_ready.return_value = True
                    channel.recv_exit_status.return_value = 0
                def lstat(path):
                    self.assertIn(path, (*parents, executable))
                    kind = stat.S_IFREG if path == executable else stat.S_IFDIR
                    return SimpleNamespace(st_mode=kind | 0o755, st_uid=0, st_gid=0, st_size=4096, st_mtime=1)
                sftp.lstat.side_effect = lstat
                launcher_record = (f'{{ path={executable} ; argv[]={executable} ; ignore_errors=no }}'.encode()
                                   if load_state == 'loaded' else b'')
                capture_binding = {k: BINDING[k] for k in ('connection_id', 'boot_id')}
                with patch.object(oauth.shared, 'inspect', return_value=dict(OBSERVATION, service={'LoadState': load_state})), \
                        patch.object(launcher, 'reply', return_value=(0, launcher_record)):
                    result = oauth.execute(transport, {'selector': 'capture', 'binding': capture_binding},
                                           time.monotonic() + 12, lambda _: sftp, None)
                self.assertEqual(result['_capacities_oauth'], CAPTURE)
                self.assertEqual(result['_executable_sha256'], SHA)
                self.assertEqual(sftp.lstat.call_args_list, [call(path) for path in (*parents, executable)] * 3)
                digest.exec_command.assert_called_once_with(
                    f'/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C sha256sum -- {executable}')
                digest.sendall.assert_not_called()
                actor.exec_command.assert_called_once_with(f'{launcher.COMMAND_PREFIX} {executable} --capacities-oauth')
                self.assertEqual(len(sent), 1)
                self.assertNotIn('proof', sent[0])

    def test_resident_ancestor_change_after_attestation_refuses_before_proof(self):
        transport, sftp = Mock(), Mock()
        capture, mutation = Mock(), Mock()
        transport.open_session.side_effect = [capture, mutation]
        capture.recv.side_effect = [json.dumps(CAPTURE).encode() + b'\n', b'']
        capture.recv_stderr.return_value = b''
        capture.exit_status_ready.return_value = True
        capture.recv_exit_status.return_value = 0
        mutation.recv.return_value = ATTESTATION
        exchange = oauth.Exchange(PROOF, SHA, Mock())
        last_checked = '/home/root/.local'
        samples = 0
        def lstat(path):
            nonlocal samples
            if path == last_checked:
                samples += 1
            actor = path == launcher.RESIDENT
            kind = stat.S_IFREG if actor else stat.S_IFDIR
            permissions = 0o775 if path == last_checked and samples == 3 else 0o755
            return SimpleNamespace(st_mode=kind | permissions, st_uid=0, st_gid=0, st_size=4096, st_mtime=1)
        sftp.lstat.side_effect = lstat
        with patch.object(oauth.shared, 'inspect', return_value=dict(OBSERVATION)), \
                patch.object(oauth, 'select_executable', return_value=launcher.RESIDENT), self.assertRaises(ValueError):
            oauth.execute(transport, {'selector': 'exchange', 'binding': BINDING},
                          time.monotonic() + 60, lambda _: sftp, exchange)
        self.assertEqual(samples, 3)
        mutation.recv.assert_called_once()
        mutation.sendall.assert_not_called()
        exchange.pre_send.assert_not_called()
        self.assertFalse(exchange.possible)
        sftp.close.assert_called_once()


    @unittest.skipUnless(sys.platform == 'linux', 'Linux proc executable identity')
    def test_running_elf_excludes_in_place_write_and_outlives_named_replacement(self):
        with tempfile.TemporaryDirectory() as base:
            original = Path(base) / 'original'
            replacement = Path(base) / 'replacement'
            source = Path(base) / 'actor.c'
            source.write_text('#include <unistd.h>\n'
                              'int main(void) { char b[4096]; ssize_t n;\n'
                              'if (write(1,"ready\\n",6)!=6) return 2;\n'
                              'while ((n=read(0,b,sizeof b))>0) { ssize_t at=0;\n'
                              'while (at<n) { ssize_t m=write(1,b+at,n-at);\n'
                              'if(m<=0) return 3; at+=m; }} return n<0; }\n', encoding='ascii')
            compiler = shutil.which('cc')
            self.assertIsNotNone(compiler, 'Linux CI requires its existing native C compiler')
            subprocess.run([compiler, '-O0', '-o', str(original), str(source)],
                           check=True, capture_output=True, timeout=15)
            original_bytes = original.read_bytes()
            self.assertEqual(original_bytes[:4], b'\x7fELF')
            # Do not depend on coreutils multicall dispatch or distro wrappers.
            replacement.write_bytes(original_bytes + b'\0capacities-replacement-fixture\n')
            replacement.chmod(0o755)
            with subprocess.Popen([original], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
                try:
                    self.assertEqual(child.stdout.readline(), b'ready\n')
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
                oauth.actor(transport, 'exchange', BINDING, 60, exchange, executable=launcher.STANDALONE)
        self.assertEqual(error.exception.status, 'timeout')
        self.assertEqual(elapsed, 26.1)
        channel.exec_command.assert_called_once_with(
            f'{launcher.COMMAND_PREFIX} REMARKABLE_BUDDIES_CAPACITIES_ATTEST=1 {launcher.STANDALONE} --capacities-oauth')
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
        output = oauth.actor(transport, 'exchange', BINDING, time.monotonic() + 60, exchange, executable=launcher.STANDALONE)
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
        with patch.object(oauth.shared, 'inspect', return_value=dict(OBSERVATION)), \
             patch.object(oauth, 'select_executable', return_value=launcher.RESIDENT), \
             patch.object(oauth, 'installed_metadata', return_value=('same',)), \
             patch.object(oauth, 'actor', return_value=dict(CAPTURE, tablet_id=str(uuid4()))) as call:
            with self.assertRaises(oauth.shared.Refusal):
                oauth.execute(transport, value, deadline, lambda _: sftp, exchange)
            call.assert_called_once()
            self.assertEqual(call.call_args.args[0:2], (transport, 'capture'))
        sftp.close.assert_called_once()

        def fake_actor(session, selector, _binding, _deadline, exchange=None, *, executable, check_installation=None):
            self.assertIs(session, transport)
            self.assertEqual(executable, launcher.RESIDENT)
            if selector == 'capture':
                self.assertIsNone(exchange)
                return CAPTURE
            check_installation()
            exchange.pre_send()
            self.fail('a changed USB path must refuse before the send')

        with patch.object(oauth.shared, 'inspect', return_value=dict(OBSERVATION)), \
             patch.object(oauth, 'select_executable', return_value=launcher.RESIDENT), \
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
            oauth.actor(transport, 'exchange', BINDING, time.monotonic() + 60, exchange, executable=launcher.STANDALONE)
        self.assertFalse(exchange.possible)
        channel.sendall.assert_not_called()
        command = channel.exec_command.call_args.args[0]
        self.assertIn('REMARKABLE_BUDDIES_CAPACITIES_ATTEST=1', command)
        self.assertTrue(command.endswith('/opt/bin/reader-buddy --capacities-oauth'))

        channel.reset_mock()
        channel.recv.return_value = ATTESTATION
        channel.sendall.side_effect = EOFError()
        with self.assertRaises(EOFError):
            oauth.actor(transport, 'exchange', BINDING, time.monotonic() + 60, exchange, executable=launcher.STANDALONE)
        self.assertTrue(exchange.possible)
        self.assertEqual(channel.sendall.call_count, 1)

    def test_disconnect_attests_running_actor_before_one_exact_stdin_frame(self):
        transport = Mock()
        channel = transport.open_session.return_value
        space = str(uuid4())
        grant = {'space_id': space, 'expected_grant_sha256': 'd' * 64}
        request = {'selector': 'disconnect', 'budget_ms': 60000, 'binding': BINDING,
                   'executable_sha256': SHA, **grant}
        self.assertEqual(oauth.request(json.dumps(request).encode()), request)
        with self.assertRaises(ValueError):
            oauth.request(json.dumps(dict(request, proof=PROOF)).encode())
        receipt = {'contract_version': 1, 'status': 'revoked', **BINDING, 'space_id': space,
                   'phase': 'revoked', 'grant_sha256': SHA, 'observed_operation_id': BINDING['operation_id']}
        output = json.dumps(receipt).encode() + b'\n'
        channel.recv.side_effect = [ATTESTATION, output, b'']
        channel.recv_stderr.return_value = b''
        channel.recv_exit_status.return_value = 0
        sent = []
        channel.sendall.side_effect = lambda body: sent.append(json.loads(body))
        mutation = oauth.Exchange(None, SHA, Mock())
        self.assertEqual(oauth.actor(transport, 'disconnect', BINDING, time.monotonic() + 60,
                                     mutation, grant, executable=launcher.RESIDENT), receipt)
        self.assertEqual(sent, [{'contract_version': 1, 'selector': 'disconnect', 'budget_ms': 30000,
                                 'binding': BINDING, **grant}])
        mutation.pre_send.assert_called_once()
        self.assertTrue(mutation.possible)
        with self.assertRaises(ValueError):
            oauth.receipt(dict(receipt, observed_operation_id=str(uuid4())), 'disconnect', BINDING, space)
        with self.assertRaises(ValueError):
            oauth.receipt(dict(receipt, grant_sha256=None), 'disconnect', BINDING, space)
        with self.assertRaises(ValueError):
            oauth.receipt(dict(receipt, status='observed', grant_sha256=None), 'grant-status', BINDING, space)
        unresolved = dict(receipt, status='unresolved', phase='local-disabled', grant_sha256=None)
        self.assertEqual(oauth.receipt(unresolved, 'disconnect', BINDING, space), unresolved)

    def test_changed_grant_selection_refuses_before_disconnect_actor(self):
        space = str(uuid4())
        value = {'selector': 'disconnect', 'binding': BINDING, 'space_id': space}
        capture = dict(CAPTURE, connection={'space_id': space, 'grant_id': str(uuid4())})
        mutation = oauth.Exchange(None, SHA, Mock())
        with patch.object(oauth.shared, 'inspect', return_value=dict(OBSERVATION)), \
             patch.object(oauth, 'select_executable', return_value=launcher.RESIDENT), \
             patch.object(oauth, 'installed_metadata', return_value=('same',)), \
             patch.object(oauth, 'actor', return_value=capture) as call:
            with self.assertRaises(oauth.shared.Refusal):
                oauth.execute(Mock(), value, time.monotonic() + 60, lambda _: Mock(), mutation)
        call.assert_called_once()
        self.assertEqual(call.call_args.args[1], 'capture-connection')
        self.assertFalse(mutation.possible)

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
