"""Private isolated-backup staging broker. All file names have fixed V1 roles."""
import base64
from contextlib import ExitStack, contextmanager
import ctypes
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid

sys.path.insert(0, str(Path(__file__).parent))
from drive_store import checked_root, exclusive, require, windows_check_handle
from windows_resource_handle import checked_handle

MIB = 1024 * 1024
DIRECTORIES = ('', 'data', 'data/objects')
FIXED = {'data/backup.json': 8 * MIB, 'portable-configuration.json': 128 * 1024,
         'isolated-backup.json': 16 * 1024}
OBJECT = re.compile(r'data/objects/[0-9a-f]{64}\Z')
LINE_LIMIT = 400_000


def key(info):
    return info.st_dev, info.st_ino


def seal(info):
    return (*key(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def win_key(handle):
    import win32file
    info = win32file.GetFileInformationByHandle(handle)
    return info[4], info[8], info[9]


def reject_links(path):
    require(not any(item.is_symlink() or (sys.platform == 'win32' and item.is_junction())
                    for item in (path, *path.parents)))


def checked_directory(path):
    reject_links(path)
    require(path.resolve(strict=True) == path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700)
    return key(info)


def require_members(path_or_fd, expected):
    with os.scandir(path_or_fd) as entries:
        remaining = set(expected)
        for entry in entries:
            require(entry.name in remaining)
            remaining.remove(entry.name)
        require(not remaining)


def lexical_root(value):
    root = Path(value)
    require(root.is_absolute() and len(root.parts) >= 3 and str(root) == value
            and '..' not in root.parts)
    if sys.platform == 'win32':
        import win32file
        drive_fixed = 3
        require(not root.drive.startswith('\\') and ':' not in str(root)[2:]
                and win32file.GetDriveType(root.anchor) == drive_fixed)
    return root


@contextmanager
def win_handle(path, directory, private, delete=False):
    import win32con
    access = win32con.READ_CONTROL | (win32con.DELETE if delete else 0)
    share = 0 if delete else win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE
    with checked_handle(path, directory=directory, access=access, share=share) as handle:
        if private:
            windows_check_handle(handle)
        yield handle


def win_delete(handle):
    # Delete the checked handle's own entry. Never reopen by path after verifying
    # its identity. Closing this exclusive handle completes deletion.
    class Disposition(ctypes.Structure):
        _fields_ = [('delete', ctypes.c_ubyte)]
    set_info = ctypes.WinDLL('kernel32', use_last_error=True).SetFileInformationByHandle
    set_info.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
    set_info.restype = ctypes.c_int
    info = Disposition(1)
    require(set_info(int(handle), 4, ctypes.byref(info), ctypes.sizeof(info)))


def native_windows_directory(path):
    # Inherit only inside a previously verified private parent. Admission
    # checks the actual owner/DACL before this directory is used.
    os.mkdir(path, 0o700)


class Broker:
    def __init__(self, parent, exclusions, stack):
        require(sys.platform in ('linux', 'win32'))
        self.windows = sys.platform == 'win32'
        self.parent = lexical_root(parent)
        for entry in exclusions:
            protected = Path(entry)
            require(protected.is_absolute() and '..' not in protected.parts)
            for candidate in (protected, protected.resolve()):
                require(self.parent != candidate and candidate not in self.parent.parents
                        and self.parent not in candidate.parents)
        # Hold the Windows ancestor chain against rename for this entire stage.
        if self.windows:
            for directory in reversed((self.parent, *self.parent.parents)):
                self.parent_handle = stack.enter_context(win_handle(directory, True, directory == self.parent))
        self.parent_id = checked_root(self.parent) if self.windows else checked_directory(self.parent)
        require(self.parent_id is not None)
        if not self.windows:
            self.parent_fd = self.open_dir(str(self.parent))
            stack.callback(os.close, self.parent_fd)
            require(key(os.fstat(self.parent_fd)) == self.parent_id)
        else:
            self.win_parent_id = win_key(self.parent_handle)
        self.root = None
        self.dirs = {}
        self.files = {}
        self.stream = None
        self.written = 0
        self.total = 0
        self.synced = False
        self.marker_closed = False
        self.closed = False
        self.cleanup_failed = False

    @staticmethod
    def open_dir(name, dir_fd=None):
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)

    def check_parent(self):
        if self.windows:
            with win_handle(self.parent, True, True) as handle:
                require(win_key(handle) == self.win_parent_id)
        else:
            require(checked_directory(self.parent) == self.parent_id)
            require(key(os.fstat(self.parent_fd)) == self.parent_id)

    def create(self):
        require(self.root is None)
        self.check_parent()
        name = 'isolated-backup-' + uuid.uuid4().hex
        self.root = self.parent / name
        try:
            self.create_dir('', name, self.parent_fd if not self.windows else None)
            self.create_dir('data', 'data', self.fd(''))
            self.create_dir('data/objects', 'objects', self.fd('data'))
            self.check_dirs()
            return str(self.root)
        except Exception:
            # Never remove an entry we did not successfully identify and record.
            self.release()
            raise

    def fd(self, relative):
        return self.dirs[relative][1] if not self.windows else None

    def create_dir(self, relative, name, parent_fd):
        target = self.root / relative
        with self.pin_dirs():
            if self.windows:
                native_windows_directory(target)
                with win_handle(target, True, True) as handle:
                    require(checked_root(target) is not None)
                    self.dirs[relative] = (win_key(handle), None)
            else:
                os.mkdir(name, 0o700, dir_fd=parent_fd)
                fd = self.open_dir(name, parent_fd)
                self.dirs[relative] = (key(os.fstat(fd)), fd)
                require(checked_directory(target) == self.dirs[relative][0])

    @contextmanager
    def pin_dirs(self):
        self.check_parent()
        with ExitStack() as stack:
            for relative, (original, fd) in self.dirs.items():
                target = self.root / relative
                if self.windows:
                    handle = stack.enter_context(win_handle(target, True, True))
                    require(win_key(handle) == original)
                else:
                    require(checked_directory(target) == original)
                    require(key(os.fstat(fd)) == original)
            yield

    def check_dirs(self):
        with self.pin_dirs():
            pass

    def free(self):
        with self.pin_dirs():
            return min(shutil.disk_usage(self.root or self.parent).free, (1 << 53) - 1)

    def split_file(self, relative):
        directory, _, leaf = relative.rpartition('/')
        return directory, leaf

    def check_file(self, info):
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
        if not self.windows:
            require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600)

    def open_file(self, relative, maximum):
        require(self.root is not None and self.stream is None and not self.marker_closed
                and relative not in self.files and len(self.files) < 4099)
        file_limit = FIXED.get(relative)
        if file_limit is None:
            require(OBJECT.fullmatch(relative))
            file_limit = 256 * MIB
        require(type(maximum) is int and (0 if OBJECT.fullmatch(relative) else 1) <= maximum <= file_limit
                and self.total + maximum <= 512 * MIB)
        require((relative == 'data/backup.json') == (len(self.files) == 0))
        if relative == 'isolated-backup.json':
            require('portable-configuration.json' in self.files)
        directory, leaf = self.split_file(relative)
        target = self.root / relative
        with self.pin_dirs():
            if self.windows:
                stream = exclusive(target)
            else:
                fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd(directory))
                stream = os.fdopen(fd, 'wb')
        self.stream = stream
        self.active = relative
        self.maximum = maximum
        self.written = 0
        self.synced = False
        info = os.fstat(stream.fileno())
        self.check_file(info)
        original = key(info)
        if self.windows:
            import msvcrt
            handle = msvcrt.get_osfhandle(stream.fileno())
            windows_check_handle(handle)
            original = win_key(handle)
        self.files[relative] = (original, None)
        self.total += maximum

    def write(self, encoded):
        require(self.stream is not None and not self.synced and type(encoded) is str)
        chunk = base64.b64decode(encoded, validate=True)
        require(0 < len(chunk) <= 65536 and self.written + len(chunk) <= self.maximum)
        require(self.stream.write(chunk) == len(chunk))
        self.written += len(chunk)

    def sync(self):
        require(self.stream is not None and self.written == self.maximum)
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.synced = True

    def close(self):
        require(self.stream is not None)
        stream, self.stream = self.stream, None
        try:
            if self.synced and not self.windows:
                info = os.fstat(stream.fileno())
                self.check_file(info)
                require(info.st_size == self.maximum)
                self.files[self.active] = (key(info), seal(info))
                self.marker_closed = self.active == 'isolated-backup.json'
        finally:
            stream.close()
        if self.synced and self.windows:
            with self.pin_dirs(), self.checked_file(self.active) as handle:
                info = (self.root / self.active).lstat()
                require(info.st_size == self.maximum)
                self.files[self.active] = (win_key(handle), seal(info))
                self.marker_closed = self.active == 'isolated-backup.json'

    @contextmanager
    def checked_file(self, relative, deleting=False, completed=False):
        target = self.root / relative
        directory, leaf = self.split_file(relative)
        if self.windows:
            with win_handle(target, False, True, deleting) as handle:
                info = target.lstat()
                self.validate_file(relative, info, completed, win_key(handle))
                yield handle
        else:
            info = os.stat(leaf, dir_fd=self.fd(directory), follow_symlinks=False)
            self.validate_file(relative, info, completed, key(info))
            yield None

    def validate_file(self, relative, info, completed, actual):
        self.check_file(info)
        original, expected = self.files[relative]
        require(actual == original and (not completed or seal(info) == expected))

    def check_tree(self, completed):
        require(self.stream is None)
        with self.pin_dirs():
            members = {name: set() for name in self.dirs}
            for relative in (*self.dirs, *self.files):
                if relative:
                    directory, leaf = self.split_file(relative)
                    members[directory].add(leaf)
            for directory, expected in members.items():
                require_members(self.root / directory if self.windows else self.fd(directory), expected)
            for relative in self.files:
                with self.checked_file(relative, completed=completed):
                    pass

    def assert_owned(self, names):
        require(self.marker_closed and len(names) == len(self.files) and set(names) == self.files.keys())
        self.check_tree(True)
        return True

    def release(self):
        require(not self.closed)
        self.closed = True
        try:
            self.release_owned()
        except Exception:
            self.cleanup_failed = True
            raise

    def release_owned(self):
        if self.stream is not None:
            self.close()
        if self.root is None:
            return
        try:
            require('' in self.dirs)
            self.check_tree(False)  # Full preflight before removing any file.
            with self.pin_dirs():
                for relative in self.files:
                    directory, leaf = self.split_file(relative)
                    with self.checked_file(relative, deleting=True) as handle:
                        if self.windows:
                            win_delete(handle)
                        else:
                            os.unlink(leaf, dir_fd=self.fd(directory))
            for relative in reversed(tuple(self.dirs)):
                target = self.root / relative
                if self.windows:
                    with win_handle(target, True, True, delete=True) as handle:
                        require(win_key(handle) == self.dirs[relative][0])
                        win_delete(handle)
                else:
                    directory, leaf = self.split_file(relative)
                    parent_fd = self.fd(directory) if relative else self.parent_fd
                    leaf = leaf if relative else self.root.name
                    require(key(os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)) == self.dirs[relative][0])
                    os.rmdir(leaf, dir_fd=parent_fd)
        finally:
            if not self.windows:
                for _, fd in reversed(tuple(self.dirs.values())):
                    os.close(fd)

    def dispatch(self, request):
        action = request.get('action')
        if action == 'probe':
            self.check_parent()
            return True
        if action == 'free':
            return self.free()
        if action == 'create':
            return self.create()
        if action == 'open':
            return self.open_file(request['name'], request['maxBytes'])
        if action == 'write':
            return self.write(request['bytes'])
        if action == 'sync':
            return self.sync()
        if action == 'close':
            return self.close()
        if action == 'assert':
            return self.assert_owned(request['files'])
        if action == 'release':
            return self.release()
        require(False)


def main():
    try:
        parent, exclusions = sys.argv[1:]
        excluded = json.loads(exclusions)
        require(type(excluded) is list and 1 <= len(excluded) <= 16)
        with ExitStack() as stack:
            broker = Broker(parent, excluded, stack)
            # A killed parent/child may leave residue. A later process does not
            # adopt or scavenge it. Normal EOF attempts checked owned teardown.
            try:
                for raw in iter(lambda: sys.stdin.buffer.readline(LINE_LIMIT + 1), b''):
                    try:
                        require(len(raw) <= LINE_LIMIT and raw.endswith(b'\n'))
                        request = json.loads(raw)
                        value = broker.dispatch(request)
                        print(json.dumps({'ok': True, 'value': value}), flush=True)
                        if broker.closed:
                            return
                    except Exception:
                        print('{"ok":false}', flush=True)
                        if broker.cleanup_failed:
                            raise
                        if broker.closed or len(raw) > LINE_LIMIT:
                            return
            finally:
                if not broker.closed:
                    broker.release()
    except Exception:
        sys.exit(1)


if __name__ == '__main__':
    main()
