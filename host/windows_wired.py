"""Windows-only identity/security/binding boundary; no arbitrary remote operations."""
import ctypes as C
from ctypes import wintypes as W
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import threading
import uuid

from wired_observer import Refusal, PEER, LIMIT

U32, U16, U8, U64 = C.c_uint32, C.c_uint16, C.c_uint8, C.c_uint64


class Address(C.Union):
    _fields_ = [('bytes', U8 * 28), ('alignment', U32)]

    @classmethod
    def ipv4(cls, text):
        value = cls()
        raw = struct.pack('<H', socket.AF_INET) + b'\0\0' + socket.inet_aton(text)
        C.memmove(C.addressof(value), raw, len(raw))
        return value

    def ip(self):
        if bytes(self.bytes[:2]) != struct.pack('<H', socket.AF_INET):
            raise Refusal('disconnected')
        return socket.inet_ntoa(bytes(self.bytes[4:8]))


class Prefix(C.Structure):
    _fields_ = [('address', Address), ('length', U8)]


class Route(C.Structure):
    _fields_ = [('luid', U64), ('index', U32), ('destination', Prefix),
                ('next_hop', Address), ('site_prefix', U8), ('valid_lifetime', U32),
                ('preferred_lifetime', U32), ('metric', U32), ('protocol', U32),
                ('loopback', U8), ('autoconfigure', U8), ('publish', U8), ('immortal', U8),
                ('age', U32), ('origin', U32)]


class DeviceFilter(C.Structure):
    # CM_NOTIFY_FILTER union's largest member is WCHAR InstanceId[200].
    _fields_ = [('size', U32), ('flags', U32), ('kind', U32), ('reserved', U32),
                ('instance', U16 * 200)]


def api(dll, name, arguments, result=U32):
    fn = getattr(dll, name)
    fn.argtypes, fn.restype = arguments, result
    return fn


def private_bytes(path, parent_private=False, maximum=16384):
    import win32api
    import win32con
    import win32file
    import win32security as security
    path = Path(path)
    if ':' in str(path)[2:] or not path.is_absolute() or str(path).startswith('\\\\') or str(path.resolve()).casefold() != str(path).casefold():
        raise Refusal('unconfigured')
    # Hold every directory against rename; reject junctions/reparse components.
    token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        user = security.GetTokenInformation(token, security.TokenUser)[0]
    finally:
        token.Close()
    allowed = {security.ConvertSidToStringSid(user), 'S-1-5-18', 'S-1-5-32-544'}
    handles = []
    try:
        for item in reversed((path, *path.parents)):
            attrs = win32file.GetFileAttributes(str(item))
            if attrs & win32con.FILE_ATTRIBUTE_REPARSE_POINT:
                raise Refusal('unconfigured')
            directory = bool(attrs & win32con.FILE_ATTRIBUTE_DIRECTORY)
            if directory != (item != path):
                raise Refusal('unconfigured')
            handle = win32file.CreateFile(str(item), win32con.READ_CONTROL | (0 if directory else win32con.GENERIC_READ),
                win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE if directory else 0, None,
                win32con.OPEN_EXISTING, win32con.FILE_FLAG_OPEN_REPARSE_POINT | win32con.FILE_FLAG_BACKUP_SEMANTICS, None)
            handles.append(handle)
            info = win32file.GetFileInformationByHandle(handle)
            if info[0] & win32con.FILE_ATTRIBUTE_REPARSE_POINT:
                raise Refusal('unconfigured')
            if item == path or (parent_private and item == path.parent):
                sd = security.GetSecurityInfo(handle, security.SE_FILE_OBJECT,
                    security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION)
                acl = sd.GetSecurityDescriptorDacl()
                if sd.GetSecurityDescriptorOwner() != user or acl is None:
                    raise Refusal('unconfigured')
                for index in range(acl.GetAceCount()):
                    ace = acl.GetAce(index)
                    kind = ace[0][0]
                    if kind not in (security.ACCESS_ALLOWED_ACE_TYPE, security.ACCESS_DENIED_ACE_TYPE):
                        raise Refusal('unconfigured')
                    if kind == security.ACCESS_ALLOWED_ACE_TYPE and ace[1] and security.ConvertSidToStringSid(ace[2]) not in allowed:
                        raise Refusal('unconfigured')
        if win32file.GetFileSize(handles[-1]) > maximum:
            raise Refusal('unconfigured')
        data = win32file.ReadFile(handles[-1], maximum + 1)[1]
        if len(data) > maximum:
            raise Refusal('unconfigured')
        return data
    finally:
        for handle in reversed(handles):
            handle.Close()


def load_config(path):
    config = json.loads(private_bytes(path, parent_private=True))
    fields = {'contract_version', 'interface_guid', 'usb_instance', 'usb_vendor', 'usb_product',
              'source_address', 'host_key_sha256', 'identity_file'}
    if not isinstance(config, dict) or set(config) != fields or config['contract_version'] != 1 or any(not isinstance(config[k], str) for k in fields - {'contract_version'}):
        raise Refusal('unconfigured')
    config['interface_guid'] = str(uuid.UUID(config['interface_guid'].strip('{}')))
    for name in ('usb_vendor', 'usb_product'):
        if not re.fullmatch('[0-9a-f]{4}', config[name]):
            raise Refusal('unconfigured')
    if not re.fullmatch(r'USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\[^\x00\r\n]{1,170}', config['usb_instance']):
        raise Refusal('unconfigured')
    if not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', config['host_key_sha256']):
        raise Refusal('untrusted')
    source = ipaddress.IPv4Address(config['source_address'])
    if source.is_unspecified or source.is_loopback or source.is_multicast:
        raise Refusal('unconfigured')
    return config


# Fixed query only; configuration becomes data via environment, never PowerShell source.
INVENTORY = r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$a=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter | Where-Object { $_.InterfaceGuid.ToString().Trim('{}') -eq $env:MANAGER_INTERFACE_GUID })
if ($a.Count -ne 1) { throw 'adapter' }
$a | Select-Object InterfaceGuid,InterfaceIndex,NetLuid,PnPDeviceID,Virtual,HardwareInterface,InterfaceOperationalStatus,MediaConnectState,PermanentAddress | ConvertTo-Json -Compress
'''


def inventory(config):
    root = os.environ.get('SystemRoot')
    if not root or not Path(root).is_absolute():
        raise Refusal('unsupported-host')
    command = Path(root) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    done = subprocess.run([str(command), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', INVENTORY],
        env={**os.environ, 'MANAGER_INTERFACE_GUID': config['interface_guid']}, capture_output=True,
        timeout=3, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if len(done.stdout) > LIMIT:
        raise Refusal('disconnected')
    return json.loads(done.stdout.decode('utf-8-sig'))


class Windows:
    def __init__(self):
        self.ip = C.WinDLL('iphlpapi.dll')
        self.cm = C.WinDLL('cfgmgr32.dll')
        self.locate = api(self.cm, 'CM_Locate_DevNodeW', [C.POINTER(U32), W.LPWSTR, U32])
        self.parent = api(self.cm, 'CM_Get_Parent', [C.POINTER(U32), U32, U32])
        self.device_id = api(self.cm, 'CM_Get_Device_IDW', [U32, W.LPWSTR, U32, U32])
        self.status = api(self.cm, 'CM_Get_DevNode_Status', [C.POINTER(U32), C.POINTER(U32), U32, U32])
        self.best = api(self.ip, 'GetBestRoute2', [C.POINTER(U64), U32, C.POINTER(Address), C.POINTER(Address), U32, C.POINTER(Route), C.POINTER(Address)])

    def ancestry(self, instance):
        node = U32()
        if self.locate(C.byref(node), instance, 0):
            raise Refusal('disconnected')
        nodes = []
        for _ in range(32):
            text, status, problem = C.create_unicode_buffer(200), U32(), U32()
            if self.device_id(node, text, 200, 0) or self.status(C.byref(status), C.byref(problem), node, 0) or problem.value or not status.value & 8:
                raise Refusal('disconnected')
            name = text.value.upper()
            nodes.append((node.value, name, status.value, problem.value))
            if re.fullmatch(r'USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\.+', name):
                return nodes
            next_node = U32()
            if self.parent(C.byref(next_node), node, 0):
                break
            node = next_node
        raise Refusal('disconnected')

    def route(self, index=0, luid=0, source=None):
        route, selected, destination = Route(), Address(), Address.ipv4(PEER)
        local, identity = Address.ipv4(source) if source else None, U64(luid)
        if self.best(C.byref(identity) if luid else None, index, C.byref(local) if local else None,
                     C.byref(destination), 0, C.byref(route), C.byref(selected)):
            raise Refusal('disconnected')
        return {'index': route.index, 'luid': route.luid, 'source': selected.ip(),
                'next_hop': route.next_hop.ip(), 'prefix': route.destination.address.ip(),
                'prefix_length': route.destination.length, 'metric': route.metric,
                'protocol': route.protocol, 'loopback': bool(route.loopback)}

    def snapshot(self, config):
        adapter = inventory(config)
        return validate_snapshot(config, adapter, self.ancestry(adapter['PnPDeviceID']),
            self.route(), self.route(int(adapter['InterfaceIndex']), int(adapter['NetLuid']), config['source_address']))


def validate_snapshot(config, adapter, ancestry, ordinary, constrained):
    if str(uuid.UUID(str(adapter['InterfaceGuid']).strip('{}'))) != config['interface_guid'] or adapter['Virtual'] is not False or adapter['HardwareInterface'] is not True or adapter['InterfaceOperationalStatus'] != 1 or adapter['MediaConnectState'] != 1:
        raise Refusal('disconnected')
    if not re.fullmatch(r'[0-9A-Fa-f]{12}', adapter.get('PermanentAddress') or ''):
        raise Refusal('disconnected')
    index, luid = int(adapter['InterfaceIndex']), int(adapter['NetLuid'])
    if not 0 < index < 2**24 or not luid or not ancestry or ancestry[-1][1] != config['usb_instance'] or not config['usb_instance'].startswith('USB\\VID_' + config['usb_vendor'].upper() + '&PID_' + config['usb_product'].upper() + '\\'):
        raise Refusal('disconnected')
    for route in (ordinary, constrained):
        if route['index'] != index or route['luid'] != luid or route['source'] != config['source_address'] or route['next_hop'] != '0.0.0.0' or route['loopback'] or not 1 <= route['prefix_length'] <= 32 or ipaddress.IPv4Address(PEER) not in ipaddress.IPv4Network((route['prefix'], route['prefix_length']), strict=False):
            raise Refusal('disconnected')
    return {'index': index, 'luid': luid, 'guid': config['interface_guid'], 'ancestry': ancestry,
            'mac': adapter['PermanentAddress'], 'source': config['source_address'],
            'ordinary': ordinary, 'constrained': constrained}


def bound_socket(config, snapshot):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(3)
        # Winsock requires network order input; readback is HOST order (not htonl).
        option = getattr(socket, 'IP_UNICAST_IF', 31)
        try:
            sock.setsockopt(socket.IPPROTO_IP, option, socket.htonl(snapshot['index']))
            if sock.getsockopt(socket.IPPROTO_IP, option) != snapshot['index']:
                raise Refusal('disconnected')
        except OSError:
            raise Refusal('unsupported-host') from None
        sock.bind((config['source_address'], 0))
        sock.connect((PEER, 22))
        if sock.getsockname()[0] != config['source_address'] or sock.getpeername() != (PEER, 22):
            raise Refusal('disconnected')
        return sock
    except BaseException:
        sock.close()
        raise


class Notifications:
    """Invalidate conservatively on any IPv4 change, including rapid remove/readd."""
    def __init__(self, windows, config):
        self.changed = threading.Event()
        self.sock = None
        self.lock = threading.Lock()
        self.handles = []
        self.callbacks = []
        self.ip, self.cm = windows.ip, windows.cm
        try:
            callback_type = C.WINFUNCTYPE(None, C.c_void_p, C.c_void_p, U32)
            for name in ('NotifyIpInterfaceChange', 'NotifyUnicastIpAddressChange', 'NotifyRouteChange2'):
                callback = callback_type(lambda *_: self.invalidate())
                handle = C.c_void_p()
                fn = api(self.ip, name, [U16, callback_type, C.c_void_p, U8, C.POINTER(C.c_void_p)])
                if fn(socket.AF_INET, callback, None, 0, C.byref(handle)):
                    raise Refusal('unsupported-host')
                self.callbacks.append(callback)
                self.handles.append(('ip', handle))
            callback_type = C.WINFUNCTYPE(U32, C.c_void_p, C.c_void_p, U32, C.c_void_p, U32)
            def changed(*_):
                self.invalidate()
                return 0
            callback = callback_type(changed)
            instance = config['usb_instance'].encode('utf-16-le')
            filter_ = DeviceFilter(size=C.sizeof(DeviceFilter), kind=2)
            C.memmove(C.addressof(filter_) + DeviceFilter.instance.offset, instance, len(instance))
            handle = C.c_void_p()
            register = api(self.cm, 'CM_Register_Notification', [C.POINTER(DeviceFilter), C.c_void_p, callback_type, C.POINTER(C.c_void_p)])
            if register(C.byref(filter_), None, callback, C.byref(handle)):
                raise Refusal('unsupported-host')
            self.callbacks.append(callback)
            self.handles.append(('cm', handle))
        except BaseException:
            self.close()
            raise

    def invalidate(self):
        self.changed.set()
        with self.lock:
            if self.sock is not None:
                self.sock.close()

    def attach(self, sock):
        with self.lock:
            self.sock = sock
            if self.changed.is_set():
                sock.close()
                raise Refusal('cable-lost')

    def recv(self, _size):
        if self.changed.wait(.25):
            raise OSError('identity invalidated')
        raise socket.timeout()

    def close(self):
        with self.lock:
            handles, self.handles = self.handles, []
        for kind, handle in reversed(handles):
            dll, name = (self.ip, 'CancelMibChangeNotify2') if kind == 'ip' else (self.cm, 'CM_Unregister_Notification')
            api(dll, name, [C.c_void_p])(handle)
        # callbacks remain alive through cancellation, never unregister inside callback.


def observe(config, shared):
    windows = Windows()
    notices = Notifications(windows, config)  # registration precedes baseline/dial
    try:
        baseline = []
        def snapshot(_):
            if notices.changed.is_set():
                raise Refusal('cable-lost')
            value = windows.snapshot(config)
            if notices.changed.is_set():
                raise Refusal('cable-lost')
            if not baseline:
                baseline.append(value)
            return value
        def dial(_):
            current = snapshot(config)
            if current != baseline[0]:
                raise Refusal('cable-lost')
            sock = bound_socket(config, current)
            notices.attach(sock)
            return sock
        return shared.observe(config, snapshot=snapshot, dial=dial, notices=notices)
    finally:
        notices.close()
