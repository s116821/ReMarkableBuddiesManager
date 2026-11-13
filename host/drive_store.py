"""Fixed-file host custody. No network, tablet or renderer paths."""
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

MAXIMUM = 49152
NAMES = {'client': 'client.json', 'grant': 'grant.json',
         'isolated-root-operations': 'isolated-root-operations.json'}
RETENTION = 'isolated-root-operations'
RETENTION_LOCK = '.isolated-root-operations.lock'
MAX_ORIGINALS = 8
MAX_ORIGINAL_INPUT = 512
MAX_ORIGINAL_RECORD = 2048
MAX_RETENTION = 20480


def require(value):
    if not value:
        raise ValueError('protected-storage-unavailable')


def parse(raw):
    require(len(raw) <= MAXIMUM)
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    def constant(_):
        raise ValueError('invalid-json')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def checked_root(root):
    require(root.is_absolute() and not any(p.is_symlink() or p.is_junction() for p in [root, *root.parents]))
    if not root.exists():
        return None
    require(root.is_dir() and root.resolve() == root)
    info = root.stat()
    if sys.platform == 'linux':
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700)
    elif sys.platform == 'win32':
        windows_check(root)
    else:
        raise ValueError('unsupported-host')
    return (info.st_dev, info.st_ino)


def windows_check(path):
    import win32con
    import win32file
    attrs = win32file.GetFileAttributes(str(path))
    require(not attrs & win32con.FILE_ATTRIBUTE_REPARSE_POINT)
    handle = win32file.CreateFile(str(path), win32con.READ_CONTROL, win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE,
                                 None, win32con.OPEN_EXISTING,
                                 win32file.FILE_FLAG_OPEN_REPARSE_POINT | win32con.FILE_FLAG_BACKUP_SEMANTICS, None)
    try:
        windows_check_handle(handle)
    finally:
        handle.Close()


def windows_check_handle(handle):
    import win32api
    import win32con
    import win32security as security
    token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        user = security.GetTokenInformation(token, security.TokenUser)[0]
    finally:
        token.Close()
    sd = security.GetSecurityInfo(handle, security.SE_FILE_OBJECT,
                                  security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION)
    acl = sd.GetSecurityDescriptorDacl()
    require(sd.GetSecurityDescriptorOwner() == user and acl is not None)
    permitted = {security.ConvertSidToStringSid(user), 'S-1-5-18', 'S-1-5-32-544'}
    for index in range(acl.GetAceCount()):
        ace = acl.GetAce(index)
        require(ace[0][0] in (security.ACCESS_ALLOWED_ACE_TYPE, security.ACCESS_DENIED_ACE_TYPE))
        if ace[0][0] == security.ACCESS_ALLOWED_ACE_TYPE and ace[1]:
            require(security.ConvertSidToStringSid(ace[2]) in permitted)


def private_read(root, kind, maximum=MAXIMUM):
    if checked_root(root) is None:
        return None
    path = root / NAMES[kind]
    if not path.exists():
        require(not path.is_symlink() and not path.is_junction())
        return None
    require(not path.is_symlink() and not path.is_junction() and path.is_file())
    if sys.platform == 'win32':
        # Reuse the independently qualified handle/ancestor/ACL reader; never relax its boundary.
        sys.path.insert(0, str(Path(__file__).parent))
        from windows_wired import private_bytes
        raw = private_bytes(path, parent_private=True, maximum=maximum)
    else:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and 0 < info.st_size <= maximum)
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(maximum + 1)
            after = os.fstat(fd)
            current = path.stat(follow_symlinks=False)
            require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                    (after.st_dev, after.st_ino) == (current.st_dev, current.st_ino) and len(raw) == info.st_size)
        finally:
            os.close(fd)
    parse(raw)
    return raw


def exclusive(path):
    if sys.platform != 'win32':
        return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb')
    import msvcrt
    import win32con
    handle = windows_private_writer(path, win32con.CREATE_NEW, win32con.GENERIC_WRITE)
    return os.fdopen(msvcrt.open_osfhandle(handle.Detach(), os.O_WRONLY | os.O_BINARY), 'wb')


def windows_private_writer(path, disposition, access):
    import ntsecuritycon
    import pywintypes
    import win32api
    import win32con
    import win32file
    import win32security as security
    token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        user = security.GetTokenInformation(token, security.TokenUser)[0]
    finally:
        token.Close()
    acl = security.ACL()
    acl.AddAccessAllowedAce(security.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, user)
    sd = security.SECURITY_DESCRIPTOR()
    sd.SetSecurityDescriptorOwner(user, False)
    sd.SetSecurityDescriptorDacl(True, acl, False)
    sd.SetSecurityDescriptorControl(security.SE_DACL_PROTECTED, security.SE_DACL_PROTECTED)
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = sd
    return win32file.CreateFile(str(path), access, 0, attributes, disposition,
                                win32con.FILE_FLAG_OPEN_REPARSE_POINT, None)


def identity(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def compact(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()


def exact(value, fields):
    require(type(value) is dict and value.keys() == set(fields.split()))


def digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def uuid_text(value):
    return (isinstance(value, str) and
            re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) is not None and
            value != '00000000-0000-0000-0000-000000000000')


def validate_original(record):
    exact(record, 'reference connection_id boot_id snapshot input_base64 input_sha256')
    require(len(compact(record)) <= MAX_ORIGINAL_RECORD)
    require(all(digest(record[field]) for field in ('reference', 'connection_id', 'input_sha256'))
            and uuid_text(record['boot_id']))
    snapshot = record['snapshot']
    exact(snapshot, 'device epoch mode token')
    exact(snapshot['mode'], 'kind backup binding_sha256')
    exact(snapshot['token'], 'actor sha256')
    token = snapshot['token']
    mode = snapshot['mode']
    require(all(uuid_text(item) for item in (snapshot['device'], snapshot['epoch'], token['actor'], mode['backup']))
            and mode['kind'] == 'isolated-backup' and digest(mode['binding_sha256']) and digest(token['sha256']))
    encoded = record['input_base64']
    require(isinstance(encoded, str) and len(encoded) <= (MAX_ORIGINAL_INPUT + 2) // 3 * 4)
    raw = base64.b64decode(encoded, validate=True)
    require(0 < len(raw) <= MAX_ORIGINAL_INPUT and base64.b64encode(raw).decode('ascii') == encoded
            and identity(raw) == record['input_sha256'])
    request = parse(raw)
    exact(request, 'control_version operation expected')
    require(type(request['control_version']) is int and request['control_version'] == 1
            and uuid_text(request['operation']) and request['expected'] == token)
    return token['actor'], snapshot['epoch']


def retained_value(raw):
    if raw is None:
        return {'version': 1, 'originals': []}
    value = parse(raw)
    exact(value, 'version originals')
    originals = value['originals']
    require(type(value['version']) is int and value['version'] == 1
            and type(originals) is list and len(originals) <= MAX_ORIGINALS)
    references, actor_epochs = set(), set()
    for original in originals:
        actor_epoch = validate_original(original)
        require(original['reference'] not in references and actor_epoch not in actor_epochs)
        references.add(original['reference'])
        actor_epochs.add(actor_epoch)
    return value


@contextmanager
def retention_writer(path):
    # The persistent file is only a rendezvous. Process exit releases the
    # advisory lock (Linux) or the exclusive handle (Windows).
    if sys.platform == 'win32':
        import win32con
        import win32file
        handle = windows_private_writer(path, win32con.OPEN_ALWAYS,
                                        win32con.READ_CONTROL | win32con.GENERIC_WRITE)
        try:
            info = win32file.GetFileInformationByHandle(handle)
            require(not info[0] & (win32con.FILE_ATTRIBUTE_REPARSE_POINT | win32con.FILE_ATTRIBUTE_DIRECTORY)
                    and info[7] == 1)
            windows_check_handle(handle)
            yield
        finally:
            handle.Close()
    else:
        import fcntl
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            current = path.stat(follow_symlinks=False)
            require((info.st_dev, info.st_ino) == (current.st_dev, current.st_ino))
            yield
        finally:
            os.close(fd)


def retain(root, request):
    if request['operation'] == 'read-isolated-root-operations':
        exact(request, 'operation')
        raw = private_read(root, RETENTION, MAX_RETENTION)
        return {'value': retained_value(raw) if raw is not None else None, 'digest': identity(raw)}
    exact(request, 'operation record expected_digest')
    expected = request['expected_digest']
    require(expected is None or digest(expected))
    record = request['record']
    validate_original(record)
    root_identity = checked_root(root)
    require(root_identity is not None)
    with retention_writer(root / RETENTION_LOCK):
        require(checked_root(root) == root_identity)
        previous = private_read(root, RETENTION, MAX_RETENTION)
        require(identity(previous) == expected)
        value = retained_value(previous)
        value['originals'].append(record)
        raw = compact(value) + b'\n'
        require(len(raw) <= MAX_RETENTION)
        retained_value(raw)
        stage = root / ('.isolated-root-stage-' + uuid.uuid4().hex)
        stream = exclusive(stage)
        staged = os.fstat(stream.fileno())
        try:
            with stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            require(checked_root(root) == root_identity
                    and private_read(root, RETENTION, MAX_RETENTION) == previous)
            os.replace(stage, root / NAMES[RETENTION])
            require(checked_root(root) == root_identity and private_read(root, RETENTION, MAX_RETENTION) == raw)
            return {'committed': True, 'digest': identity(raw)}
        finally:
            if checked_root(root) == root_identity and stage.exists():
                current = stage.stat(follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (staged.st_dev, staged.st_ino):
                    stage.unlink(missing_ok=True)


def operate(root, request):
    operation = request.get('operation')
    if operation in ('read-isolated-root-operations', 'append-isolated-root-operation'):
        return retain(root, request)
    require(operation in {'read-client', 'read-grant', 'save', 'disconnect'})
    if operation.startswith('read-'):
        require(set(request) == {'operation'})
        raw = private_read(root, operation[5:])
        return {'value': parse(raw) if raw is not None else None, 'digest': identity(raw)}
    require(set(request) == ({'operation', 'client_digest', 'grant_digest', 'value'} if operation == 'save'
                            else {'operation', 'client_digest', 'grant_digest'}))
    root_identity = checked_root(root)
    require(root_identity is not None)
    # Cooperative cross-instance CAS is scoped to this fixed private directory.
    lock_path = root / '.credential-operation.lock'
    stage = root / ('.grant-' + uuid.uuid4().hex)
    lock = exclusive(lock_path)
    try:
        require(identity(private_read(root, 'client')) == request['client_digest'] and
                identity(private_read(root, 'grant')) == request['grant_digest'])
        if operation == 'disconnect':
            require(checked_root(root) == root_identity)
            if request['grant_digest'] is not None:
                (root / NAMES['grant']).unlink()
            return {'committed': True, 'digest': None}
        raw = (json.dumps(request['value'], ensure_ascii=True, sort_keys=True, separators=(',', ':')) + '\n').encode()
        parse(raw)
        with exclusive(stage) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        require(checked_root(root) == root_identity and
                identity(private_read(root, 'client')) == request['client_digest'] and
                identity(private_read(root, 'grant')) == request['grant_digest'])
        # Synchronous non-interleavable host save begins after the final generation guard.
        os.replace(stage, root / NAMES['grant'])
        require(identity(private_read(root, 'grant')) == identity(raw))
        return {'committed': True, 'digest': identity(raw)}
    finally:
        lock.close()
        if stage.exists():
            stage.unlink()
        lock_path.unlink()


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2)
        request = parse(sys.stdin.buffer.read(MAXIMUM + 1))
        print(json.dumps(operate(Path(sys.argv[1]), request), ensure_ascii=True))
    except Exception:
        # No exception text/path/credential or traceback crosses the child boundary.
        print('{"error":"protected-storage-unavailable"}')
        sys.exit(1)
