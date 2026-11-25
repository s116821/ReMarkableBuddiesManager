"""Hold the fixed Windows oracle resources for one Node verification."""
from contextlib import ExitStack
import ctypes
from ctypes import wintypes
from pathlib import Path
import re
import sys

FILE_ID_INFO_CLASS = 18  # FileIdInfo in FILE_INFO_BY_HANDLE_CLASS.


class FileIdInfo(ctypes.Structure):
    _fields_ = [('volume', ctypes.c_uint64), ('file_id', ctypes.c_ubyte * 16)]


def identity(path, handle, directory, get_file_info):
    import win32con
    import win32file

    info = win32file.GetFileInformationByHandle(handle)
    attrs, links = info[0], info[7]
    final = win32file.GetFinalPathNameByHandle(handle, 0)  # Normalized DOS-volume name.
    if (attrs & win32con.FILE_ATTRIBUTE_REPARSE_POINT
            or bool(attrs & win32con.FILE_ATTRIBUTE_DIRECTORY) != directory
            or (not directory and links != 1)
            or win32file.GetFileType(handle) != win32con.FILE_TYPE_DISK
            or not re.match(r'^\\\\\?\\[A-Za-z]:\\', final)
            or Path(final[4:]) != path):
        raise ValueError('resource-lock-unavailable')
    # FileIdInfo supplies the full identifier, including on ReFS.
    file_id = FileIdInfo()
    if (not get_file_info(int(handle), FILE_ID_INFO_CLASS, ctypes.byref(file_id), ctypes.sizeof(file_id))
            or not any(file_id.file_id)):
        raise ValueError('resource-lock-unavailable')
    return file_id.volume, bytes(file_id.file_id)


def hold(value, control, output):
    import win32con
    import win32file
    from ntsecuritycon import FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES
    from windows_resource_handle import checked_handle

    root = Path(value)
    if (not re.match(r'^[A-Za-z]:\\', value) or ':' in value[2:]
            or str(root) != value or root == root.parent
            or any(part.endswith(('.', ' ')) for part in root.parts[1:])
            or win32file.GetDriveType(root.anchor) != win32con.DRIVE_FIXED):
        raise ValueError('resource-lock-unavailable')

    directories = list(reversed((root, *root.parents)))
    files = (root / 'reader-buddy.exe', root / 'provenance.json')
    get_file_info = ctypes.WinDLL('kernel32').GetFileInformationByHandleEx
    get_file_info.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.POINTER(FileIdInfo), wintypes.DWORD]
    get_file_info.restype = wintypes.BOOL
    with ExitStack() as stack:
        held = []
        for item in (*directories, *files):
            directory = item in directories
            # A directory needs share-accounted access for deny-delete to apply.
            access = (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES if directory else win32con.GENERIC_READ)
            share = win32con.FILE_SHARE_READ | (win32con.FILE_SHARE_WRITE if directory else 0)
            handle = stack.enter_context(checked_handle(item, directory=directory, access=access, share=share))
            held.append((item, directory, handle, identity(item, handle, directory, get_file_info)))

        def confirm():
            for item, directory, handle, original in held:
                if identity(item, handle, directory, get_file_info) != original:
                    raise ValueError('resource-lock-unavailable')
                with checked_handle(item, directory=directory, access=FILE_READ_ATTRIBUTES,
                                    share=win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE) as current:
                    if identity(item, current, directory, get_file_info) != original:
                        raise ValueError('resource-lock-unavailable')

        confirm()
        output.write(b'ready\n')
        output.flush()
        command = control.readline(9)
        if command == b'confirm\n':
            confirm()
            output.write(b'confirmed\n')
            output.flush()
            command = control.read(1)
        if command != b'':
            raise ValueError('resource-lock-unavailable')


def main():
    if sys.platform != 'win32' or len(sys.argv) != 2:
        return 1
    sys.path.insert(0, str(Path(__file__).parent))
    try:
        hold(sys.argv[1], sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
