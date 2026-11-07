"""Closed original goals and process-lifetime exclusion on the existing intent."""
from contextlib import contextmanager
from contextvars import ContextVar
import json
import os
import sys

from resident_package_recovery import DIGEST, UUID, require, require_package_version

LEASE_SINK = ContextVar('resident_goal_lease', default=None)
RETAINED_READ = ContextVar('resident_retained_read', default=None)

def lease_readable(path):
    return str(path) == RETAINED_READ.get() or any(
        str(path) == getattr(lease, 'path', None) for lease in (LEASE_SINK.get() or []))


def bounded(record):
    require(len(json.dumps(record, separators=(',', ':')).encode('ascii')) <= 4096)
    return record


def validate_goal(goal, ownership, plan):
    require(isinstance(goal, dict) and set(goal) == {'operation', 'operation_id', 'installed_version', 'replacement'})
    require(goal['operation'] in ('disable', 'remove', 'replace') and isinstance(goal['operation_id'], str)
            and UUID.fullmatch(goal['operation_id']))
    require_package_version(goal['installed_version'])
    require(ownership['package'] == 'remarkable-buddies-' + goal['installed_version'])
    require((plan is not None) == (goal['operation'] == 'remove'))
    r = goal['replacement']
    if goal['operation'] != 'replace':
        require(r is None)
    else:
        require(isinstance(r, dict) and set(r) == {'candidate', 'profile_sha256', 'plan'})
        c = r['candidate']
        require(isinstance(c, dict) and set(c) == {'nonce', 'version', 'apk_sha256', 'index_sha256'})
        import re
        require(isinstance(c['nonce'], str) and re.fullmatch('[0-9a-f]{32}', c['nonce']))
        require_package_version(c['version'])
        require(c['version'] != goal['installed_version'])
        require(all(isinstance(x, str) and DIGEST.fullmatch(x)
                    for x in (c['apk_sha256'], c['index_sha256'], r['profile_sha256'])))
        p = r['plan']
        require(isinstance(p, dict) and set(p) == {'ownership', 'candidate_version', 'apk_sha256',
                'index_sha256', 'world_sha256', 'other_world_sha256', 'solver_sha256'})
        require(p['ownership'] == ownership and p['candidate_version'] == c['version']
                and all(p[k] == c[k] for k in ('apk_sha256', 'index_sha256')))
        require(all(isinstance(p[k], str) and DIGEST.fullmatch(p[k])
                    for k in ('world_sha256', 'other_world_sha256', 'solver_sha256')))
    return goal


def preflight(stop):
    """Bound every existing downstream format before the first possible command."""
    bounded(stop)
    # Existing recovery receipts contain these six strict identities, at most64 bytes each.
    stock = {k: 'f' * 64 for k in ('boot_id', 'activation_id', 'lease_sha256',
                                  'recovery_invocation', 'reader_invocation', 'sync_invocation')}
    bounded({'version': 1, 'stop': stop, 'stock': stock})
    if stop['goal']['operation'] == 'replace':
        bounded({'version': 1, 'stop': stop, 'stock': stock, **stop['goal']['replacement']})


class IntentLease:
    """Native nonblocking lock, beyond the bounded JSON bytes on Windows.

    Reserve byte2**32, far beyond all supported bounded reads, including
    their extra oversize guard byte. Locking beyond EOF never extends the
    file or relaxes its4096-byte cap; readers use their existing bounds. The owning handle stays open until
    coordinator exit; kernel process death releases the lock on both platforms.
    """
    def __init__(self, fd):
        self.fd = os.dup(fd)
        try:
            if sys.platform == 'linux':
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif sys.platform == 'win32':
                import ctypes
                from ctypes import wintypes
                import msvcrt
                class Overlapped(ctypes.Structure):
                    _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                                ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD),
                                ('hEvent', wintypes.HANDLE)]
                self.overlapped = Overlapped(Offset=0, OffsetHigh=1)
                self.handle = msvcrt.get_osfhandle(self.fd)
                self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                self.kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                                   wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
                self.kernel.LockFileEx.restype = wintypes.BOOL
                if not self.kernel.LockFileEx(self.handle, 3, 0, 1, 0, ctypes.byref(self.overlapped)):
                    raise ctypes.WinError(ctypes.get_last_error())
            else:
                raise ValueError('Unsupported prior-writer exclusion')
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise

    def close(self):
        if self.fd is not None:
            # Closing the exact owning handle releases its native lock.
            os.close(self.fd)
            self.fd = None


@contextmanager
def initial_lease():
    held = []
    token = LEASE_SINK.set(held)
    try:
        yield
    finally:
        LEASE_SINK.reset(token)
        for lease in held:
            lease.close()


@contextmanager
def retained_lease(path):
    """Never wait on or replace the original inode; reject a competing writer."""
    flags = os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    from wired_observer import private_bytes
    private_bytes(path, parent_private=True, maximum=4096)
    fd = os.open(path, flags)
    lease = None
    token = None
    try:
        before = os.fstat(fd)
        require(before.st_nlink == 1 and before.st_size <= 4096)
        lease = IntentLease(fd)
        after = os.stat(path, follow_symlinks=False)
        require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino))
        token = RETAINED_READ.set(str(path))
        yield
        after = os.stat(path, follow_symlinks=False)
        require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino))
    finally:
        if token is not None:
            RETAINED_READ.reset(token)
        if lease:
            lease.close()
        os.close(fd)
