"""Shared Win32 open and handle checks for fixed host resources."""
from contextlib import contextmanager


@contextmanager
def checked_handle(path, *, directory, access, share):
    import win32con
    import win32file

    handle = win32file.CreateFile(
        str(path), access, share, None, win32con.OPEN_EXISTING,
        win32file.FILE_FLAG_OPEN_REPARSE_POINT | win32con.FILE_FLAG_BACKUP_SEMANTICS, None)
    try:
        info = win32file.GetFileInformationByHandle(handle)
        if (info[0] & win32con.FILE_ATTRIBUTE_REPARSE_POINT
                or bool(info[0] & win32con.FILE_ATTRIBUTE_DIRECTORY) != directory
                or (not directory and info[7] != 1)):
            raise ValueError('protected-storage-unavailable')
        yield handle
    finally:
        handle.Close()
