import ctypes
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
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


def inventory_query(rows):
    calls = []
    class Dispatch:
        def __init__(self, kind, value=None): self.kind, self.value = kind, value
        def GetIDsOfNames(self, name): return name
        def QueryInterface(self, interface):
            assert interface == 'enum'
            return self
        def Next(self, count):
            assert count == 1
            return (Dispatch('row', self.value.pop(0)),) if self.value else ()
        def Invoke(self, name, locale, flags, result, *args):
            calls.append((self.kind, name, args))
            assert locale == 0 and result is True
            if self.kind == 'locator' and name == 'ConnectServer':
                assert args == ('.', r'root\StandardCimv2', '', '', '', '', 128)
                return Dispatch('services')
            if self.kind == 'services' and name == 'ExecQuery':
                assert args == ('SELECT ' + ','.join(ADAPTER) + ' FROM MSFT_NetAdapter', 'WQL', 48)
                return Dispatch('objects', [dict(row) for row in rows])
            if self.kind == 'objects' and name == '_NewEnum': return Dispatch('iterator', self.value)
            if self.kind == 'row' and name == 'Properties_': return Dispatch('properties', self.value)
            if self.kind == 'properties' and name == 'Item':
                assert args[1] == 0
                return Dispatch('property', self.value[args[0]])
            if self.kind == 'property' and name == 'Value': return self.value
            raise AssertionError('Unexpected COM operation')
    def create(*args):
        assert args == ('WbemScripting.SWbemLocator', None, 1, 'dispatch')
        calls.append(('create',))
        return Dispatch('locator')
    module = SimpleNamespace(CoCreateInstance=create, CLSCTX_INPROC_SERVER=1, IID_IDispatch='dispatch',
        IID_IEnumVARIANT='enum', DISPATCH_METHOD=1, DISPATCH_PROPERTYGET=2)
    namespace = {'__name__': 'fixture'}
    with patch.dict(sys.modules, pythoncom=module):
        exec(compile(w.INVENTORY, '<fixed-inventory>', 'exec'), namespace)
    return namespace['query'], calls


class WindowsFixtures(unittest.TestCase):
    def test_com_inventory_fresh_exact_query_and_lossless_types(self):
        row = dict(ADAPTER, NetLuid=str(2**64 - 1), PnPDeviceID=None, PermanentAddress=None)
        query, calls = inventory_query([row])
        first = json.loads(query(CONFIG['interface_guid']))
        self.assertEqual(first, dict(row, NetLuid=2**64 - 1))
        self.assertIs(first['Virtual'], False); self.assertIs(first['HardwareInterface'], True)
        row['NetLuid'] = '9007199254740993'
        self.assertEqual(json.loads(query(CONFIG['interface_guid']))['NetLuid'], 9007199254740993)
        self.assertEqual(calls.count(('create',)), 2)

    def test_com_inventory_missing_ambiguous_malformed_and_oversize_refuse(self):
        good = dict(ADAPTER, NetLuid='1234')
        for rows in ([], [good, good], [dict(good, InterfaceGuid=None)]):
            query, _ = inventory_query(rows)
            with self.assertRaises(ValueError): query(CONFIG['interface_guid'])
        for name, value in [('NetLuid', str(2**64)), ('NetLuid', '-1'), ('NetLuid', '01'),
                            ('NetLuid', 1.0), ('NetLuid', True), ('Virtual', 0), ('HardwareInterface', 'true'),
                            ('InterfaceIndex', True), ('MediaConnectState', -1), ('InterfaceOperationalStatus', 2**32),
                            ('PermanentAddress', 'x' * 65536)]:
            query, _ = inventory_query([dict(good, **{name: value})])
            with self.subTest(name=name), self.assertRaises(ValueError): query(CONFIG['interface_guid'])
        query, calls = inventory_query([good])
        with self.assertRaises(ValueError): query("bad' query")
        self.assertEqual(calls, [])

    def test_inventory_child_has_fixed_source_environment_input_and_no_fallback(self):
        good = subprocess.CompletedProcess([], 0, json.dumps(ADAPTER).encode('ascii'), b'')
        with patch.object(w.subprocess, 'CREATE_NO_WINDOW', 0, create=True), patch.object(w.subprocess, 'run', return_value=good) as run:
            self.assertEqual(w.inventory(CONFIG), ADAPTER)
            args, options = run.call_args
            self.assertEqual(args[0], [sys.executable, '-I', '-B', '-c', w.INVENTORY])
            self.assertEqual(options['env']['MANAGER_INTERFACE_GUID'], CONFIG['interface_guid'])
            self.assertNotIn(CONFIG['interface_guid'], args[0][-1])
            self.assertEqual(options['timeout'], 3); self.assertTrue(options['check']); self.assertTrue(options['capture_output'])
        for stdout, stderr in [(b'{}' * w.LIMIT, b''), (b'{}', b'warning'), (b'not-json', b'')]:
            with patch.object(w.subprocess, 'CREATE_NO_WINDOW', 0, create=True), patch.object(w.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout, stderr)) as run:
                with self.assertRaises((o.Refusal, ValueError)): w.inventory(CONFIG)
                run.assert_called_once()
        for failure in (subprocess.TimeoutExpired('fixed', 3), subprocess.CalledProcessError(1, 'fixed')):
            with patch.object(w.subprocess, 'CREATE_NO_WINDOW', 0, create=True), patch.object(w.subprocess, 'run', side_effect=failure) as run:
                with self.assertRaises(type(failure)): w.inventory(CONFIG)
                run.assert_called_once()

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

    def test_owned_inspection_callback_reuses_same_windows_admission_and_notices(self):
        windows = Mock(); notices = Mock()
        notices.changed.is_set.return_value = False
        windows.snapshot.return_value = {'index': 7}
        shared = Mock()
        callback = Mock()
        shared.observe.return_value = {'fixture': True}
        with patch.object(w, 'Windows', return_value=windows), patch.object(w, 'Notifications', return_value=notices):
            self.assertEqual(w.observe(CONFIG, shared, inspection=callback), {'fixture': True})
        self.assertIs(shared.observe.call_args.kwargs['inspection'], callback)
        self.assertIs(shared.observe.call_args.kwargs['notices'], notices)
        notices.close.assert_called_once()

    def test_utf16_instance_capacity_includes_terminator_before_native_copy(self):
        self.assertEqual(len(w.encoded_instance('A' * 199)), 400)
        self.assertEqual(len(w.encoded_instance('A' + '\U0001f600' * 99)), 400)
        for value in ('A' * 200, '\U0001f600' * 100, 'USB\\VID_04B3&PID_4010\\' + '\U0001f600' * 170, 'bad\0id', '\ud800'):
            with self.subTest(length=len(value)), self.assertRaises(o.Refusal): w.encoded_instance(value)
        # Constructor must refuse before opening IP APIs or copying native memory.
        windows = Mock()
        with patch.object(w.C, 'memmove') as copy, self.assertRaises(o.Refusal):
            w.Notifications(windows, dict(CONFIG, usb_instance='\U0001f600' * 170))
        copy.assert_not_called(); self.assertEqual(windows.mock_calls, [])

    def test_abi_layout_and_ipv4(self):
        self.assertEqual(ctypes.sizeof(w.Address), 28)
        self.assertEqual(ctypes.sizeof(w.Prefix), 32)
        self.assertEqual(ctypes.sizeof(w.Route), 104)
        self.assertEqual(w.Route.next_hop.offset, 44)
        self.assertEqual(ctypes.sizeof(w.DeviceFilter), 416)
        self.assertEqual(w.Address.ipv4('10.11.99.2').ip(), '10.11.99.2')


@unittest.skipUnless(sys.platform == 'win32', 'actual Windows APIs')
class WindowsNative(unittest.TestCase):
    def test_actual_inventory_child_timeout_reaps_process_without_device_contact(self):
        children = []
        real_popen = subprocess.Popen
        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs); children.append(child); return child
        with patch.object(w, 'INVENTORY', 'import time; time.sleep(60)'), patch.object(subprocess, 'Popen', side_effect=start):
            with self.assertRaises(subprocess.TimeoutExpired): w.inventory(CONFIG)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())

    def test_actual_inventory_matches_same_provider_nine_fields_without_device_contact(self):
        fields = ','.join(ADAPTER)
        script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter | Select-Object " + fields + ') | ConvertTo-Json -Compress'
        powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        done = subprocess.run([str(powershell), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            capture_output=True, check=True, timeout=3, creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(done.stderr, b'')
        rows = json.loads(done.stdout.decode('utf-8-sig'))
        if isinstance(rows, dict): rows = [rows]
        self.assertGreater(len(rows), 0)
        for row in rows:
            selected = row['InterfaceGuid'].strip('{}').lower()
            observed = w.inventory({'interface_guid': selected})
            # Failure messages contain only field names, never adapter identifiers.
            for name in ADAPTER:
                self.assertTrue(type(observed[name]) is type(row[name]) and observed[name] == row[name], name)

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
        cancelled, real_api = [], w.api
        def tracked(dll, name, args, result=w.U32):
            function = real_api(dll, name, args, result)
            if name == 'CancelMibChangeNotify2':
                def cancel(handle):
                    cancelled.append(handle.value)
                    return function(handle)
                return cancel
            return function
        with patch.object(w, 'api', side_effect=tracked), self.assertRaises(o.Refusal): w.Notifications(windows, CONFIG)
        self.assertEqual(len(cancelled), 3)
        self.assertEqual(len(set(cancelled)), 3)
        self.assertTrue(all(cancelled))
        # Register a present root devnode as an OS API control, never a tablet claim.
        node, instance = w.U32(), ctypes.create_unicode_buffer(200)
        self.assertEqual(windows.locate(ctypes.byref(node), None, 0), 0)
        self.assertEqual(windows.device_id(node, instance, 200, 0), 0)
        n = w.Notifications(windows, dict(CONFIG, usb_instance=instance.value))
        n.close(); n.close()

    def test_actual_private_acl_accepts_owner_only_and_rejects_broad_grant(self):
        import win32api, win32con, win32security as s
        import ntsecuritycon
        token = s.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try: user = s.GetTokenInformation(token, s.TokenUser)[0]
        finally: token.Close()
        import pywintypes, win32file
        with tempfile.TemporaryDirectory() as temp:
            # Stamp ownership at creation; do not require takeover privilege on runner fixtures.
            root = Path(temp).resolve()/'private'
            acl = s.ACL(); acl.AddAccessAllowedAce(s.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, user)
            descriptor = s.SECURITY_DESCRIPTOR()
            descriptor.SetSecurityDescriptorOwner(user, False)
            descriptor.SetSecurityDescriptorDacl(True, acl, False)
            attributes = pywintypes.SECURITY_ATTRIBUTES()
            attributes.SECURITY_DESCRIPTOR = descriptor
            win32file.CreateDirectory(str(root), attributes)
            p = root/'config'
            handle = win32file.CreateFile(str(p), win32con.GENERIC_WRITE, 0, attributes,
                win32con.CREATE_NEW, win32con.FILE_ATTRIBUTE_NORMAL, None)
            try: win32file.WriteFile(handle, b'private')
            finally: handle.Close()
            for item in (str(root), str(p)):
                s.SetNamedSecurityInfo(item, s.SE_FILE_OBJECT,
                    s.DACL_SECURITY_INFORMATION | s.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
                self.assertEqual(s.GetNamedSecurityInfo(item, s.SE_FILE_OBJECT, s.OWNER_SECURITY_INFORMATION).GetSecurityDescriptorOwner(), user)
            self.assertEqual(w.private_bytes(p, parent_private=True), b'private')
            acl.AddAccessAllowedAce(s.ACL_REVISION, ntsecuritycon.FILE_GENERIC_READ, s.ConvertStringSidToSid('S-1-1-0'))
            s.SetNamedSecurityInfo(str(p), s.SE_FILE_OBJECT, s.DACL_SECURITY_INFORMATION | s.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
            with self.assertRaises(o.Refusal): w.private_bytes(p, parent_private=True)
