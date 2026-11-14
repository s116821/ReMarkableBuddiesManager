"""Read-only, original-only authority checks for one protected Drive capture."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from drive_store import checked_root, digest, identity, private_read, require


def check(root, root_identity, expected):
    require(checked_root(root) == root_identity)
    for kind, original in expected:
        require(identity(private_read(root, kind)) == original)
    require(checked_root(root) == root_identity)


def main():
    try:
        root = Path(sys.argv[1])
        initial = sys.stdin.buffer.readline(256)
        require(initial.endswith(b'\n') and len(initial) <= 255)
        originals = json.loads(initial)
        require(type(originals) is list and len(originals) == 2 and all(map(digest, originals)))
        expected = tuple(zip(('client', 'grant'), originals))
        root_identity = checked_root(root)
        require(root_identity is not None)
        check(root, root_identity, expected)
        sys.stdout.buffer.write(b'ok\n')
        sys.stdout.buffer.flush()
        while True:
            request = sys.stdin.buffer.readline(7)
            if not request:
                return
            require(request == b'check\n')
            check(root, root_identity, expected)
            sys.stdout.buffer.write(b'ok\n')
            sys.stdout.buffer.flush()
    except Exception:
        # The caller can distinguish a valid check from refusal or lost
        # transport without any path, digest, record or exception detail.
        sys.exit(1)


if __name__ == '__main__':
    main()
