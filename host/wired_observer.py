"""Fixed read-only Linux USB observer. No caller-defined remote command or path."""
import base64
import errno
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import threading

PEER = '10.11.99.1'
LIMIT = 65536
COMMAND = 'uname -m; systemctl show reader-buddy.service --no-pager -p LoadState -p ActiveState -p SubState'
STATUSES = {'unconfigured', 'unsupported-host', 'disconnected', 'untrusted', 'authentication-required',
            'timeout', 'cancelled', 'cable-lost', 'observation-unavailable', 'observed'}


class Refusal(Exception):
    def __init__(self, status):
        self.status = status


def private_bytes(path, parent_private=False, maximum=16384):
    path = Path(path)
    if not path.is_absolute() or str(path.resolve()) != str(path):
        raise Refusal('unconfigured')
    if parent_private:
        parent = path.parent.stat()
        if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            raise Refusal('unconfigured')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > maximum:
            raise Refusal('unconfigured')
        data = os.read(fd, maximum + 1)
        if len(data) > maximum:
            raise Refusal('unconfigured')
        return data
    finally:
        os.close(fd)


def load_config(path):
    config = json.loads(private_bytes(path, parent_private=True))
    fields = {'contract_version', 'interface', 'usb_path', 'usb_vendor', 'usb_product', 'source_address', 'host_key_sha256', 'identity_file'}
    if not isinstance(config, dict) or set(config) != fields or config['contract_version'] != 1 or any(not isinstance(config[k], str) for k in fields - {'contract_version'}):
        raise Refusal('unconfigured')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,15}', config['interface']):
        raise Refusal('unconfigured')
    if not re.fullmatch(r'/sys/devices/[^\x00\r\n]+', config['usb_path']):
        raise Refusal('unconfigured')
    for name in ('usb_vendor', 'usb_product'):
        if not re.fullmatch(r'[0-9a-f]{4}', config[name]):
            raise Refusal('unconfigured')
    if not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', config['host_key_sha256']):
        raise Refusal('untrusted')
    ipaddress.IPv4Address(config['source_address'])
    return config


def ip_json(args):
    completed = subprocess.run(['ip', '-j', *args], capture_output=True, timeout=1, check=True)
    if len(completed.stdout) > LIMIT:
        raise Refusal('disconnected')
    return json.loads(completed.stdout)


def validate_route(routes, interface, source):
    if len(routes) != 1:
        raise Refusal('disconnected')
    route = routes[0]
    if route.get('dev') != interface or route.get('prefsrc', route.get('src', route.get('from'))) != source or route.get('gateway') or route.get('type', 'unicast') != 'unicast':
        raise Refusal('disconnected')
    return {key: route.get(key) for key in ('dev', 'prefsrc', 'src', 'from', 'gateway', 'table', 'type')}


def wired_snapshot(config, net_root=Path('/sys/class/net')):
    net = net_root / config['interface']
    if not net.exists() or (net / 'carrier').read_text().strip() != '1':
        raise Refusal('disconnected')
    device = (net / 'device').resolve(strict=True)
    parents = [p for p in (device, *device.parents) if (p / 'idVendor').exists() and (p / 'idProduct').exists()]
    if not parents or str(parents[0]) != config['usb_path']:
        raise Refusal('disconnected')
    usb = parents[0]
    if (usb / 'idVendor').read_text().strip() != config['usb_vendor'] or (usb / 'idProduct').read_text().strip() != config['usb_product']:
        raise Refusal('disconnected')
    addresses = ip_json(['address', 'show', 'dev', config['interface']])
    if len(addresses) != 1 or 'UP' not in addresses[0]['flags'] or not any(a.get('local') == config['source_address'] and a.get('family') == 'inet' for a in addresses[0]['addr_info']):
        raise Refusal('disconnected')
    route = validate_route(ip_json(['route', 'get', PEER]), config['interface'], config['source_address'])
    constrained = validate_route(ip_json(['route', 'get', PEER, 'from', config['source_address'], 'oif', config['interface']]), config['interface'], config['source_address'])
    # This includes kernel interface generation and physical USB association, not a name/IP assertion.
    return {'ifindex': int((net / 'ifindex').read_text()), 'mac': (net / 'address').read_text().strip(),
            'device': str(device), 'usb': str(usb), 'driver': str((net / 'device/driver').resolve(strict=True)),
            'route': route, 'constrained': constrained, 'source': config['source_address']}


def bound_socket(config):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(3)
        option = config['interface'].encode('ascii') + b'\0'
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, option)
        except OSError as error:
            if error.errno in (errno.EPERM, errno.EACCES, errno.ENOPROTOOPT, errno.EOPNOTSUPP):
                raise Refusal('unsupported-host') from None
            raise
        if sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 16).rstrip(b'\0') != option.rstrip(b'\0'):
            raise Refusal('disconnected')
        sock.bind((config['source_address'], 0))
        sock.connect((PEER, 22))
        if sock.getsockname()[0] != config['source_address'] or sock.getpeername() != (PEER, 22):
            raise Refusal('disconnected')
        return sock
    except BaseException:
        sock.close()
        raise


def fingerprint(key):
    return 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')


def accept_key(transport, config):
    if fingerprint(transport.get_remote_server_key()) != config['host_key_sha256']:
        raise Refusal('untrusted')


def read_key(config, paramiko):
    try:
        text = private_bytes(config['identity_file'], parent_private=True).decode('utf8')
    except OSError:
        raise Refusal('authentication-required') from None
    for key_type in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_type.from_private_key(io.StringIO(text))
        except paramiko.PasswordRequiredException:
            raise Refusal('authentication-required') from None
        except paramiko.SSHException:
            continue
    raise Refusal('authentication-required')


class Reads:
    def __init__(self, sftp):
        self.sftp = sftp
        self.remaining = LIMIT

    def file(self, path, limit=4096, optional=False):
        try:
            before = self.sftp.lstat(path)
        except FileNotFoundError:
            if optional:
                return None
            raise Refusal('observation-unavailable') from None
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise Refusal('observation-unavailable')
        with self.sftp.open(path, 'rb') as f:
            data = f.read(limit + 1)
        self.remaining -= len(data)
        after = self.sftp.lstat(path)
        # This fixed sysfs attribute reports PAGE_SIZE rather than content length.
        synthetic_size = path == '/sys/devices/soc0/machine'
        if len(data) > limit or (not synthetic_size and before.st_size > 0 and len(data) != before.st_size) or self.remaining < 0 or (before.st_size, before.st_mtime, before.st_mode) != (after.st_size, after.st_mtime, after.st_mode):
            raise Refusal('observation-unavailable')
        return data.decode('utf8', errors='strict').strip()

    def os_release(self):
        path = '/etc/os-release'
        try:
            before = self.sftp.lstat(path)
        except FileNotFoundError:
            return None
        if not stat.S_ISLNK(before.st_mode):
            return self.file(path)
        target = self.sftp.readlink(path)
        # Yocto's fixed OS metadata alias; no general remote symlink traversal.
        if target not in ('../usr/lib/os-release', '/usr/lib/os-release'):
            raise Refusal('observation-unavailable')
        value = self.file('/usr/lib/os-release')
        after = self.sftp.lstat(path)
        if target != self.sftp.readlink(path) or (before.st_mode, before.st_size, before.st_mtime) != (after.st_mode, after.st_size, after.st_mtime):
            raise Refusal('observation-unavailable')
        return value


def safe_value(value, maximum=96):
    return value if value and re.fullmatch(r'[A-Za-z0-9 ._()+/-]{1,' + str(maximum) + '}', value) else None


def setting(text, key):
    matches = re.findall(r'^' + key + r'="?([^"\r\n]+)"?$', text or '', re.M)
    return safe_value(matches[0]) if len(matches) == 1 else None


def inspect(transport):
    import paramiko
    sftp = paramiko.SFTPClient.from_transport(transport)
    sftp.get_channel().settimeout(2)
    try:
        reads = Reads(sftp)
        model = safe_value(reads.file('/sys/devices/soc0/machine', optional=True))
        os_release = reads.os_release()
        update = reads.file('/usr/share/remarkable/update.conf', optional=True)
        os_version, update_version = setting(os_release, 'IMG_VERSION'), setting(update, 'RELEASE_VERSION')
        firmware = os_version if os_version == update_version or not update_version else update_version if not os_version else None
        boot = reads.file('/proc/sys/kernel/random/boot_id')
        if not re.fullmatch(r'[a-f0-9-]{36}', boot):
            raise Refusal('observation-unavailable')
        channel = transport.open_session(timeout=2)
        try:
            channel.settimeout(2)
            channel.exec_command(COMMAND)
            output = bytearray()
            while True:
                chunk = channel.recv(1024)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 4096:
                    raise Refusal('observation-unavailable')
            text = output.decode('utf8')
            lines = text.splitlines()
            architecture = lines[0] if lines and lines[0] in ('armv7l', 'aarch64', 'armv6l') else None
            service = {k: None for k in ('LoadState', 'ActiveState', 'SubState')}
            for line in lines[1:]:
                key, _, value = line.partition('=')
                if key in service and re.fullmatch(r'[a-z-]{1,32}', value):
                    service[key] = value
            if reads.file('/proc/sys/kernel/random/boot_id') != boot or reads.os_release() != os_release or reads.file('/usr/share/remarkable/update.conf', optional=True) != update:
                raise Refusal('observation-unavailable')
            # A missing unit is an observed service state, not package/provenance absence.
            return {'model': model, 'firmware': firmware, 'firmware_conflict': bool(os_version and update_version and os_version != update_version),
                    'architecture': architecture, 'boot_id': boot, 'service': service,
                    'installed_version': None, 'provenance': 'unknown'}
        finally:
            channel.close()
    finally:
        sftp.close()


def observe(config, snapshot=wired_snapshot, dial=bound_socket, inspection=inspect):
    import paramiko
    baseline = snapshot(config)
    sock = dial(config)
    if snapshot(config) != baseline:
        sock.close()
        raise Refusal('cable-lost')
    transport = paramiko.Transport(sock)
    done = threading.Event()
    invalid = []

    notices = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)
    try:
        notices.bind((0, 0x51))  # link, IPv4 address, IPv4 route
        notices.settimeout(.25)
    except BaseException:
        notices.close()
        transport.close()
        sock.close()
        raise Refusal('disconnected') from None

    def watch():
        try:
            while not done.is_set():
                try:
                    notices.recv(65536)
                except socket.timeout:
                    pass
                except OSError:
                    invalid.append('cable-lost')
                    sock.close()
                    return
                if done.is_set():
                    return
                try:
                    if snapshot(config) != baseline:
                        raise Refusal('cable-lost')
                except Exception:
                    invalid.append('cable-lost')
                    sock.close()
                    return
        finally:
            notices.close()

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        transport.banner_timeout = 3
        transport.auth_timeout = 3
        transport.start_client(timeout=3)
        accept_key(transport, config)  # MUST precede any credential authentication.
        transport.auth_publickey('root', read_key(config, paramiko))
        result = inspection(transport)
        if invalid or snapshot(config) != baseline:
            raise Refusal('cable-lost')
        result['connection_id'] = hashlib.sha256(json.dumps(baseline, sort_keys=True).encode()).hexdigest()
        return result
    except Exception:
        if invalid:
            raise Refusal('cable-lost') from None
        raise
    finally:
        done.set()
        transport.close()
        sock.close()
        watcher.join(timeout=1.5)


def main():
    status, observation = 'unconfigured', None
    if sys.platform != 'linux':
        status = 'unsupported-host'
    elif os.environ.get('MANAGER_WIRED_CONFIG'):
        try:
            import paramiko
            if paramiko.__version__ != '5.0.0':
                raise Refusal('unconfigured')
            signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Refusal('timeout')))
            signal.alarm(12)
            try:
                config = load_config(os.environ['MANAGER_WIRED_CONFIG'])
            except (OSError, ValueError, TypeError, KeyError):
                raise Refusal('unconfigured') from None
            observation = observe(config)
            status = 'observed'
        except Refusal as error:
            status = error.status
        except (socket.timeout, TimeoutError):
            status = 'timeout'
        except Exception as error:
            # Never serialize exception text: it may contain paths or secret material.
            if isinstance(error, ModuleNotFoundError):
                status = 'unconfigured'
            elif type(error).__name__ in ('AuthenticationException', 'PasswordRequiredException'):
                status = 'authentication-required'
            elif isinstance(error, (ConnectionError, OSError)):
                status = 'disconnected'
            else:
                status = 'observation-unavailable'
        finally:
            signal.alarm(0)
    print(json.dumps({'contract_version': 1, 'status': status, 'observation': observation}))


if __name__ == '__main__':
    main()
