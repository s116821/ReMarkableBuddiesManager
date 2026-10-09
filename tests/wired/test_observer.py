import importlib.util
import io
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import paramiko

spec = importlib.util.spec_from_file_location('observer', Path(__file__).resolve().parents[2] / 'host/wired_observer.py')
o = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o)

FILES = {'/sys/devices/soc0/machine': b'reMarkable 1.0\n', '/etc/os-release': b'IMG_VERSION="3.28.0.172"\n',
         '/usr/share/remarkable/update.conf': b'RELEASE_VERSION=3.28.0.172\n',
         '/proc/sys/kernel/random/boot_id': b'11111111-1111-1111-1111-111111111111\n'}


class Peer(paramiko.ServerInterface):
    def __init__(self):
        self.auth = 0
        self.commands = []
        self.opens = []

    def check_auth_publickey(self, username, key):
        self.auth += 1
        return paramiko.AUTH_SUCCESSFUL if username == 'root' else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        self.commands.append(command.decode())
        if command.decode() != o.COMMAND:
            return False
        def send():
            channel.send(b'armv7l\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n')
            channel.send_exit_status(0)
            channel.shutdown_write()
        threading.Thread(target=send, daemon=True).start()
        return True


class Files(paramiko.SFTPServerInterface):
    def __init__(self, server, *args, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.peer = server

    def stat(self, path):
        if path not in FILES:
            return paramiko.SFTP_NO_SUCH_FILE
        attr = paramiko.SFTPAttributes()
        attr.st_mode = stat.S_IFREG | 0o444
        attr.st_size = len(FILES[path])
        attr.st_mtime = 1
        return attr

    lstat = stat

    def open(self, path, flags, attr):
        self.peer.opens.append((path, flags))
        if path not in FILES or flags != os.O_RDONLY:
            return paramiko.SFTP_PERMISSION_DENIED
        handle = paramiko.SFTPHandle(flags)
        handle.readfile = io.BytesIO(FILES[path])
        return handle


class ObserverTests(unittest.TestCase):
    def test_route_refuses_gateway_wrong_interface_source_and_ambiguity(self):
        good = {'dev': 'usb0', 'prefsrc': '10.11.99.2'}
        o.validate_route([good], 'usb0', '10.11.99.2')
        # Actual iproute2 constrained lookup reports the selected source as 'from'.
        o.validate_route([{'dev': 'usb0', 'from': '10.11.99.2'}], 'usb0', '10.11.99.2')
        for route in [[], [good, good], [dict(good, dev='wifi0')], [dict(good, gateway='10.11.99.3')], [dict(good, prefsrc='10.11.99.4')]]:
            with self.subTest(route=route), self.assertRaises(o.Refusal):
                o.validate_route(route, 'usb0', '10.11.99.2')

    def test_socket_binds_device_and_source_before_fixed_connect(self):
        sock = Mock()
        sock.getsockopt.return_value = b'usb0\0'
        sock.getsockname.return_value = ('10.11.99.2', 333)
        sock.getpeername.return_value = ('10.11.99.1', 22)
        with patch.object(o.socket, 'socket', return_value=sock):
            self.assertIs(o.bound_socket({'interface': 'usb0', 'source_address': '10.11.99.2'}), sock)
        names = [c[0] for c in sock.method_calls]
        self.assertLess(names.index('setsockopt'), names.index('bind'))
        self.assertLess(names.index('bind'), names.index('connect'))
        sock.connect.assert_called_once_with(('10.11.99.1', 22))
        sock.getsockopt.return_value = b'wifi0\0'
        with patch.object(o.socket, 'socket', return_value=sock), self.assertRaises(o.Refusal):
            o.bound_socket({'interface': 'usb0', 'source_address': '10.11.99.2'})
        sock.close.assert_called_once()

    def test_protected_config_refuses_mode_symlink_and_extra_fields(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'config.json'
            path.write_text('{}')
            path.chmod(0o600)
            with self.assertRaises(o.Refusal): o.load_config(path)
            path.chmod(0o644)
            with self.assertRaises(o.Refusal): o.private_bytes(path)
            alias = Path(root) / 'alias'
            alias.symlink_to(path)
            with self.assertRaises(o.Refusal): o.private_bytes(alias)

    def test_sftp_refuses_symlink_oversize_truncation_and_changed_snapshot(self):
        for size, mode, content, changed in [(3, stat.S_IFLNK, b'abc', False), (9999, stat.S_IFREG, b'abc', False),
                                            (4, stat.S_IFREG, b'abc', False), (3, stat.S_IFREG, b'abc', True)]:
            first = Mock(st_mode=mode, st_size=size, st_mtime=1)
            second = Mock(st_mode=mode, st_size=size, st_mtime=2 if changed else 1)
            sftp = Mock()
            sftp.lstat.side_effect = [first, second]
            sftp.open.return_value = io.BytesIO(content)
            with self.subTest(size=size, mode=mode, changed=changed), self.assertRaises(o.Refusal):
                o.Reads(sftp).file('/fixed')

    def test_fixed_sysfs_size_and_os_release_alias(self):
        sftp = Mock()
        attribute = Mock(st_mode=stat.S_IFREG, st_size=4096, st_mtime=1)
        sftp.lstat.return_value = attribute
        sftp.open.return_value = io.BytesIO(b'reMarkable 1.0\n')
        self.assertEqual(o.Reads(sftp).file('/sys/devices/soc0/machine'), 'reMarkable 1.0')
        alias = Mock(st_mode=stat.S_IFLNK, st_size=21, st_mtime=1)
        text = b'IMG_VERSION="3.28.0.172"\n'
        regular = Mock(st_mode=stat.S_IFREG, st_size=len(text), st_mtime=1)
        sftp.lstat.side_effect = [alias, regular, regular, alias]
        sftp.readlink.return_value = '../usr/lib/os-release'
        sftp.open.return_value = io.BytesIO(text)
        self.assertEqual(o.Reads(sftp).os_release(), text.decode().strip())
        sftp.open.assert_called_with('/usr/lib/os-release', 'rb')
        for target in ('/secret', '../root/secret'):
            sftp.lstat.side_effect = None
            sftp.lstat.return_value = alias
            sftp.readlink.return_value = target
            with self.assertRaises(o.Refusal): o.Reads(sftp).os_release()
        sftp.lstat.side_effect = [alias, regular, regular, alias]
        sftp.readlink.side_effect = ['../usr/lib/os-release', '/usr/lib/os-release']
        sftp.open.return_value = io.BytesIO(text)
        with self.assertRaises(o.Refusal): o.Reads(sftp).os_release()

    @unittest.skipUnless(os.name == 'posix' and hasattr(socket, 'AF_NETLINK'), 'Linux observer')
    def test_actual_ssh_peer_trust_precedes_auth_and_only_fixed_read_operations(self):
        for trusted in (False, True):
            with self.subTest(trusted=trusted), tempfile.TemporaryDirectory() as root:
                key = paramiko.RSAKey.generate(2048)
                keypath = Path(root) / 'identity'
                key.write_private_key_file(str(keypath))
                keypath.chmod(0o600)
                hostkey = paramiko.RSAKey.generate(2048)
                client, server = socket.socketpair()
                peer = Peer()
                transport = paramiko.Transport(server)
                transport.add_server_key(hostkey)
                transport.set_subsystem_handler('sftp', paramiko.SFTPServer, Files)
                ready = threading.Event()
                transport.start_server(event=ready, server=peer)
                config = {'host_key_sha256': o.fingerprint(hostkey) if trusted else 'SHA256:' + 'A' * 43,
                          'identity_file': str(keypath)}
                try:
                    if trusted:
                        result = o.observe(config, snapshot=lambda _: {'generation': 1}, dial=lambda _: client)
                        self.assertEqual(result['model'], 'reMarkable 1.0')
                        self.assertEqual(result['firmware'], '3.28.0.172')
                        self.assertEqual(result['service']['LoadState'], 'not-found')
                        self.assertIsNone(result['installed_version'])
                        self.assertEqual(peer.commands, [o.COMMAND])
                        self.assertTrue(peer.opens)
                        self.assertTrue(all(p in FILES and f == os.O_RDONLY for p, f in peer.opens))
                        self.assertEqual(peer.auth, 1)
                    else:
                        with self.assertRaises(o.Refusal) as refusal:
                            o.observe(config, snapshot=lambda _: {'generation': 1}, dial=lambda _: client)
                        self.assertEqual(refusal.exception.status, 'untrusted')
                        self.assertEqual(peer.auth, 0)
                        self.assertEqual(peer.opens, [])
                finally:
                    transport.close()
                    server.close()
                    client.close()

    def test_usb_ancestry_generation_and_route_fixture_refusals(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            usb = root / 'devices/usb3/3-5'
            device = usb / '3-5:1.0'
            net = root / 'class/net/usb0'
            device.mkdir(parents=True); net.mkdir(parents=True)
            (device / 'driver').symlink_to(device, target_is_directory=True)
            (net / 'device').symlink_to(device, target_is_directory=True)
            for name, value in {'carrier': '1', 'ifindex': '7', 'address': 'aa:bb:cc:dd:ee:ff'}.items(): (net / name).write_text(value)
            (usb / 'idVendor').write_text('1234'); (usb / 'idProduct').write_text('5678')
            config = {'interface': 'usb0', 'usb_path': str(usb), 'usb_vendor': '1234', 'usb_product': '5678', 'source_address': '10.11.99.2'}
            address = [{'flags': ['UP'], 'addr_info': [{'local': '10.11.99.2', 'family': 'inet'}]}]
            route = [{'dev': 'usb0', 'prefsrc': '10.11.99.2'}]
            with patch.object(o, 'ip_json', side_effect=lambda args: address if args[0] == 'address' else route):
                before = o.wired_snapshot(config, root / 'class/net')
                (net / 'ifindex').write_text('8')
                self.assertNotEqual(before, o.wired_snapshot(config, root / 'class/net'))
                (usb / 'idProduct').write_text('9999')
                with self.assertRaises(o.Refusal): o.wired_snapshot(config, root / 'class/net')
                (usb / 'idProduct').write_text('5678')
                (net / 'carrier').write_text('0')
                with self.assertRaises(o.Refusal): o.wired_snapshot(config, root / 'class/net')

    def test_changed_identity_after_dial_refuses_before_ssh(self):
        sock = Mock()
        with self.assertRaises(o.Refusal) as refusal:
            o.observe({}, snapshot=Mock(side_effect=[{'index': 1}, {'index': 2}]), dial=lambda _: sock)
        self.assertEqual(refusal.exception.status, 'cable-lost')
        sock.close.assert_called_once()

    @unittest.skipUnless(hasattr(socket, 'AF_NETLINK'), 'Linux observer')
    def test_watcher_invalidates_active_authenticated_read_before_result(self):
        changed = threading.Event()
        checked = threading.Event()
        sock, transport = Mock(), Mock()
        def snapshot(_):
            if changed.is_set():
                checked.set()
                return {'generation': 2}
            return {'generation': 1}
        def inspection(_):
            changed.set()
            self.assertTrue(checked.wait(1.5), 'watcher must detect identity change during read')
            return {'model': 'stale'}
        with patch.object(paramiko, 'Transport', return_value=transport), patch.object(o, 'accept_key'), patch.object(o, 'read_key'), self.assertRaises(o.Refusal) as refusal:
            o.observe({}, snapshot=snapshot, dial=lambda _: sock, inspection=inspection)
        self.assertEqual(refusal.exception.status, 'cable-lost')
        transport.auth_publickey.assert_called_once()
        self.assertTrue(sock.close.called)
        transport.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
