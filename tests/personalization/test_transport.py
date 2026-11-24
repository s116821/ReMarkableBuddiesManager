"""Owned actual Paramiko channel tests; synthetic CLI reports are not Buddy/USB qualification."""
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
import unittest
from unittest.mock import Mock, patch

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root/'host'))
sys.path.insert(0, str(root/'tests/wired'))
import personalization_transport as p
import wired_observer as o
from test_observer import Peer, Files
import paramiko

TEXT = '  first\r\n第二行 🦊\n\t '
BOOT = '11111111-1111-1111-1111-111111111111'
BASELINE = {'generation': 1}
IDENTITY = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()
LEGACY = '/opt/bin/reader-buddy'
PACKAGED = '/home/root/.local/lib/remarkable-buddies/reader-buddy'
QUERY = 'systemctl show --no-pager --property=ExecStart --value reader-buddy.service'
ENV = ('/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin '
       'REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json')

class Notice:
    def recv(self, _):
        time.sleep(.01)
        raise socket.timeout()
    def close(self):
        pass

class PreferencePeer(Peer):
    def __init__(self, operation, code, launcher):
        super().__init__()
        self.operation, self.code, self.received = operation, code, None
        self.launcher = launcher
        self.expected_command = f'{ENV} {launcher or LEGACY} --personalization-operation {operation}'

    def check_channel_exec_request(self, channel, command):
        command = command.decode()
        self.commands.append(command)
        if command in (o.COMMAND, QUERY):
            if command == o.COMMAND:
                state = 'loaded' if self.launcher else 'not-found'
                output = f'armv7l\nLoadState={state}\nActiveState=active\nSubState=running\n'
            elif self.launcher:
                output = (f'{{ path={self.launcher} ; argv[]={self.launcher} ; ignore_errors=no ; '
                          'start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n')
            else:
                output = ''
            def respond():
                if output:
                    channel.sendall(output.encode())
                channel.send_exit_status(0)
                channel.shutdown_write()
            threading.Thread(target=respond, daemon=True).start()
            return True
        if command != self.expected_command:
            return False
        def send():
            raw = bytearray()
            while True:
                part = channel.recv(4096)
                if not part:
                    break
                raw.extend(part)
            self.received = json.loads(raw) if raw else None
            report = {'report_version': 1, 'operation': self.operation, 'status': 'ok', 'disk_reload_verified': True,
                      'runtime_activation': 'unverified' if self.operation == 'inspect' else 'restart-required',
                      'config_sha256': 'c'*64, 'personalization': {'schema_version': 1,
                      'enabled': self.operation not in ('disable', 'clear'), 'text': '' if self.operation == 'clear' else TEXT}}
            channel.sendall(json.dumps(report).encode() if self.code == 0 else b'PRIVATE_STDOUT_SENTINEL')
            channel.send_stderr(b'PRIVATE_STDERR_SENTINEL'); channel.send_exit_status(self.code); channel.shutdown_write()
        threading.Thread(target=send, daemon=True).start()
        return True

class Transport(unittest.TestCase):
    def request(self, operation='set'):
        value = {'operation': operation, 'connection_id': IDENTITY, 'boot_id': BOOT}
        if operation != 'inspect': value['expected_config_sha256'] = 'c'*64
        if operation == 'set': value.update(enabled=True, text=TEXT)
        return value
    def test_request_exact_utf8_caps_duplicate_fields_no_nul_and_sanitized_child_refusal(self):
        good = self.request(); self.assertEqual(p.request(json.dumps(good).encode())['text'], TEXT)
        for bad in [dict(good, text='\0'), dict(good, text='🦊'*4097), dict(good, path='/arbitrary'), dict(good, enabled=1)]:
            with self.assertRaises(ValueError): p.request(json.dumps(bad).encode())
        with self.assertRaises(ValueError): p.request(b'{"operation":"inspect","operation":"set"}')
        with self.assertRaises(ValueError): p.request(b'x'*(p.MAX_IO+1))
        child = subprocess.run([sys.executable, str(root/'host/personalization_transport.py')], input=b'{"text":"PRIVATE_INPUT_SENTINEL"}', capture_output=True, timeout=5)
        self.assertEqual(child.stderr, b''); self.assertNotIn(b'PRIVATE_INPUT_SENTINEL', child.stdout)
        self.assertEqual(json.loads(child.stdout)['personalization']['outcome'], 'not-dispatched')
    def test_wrong_connection_refuses_before_dial_or_auth(self):
        dial = Mock()
        with self.assertRaises(o.Refusal): o.observe({}, snapshot=lambda _: BASELINE, dial=dial, expected_connection='0'*64)
        dial.assert_not_called()
    def test_wrong_boot_refuses_before_personalization_channel_or_dispatch(self):
        transport = Mock(); progress = {'dispatched': False}
        with patch.object(p.shared, 'inspect', return_value={'boot_id': '22222222-2222-2222-2222-222222222222'}):
            with self.assertRaises(o.Refusal): p.execute(transport, self.request(), progress)
        transport.open_session.assert_not_called(); self.assertFalse(progress['dispatched'])
    def test_launcher_probe_errors_and_ambiguous_units_refuse(self):
        record = lambda path, argv: f'{{ path={path} ; argv[]={argv} ; ignore_errors=no }}'.encode()
        for code, raw in [
            (1, record(PACKAGED, PACKAGED)),
            (0, b''),
            (0, record(PACKAGED, LEGACY)),
            (0, record(PACKAGED, f'{PACKAGED} --other-mode')),
            (0, record(PACKAGED, PACKAGED) + b'\n' + record(LEGACY, LEGACY)),
        ]:
            with self.subTest(code=code, raw=raw):
                transport = Mock()
                with patch.object(p, 'reply', return_value=(code, raw)):
                    with self.assertRaisesRegex(o.Refusal, 'observation-unavailable'):
                        p.select_executable(transport, 'loaded')
                channel = transport.open_session.return_value
                channel.exec_command.assert_called_once_with(QUERY)
                channel.close.assert_called_once()

    @unittest.skipUnless(sys.platform == 'linux', 'Owned POSIX socket/private-key fixture; not native Windows qualification')
    def test_actual_ssh_fixed_command_exact_stdin_and_unknown_older_cli(self):
        cases = [
            ('inspect', 0, None), ('inspect', 0, LEGACY), ('inspect', 0, PACKAGED),
            ('set', 0, PACKAGED), ('disable', 0, LEGACY), ('clear', 0, LEGACY),
            ('set', 2, PACKAGED), ('set', 127, PACKAGED), ('set', 0, '/tmp/reader-buddy'),
        ]
        for operation, code, launcher in cases:
            with self.subTest(operation=operation, code=code, launcher=launcher), tempfile.TemporaryDirectory() as folder:
                key = paramiko.RSAKey.generate(2048); keypath = Path(folder)/'identity'; key.write_private_key_file(str(keypath)); keypath.chmod(0o600)
                hostkey = paramiko.RSAKey.generate(2048); client, server = socket.socketpair(); peer = PreferencePeer(operation, code, launcher)
                transport = paramiko.Transport(server); transport.add_server_key(hostkey); transport.set_subsystem_handler('sftp',paramiko.SFTPServer,Files)
                transport.start_server(event=threading.Event(),server=peer)
                progress = {'dispatched':False}
                try:
                    def observe():
                        return o.observe({'host_key_sha256':o.fingerprint(hostkey),'identity_file':str(keypath)},snapshot=lambda _:BASELINE,dial=lambda _:client,
                            notices=Notice(),expected_connection=IDENTITY,inspection=lambda t:p.execute(t,self.request(operation),progress))
                    if launcher not in (None, LEGACY, PACKAGED):
                        with self.assertRaises(o.Refusal):
                            observe()
                        self.assertFalse(progress['dispatched'])
                        self.assertEqual(peer.commands, [o.COMMAND, QUERY])
                        self.assertIsNone(peer.received)
                        continue
                    observed = observe()
                    receipt = observed['_personalization']; self.assertTrue(progress['dispatched'])
                    self.assertEqual(peer.commands,[o.COMMAND, QUERY, peer.expected_command, o.COMMAND])
                    self.assertNotIn(TEXT,repr(peer.commands)); self.assertNotIn('PRIVATE_',json.dumps(observed))
                    if operation=='set': self.assertEqual(peer.received,{'contract_version':1,'expected_config_sha256':'c'*64,'enabled':True,'text':TEXT})
                    elif operation=='inspect': self.assertIsNone(peer.received)
                    else: self.assertEqual(peer.received,{'contract_version':1,'expected_config_sha256':'c'*64})
                    self.assertEqual(receipt['outcome'],'read-only' if operation=='inspect' else 'unknown' if code else 'verified')
                    if code: self.assertIsNone(receipt['report']); self.assertEqual(receipt['status'],'unsupported')
                finally:
                    transport.close(); server.close(); client.close()

if __name__=='__main__': unittest.main()
