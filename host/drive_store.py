"""Fixed-file host credential custody. No network, tablet or renderer paths."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid

MAXIMUM = 49152
NAMES = {'client': 'client.json', 'grant': 'grant.json'}


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
    import win32api
    import win32con
    import win32file
    import win32security as security
    token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        user = security.GetTokenInformation(token, security.TokenUser)[0]
    finally:
        token.Close()
    attrs = win32file.GetFileAttributes(str(path))
    require(not attrs & win32con.FILE_ATTRIBUTE_REPARSE_POINT)
    handle = win32file.CreateFile(str(path), win32con.READ_CONTROL, win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE,
                                 None, win32con.OPEN_EXISTING,
                                 win32file.FILE_FLAG_OPEN_REPARSE_POINT | win32con.FILE_FLAG_BACKUP_SEMANTICS, None)
    try:
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
    finally:
        handle.Close()


def private_read(root, kind):
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
        raw = private_bytes(path, parent_private=True, maximum=MAXIMUM)
    else:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and 0 < info.st_size <= MAXIMUM)
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(MAXIMUM + 1)
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
    handle = win32file.CreateFile(str(path), win32con.GENERIC_WRITE, 0, attributes, win32con.CREATE_NEW,
                                 win32file.FILE_FLAG_OPEN_REPARSE_POINT, None)
    return os.fdopen(msvcrt.open_osfhandle(handle.Detach(), os.O_WRONLY | os.O_BINARY), 'wb')


def identity(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def operate(root, request):
    operation = request.get('operation')
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
