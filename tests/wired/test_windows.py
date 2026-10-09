import ctypes
import importlib.util
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

HOST = Path(__file__).resolve().parents[2] / 'host'
sys.path.insert(0, str(HOST))
import wired_observer as o
import windows_wired as w

CONFIG = {'interface_guid': '11111111-1111-1111-1111-111111111111',
    'usb_instance': r'USB\VID_04B3&PID_4010\SELECTED', 'usb_vendor': '04b3', 'usb_product': '4010', 'source_address': '10.11.99.2'}
ADAPTER = {'InterfaceGuid': '{11111111-1111-1111-1111-111111111111}', 'InterfaceIndex': 7, 'NetLuid': 1234,
    'PnPDeviceID': r'USB\VID_04B3&PID_4010&MI_00\INTERFACE', 'Virtual': False, 'HardwareInterface': True,
    'InterfaceOperationalStatus': 1, 'MediaConnectState': 1, 'PermanentAddress': '001122334455'}
ANCESTRY = [(1, ADAPTER['PnPDeviceID'], 8, 0), (2, CONFIG['usb_instance'], 8, 0)]
ROUTE = {'index': 7, 'luid': 1234, 'source': '10.11.99.2', 'next_hop': '0.0.0.0',
    'prefix': '10.11.99.0', 'prefix_length': 24, 'metric': 10, 'protocol': 2, 'loopback': False}


class WindowsFixtures(unittest.TestCase):
    def test_snapshot_refuses_wireless_ambiguous_identity_down_and_gateway(self):
        good = w.validate_snapshot(CONFIG, ADAPTER, ANCESTRY, ROUTE, ROUTE)
        for field, value in [('Virtual', True), ('HardwareInterface', False), ('MediaConnectState', 2),
                             ('InterfaceOperationalStatus', 2), ('InterfaceGuid', '22222222-2222-2222-2222-222222222222'), ('PermanentAddress', None)]:
            with self.subTest(field=field), self.assertRaises(o.Refusal):
                w.validate_snapshot(CONFIG, dict(ADAPTER, **{field: value}), ANCESTRY, ROUTE, ROUTE)
        for field, value in [('index', 8), ('luid', 4321), ('source', '10.11.99.3'), ('next_hop', '10.11.99.254'), ('prefix', '192.168.0.0'), ('prefix_length', 0), ('loopback', True)]:
            for position in (0, 1):
                routes = [ROUTE, ROUTE]; routes[position] = dict(ROUTE, **{field: value})
                with self.subTest(field=field, position=position), self.assertRaises(o.Refusal):
                    w.validate_snapshot(CONFIG, ADAPTER, ANCESTRY, *routes)
        for nodes in ([], [(2, r'USB\VID_04B3&PID_4010\OTHER', 8, 0)]):
            with self.assertRaises(o.Refusal): w.validate_snapshot(CONFIG, ADAPTER, nodes, ROUTE, ROUTE)
        self.assertNotEqual(good, w.validate_snapshot(CONFIG, ADAPTER, [(9, *ANCESTRY[0][1:]), ANCESTRY[1]], ROUTE, ROUTE))

    def test_socket_requires_network_order_set_host_order_get_before_source_connect(self):
        sock = Mock(); sock.getsockopt.return_value = 7
        sock.getsockname.return_value = ('10.11.99.2', 99); sock.getpeername.return_value = ('10.11.99.1', 22)
        with patch.object(w.socket, 'socket', return_value=sock):
            self.assertIs(w.bound_socket(CONFIG, {'index': 7}), sock)
        sock.setsockopt.assert_called_once_with(socket.IPPROTO_IP, 31, socket.htonl(7))
        names = [call[0] for call in sock.method_calls]
        self.assertLess(names.index('getsockopt'), names.index('bind')); self.assertLess(names.index('bind'), names.index('connect'))
        for readback in (0, 8, socket.htonl(7)):
            sock.reset_mock(); sock.getsockopt.return_value = readback
            with patch.object(w.socket, 'socket', return_value=sock), self.assertRaises(o.Refusal): w.bound_socket(CONFIG, {'index': 7})
            sock.bind.assert_not_called(); sock.connect.assert_not_called(); sock.close.assert_called_once()
        sock.reset_mock(); sock.setsockopt.side_effect = OSError('unsupported')
        with patch.object(w.socket, 'socket', return_value=sock), self.assertRaises(o.Refusal) as failure: w.bound_socket(CONFIG, {'index': 7})
        self.assertEqual(failure.exception.status, 'unsupported-host'); sock.connect.assert_not_called()

    def test_notification_latched_readd_closes_owned_socket(self):
        n = w.Notifications.__new__(w.Notifications)
        n.changed, n.sock, n.lock = threading.Event(), None, threading.Lock()
        sock = Mock(); n.attach(sock); n.invalidate()
        sock.close.assert_called_once()
        self.assertTrue(n.changed.is_set())
        with self.assertRaises(OSError): n.recv(1)
        with self.assertRaises(o.Refusal): n.attach(Mock())

    def test_pre_dial_generation_change_never_connects_or_authenticates(self):
        windows = Mock()
        windows.snapshot.side_effect = [{'index': 7}, {'index': 8}]
        notices = Mock(); notices.changed.is_set.return_value = False
        with patch.object(w, 'Windows', return_value=windows), patch.object(w, 'Notifications', return_value=notices), patch.object(w, 'bound_socket') as dial, self.assertRaises(o.Refusal):
            w.observe(CONFIG, o)
        dial.assert_not_called(); notices.close.assert_called_once()

    def test_abi_layout_and_ipv4(self):
        self.assertEqual(ctypes.sizeof(w.Address), 28)
        self.assertEqual(ctypes.sizeof(w.Prefix), 32)
        self.assertEqual(ctypes.sizeof(w.Route), 104)
        self.assertEqual(w.Route.next_hop.offset, 44)
        self.assertEqual(ctypes.sizeof(w.DeviceFilter), 416)
        self.assertEqual(w.Address.ipv4('10.11.99.2').ip(), '10.11.99.2')


@unittest.skipUnless(sys.platform == 'win32', 'actual Windows APIs')
class WindowsNative(unittest.TestCase):
    def test_actual_interface_option_roundtrip_without_tablet_connection(self):
        # The real OS loopback index, not a hardcoded fixture index.
        windows = w.Windows()
        route, source, destination = w.Route(), w.Address(), w.Address.ipv4('127.0.0.1')
        self.assertEqual(windows.best(None, 0, None, ctypes.byref(destination), 0, ctypes.byref(route), ctypes.byref(source)), 0)
        index = route.index
        self.assertGreater(index, 0)
        self.assertEqual(source.ip(), '127.0.0.1')
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.IPPROTO_IP, 31, socket.htonl(index))
            self.assertEqual(sock.getsockopt(socket.IPPROTO_IP, 31), index)
            sock.bind(('127.0.0.1', 0))
            self.assertEqual(sock.getsockname()[0], '127.0.0.1')
        finally: sock.close()

    def test_actual_missing_device_refuses_and_notifications_register_cleanup(self):
        windows = w.Windows()
        with self.assertRaises(o.Refusal): windows.ancestry(CONFIG['usb_instance'])
        # IP notification ABI/control; selected nonexistent PnP registration may refuse.
        n = w.Notifications(windows, CONFIG)
        n.close(); n.close()

    def test_actual_private_acl_accepts_owner_only_and_rejects_broad_grant(self):
        import win32api, win32con, win32security as s
        token = s.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try: user = s.GetTokenInformation(token, s.TokenUser)[0]
        finally: token.Close()
        with tempfile.TemporaryDirectory() as root:
            p = Path(root)/'config'; p.write_bytes(b'private')
            for item in (root, str(p)):
                acl = s.ACL(); acl.AddAccessAllowedAce(s.ACL_REVISION, win32con.FILE_ALL_ACCESS, user)
                s.SetNamedSecurityInfo(item, s.SE_FILE_OBJECT, s.DACL_SECURITY_INFORMATION | s.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
            self.assertEqual(w.private_bytes(p, parent_private=True), b'private')
            acl.AddAccessAllowedAce(s.ACL_REVISION, win32con.FILE_GENERIC_READ, s.ConvertStringSidToSid('S-1-1-0'))
            s.SetNamedSecurityInfo(str(p), s.SE_FILE_OBJECT, s.DACL_SECURITY_INFORMATION | s.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
            with self.assertRaises(o.Refusal): w.private_bytes(p, parent_private=True)
