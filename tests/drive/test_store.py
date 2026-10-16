"""Real temporary host custody tests, separate from OAuth protocol and USB evidence."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

script = Path(__file__).resolve().parents[2] / 'host/drive_store.py'
spec = importlib.util.spec_from_file_location('drive_store', script)
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class Custody(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='manager-drive-custody-')
        self.parent = Path(self.temporary.name).resolve()
        self.root = self.parent / 'private'
        if sys.platform == 'win32':
            import win32api, win32con, win32file, win32security as security, pywintypes, ntsecuritycon
            token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
            try: user = security.GetTokenInformation(token, security.TokenUser)[0]
            finally: token.Close()
            acl = security.ACL(); acl.AddAccessAllowedAce(security.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, user)
            descriptor = security.SECURITY_DESCRIPTOR(); descriptor.SetSecurityDescriptorOwner(user, False); descriptor.SetSecurityDescriptorDacl(True, acl, False)
            descriptor.SetSecurityDescriptorControl(security.SE_DACL_PROTECTED, security.SE_DACL_PROTECTED)
            attributes = pywintypes.SECURITY_ATTRIBUTES(); attributes.SECURITY_DESCRIPTOR = descriptor
            win32file.CreateDirectory(str(self.root), attributes)
            security.SetNamedSecurityInfo(str(self.root), security.SE_FILE_OBJECT,
                security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
        else: self.root.mkdir(mode=0o700)
        with store.exclusive(self.root / 'client.json') as stream: stream.write(b'{"schema":1}')
        self.client = store.identity(store.private_read(self.root, 'client'))

    def tearDown(self):
        self.temporary.cleanup()

    def save(self, value, previous=None):
        return store.operate(self.root, {'operation': 'save', 'client_digest': self.client, 'grant_digest': previous, 'value': value})

    def test_real_owner_custody_atomic_save_replace_and_disconnect(self):
        first = self.save({'token': 'synthetic-custody-secret', 'label': 'multiline\nUnicode ✓'})
        observed = store.operate(self.root, {'operation': 'read-grant'})
        self.assertEqual(observed['digest'], first['digest']); self.assertEqual(observed['value']['label'], 'multiline\nUnicode ✓')
        second = self.save({'token': 'synthetic-replaced'}, first['digest'])
        self.assertNotEqual(first['digest'], second['digest'])
        self.assertEqual({p.name for p in self.root.iterdir()}, {'client.json', 'grant.json'})
        store.operate(self.root, {'operation': 'disconnect', 'client_digest': self.client, 'grant_digest': second['digest']})
        self.assertIsNone(store.private_read(self.root, 'grant'))
        self.assertEqual({p.name for p in self.root.iterdir()}, {'client.json'})

    def test_stale_client_or_grant_cas_does_not_replace_any_bytes(self):
        initial = self.save({'token': 'synthetic-original'}); raw = store.private_read(self.root, 'grant')
        for client, grant in [('0'*64, initial['digest']), (self.client, '0'*64), (self.client, None)]:
            with self.assertRaises(ValueError): store.operate(self.root, {'operation': 'save', 'client_digest': client, 'grant_digest': grant, 'value': {'token': 'synthetic-wrong'}})
            self.assertEqual(store.private_read(self.root, 'grant'), raw)
            self.assertEqual({p.name for p in self.root.iterdir()}, {'client.json', 'grant.json'})

    def test_duplicate_json_oversize_and_arbitrary_action_refuse(self):
        with self.assertRaises(ValueError): store.parse(b'{"token":1,"token":2}')
        with self.assertRaises(ValueError): store.parse(b' '*(store.MAXIMUM+1))
        with self.assertRaises(ValueError): store.operate(self.root, {'operation': 'read-client', 'path': '/other'})
        with self.assertRaises(ValueError): store.operate(self.root, {'operation': 'read-other'})

    def test_actual_child_failure_is_sanitized_and_has_no_stderr(self):
        raw = json.dumps({'operation': 'unapproved', 'token': 'synthetic-error-sentinel'}).encode()
        completed = subprocess.run([sys.executable, '-I', '-B', str(script), str(self.root)], input=raw, capture_output=True, timeout=5)
        self.assertEqual(completed.returncode, 1); self.assertEqual(completed.stderr, b'')
        self.assertEqual(completed.stdout.strip(), b'{"error":"protected-storage-unavailable"}')
        self.assertNotIn(b'synthetic-error-sentinel', completed.stdout)

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX permission/link semantics')
    def test_modes_links_and_hardlinks_refuse_without_widening(self):
        initial = self.save({'token': 'synthetic'}); file = self.root/'grant.json'
        file.chmod(0o644)
        with self.assertRaises(ValueError): store.private_read(self.root, 'grant')
        self.assertEqual(file.stat().st_mode & 0o777, 0o644); file.chmod(0o600)
        os.link(file, self.root/'linked')
        with self.assertRaises(ValueError): store.private_read(self.root, 'grant')
        (self.root/'linked').unlink(); file.unlink(); file.symlink_to(self.root/'client.json')
        with self.assertRaises(ValueError): store.private_read(self.root, 'grant')
        self.assertTrue(file.is_symlink()); self.assertIsNotNone(initial)

    @unittest.skipUnless(sys.platform == 'win32', 'Actual owner-only NTFS ACL control')
    def test_actual_broad_ntfs_grant_refuses(self):
        import win32security as security, ntsecuritycon
        self.save({'token': 'synthetic'}); file = self.root/'grant.json'
        descriptor = security.GetNamedSecurityInfo(str(file), security.SE_FILE_OBJECT, security.DACL_SECURITY_INFORMATION)
        acl = descriptor.GetSecurityDescriptorDacl(); acl.AddAccessAllowedAce(security.ACL_REVISION, ntsecuritycon.FILE_GENERIC_READ, security.ConvertStringSidToSid('S-1-1-0'))
        security.SetNamedSecurityInfo(str(file), security.SE_FILE_OBJECT, security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
        with self.assertRaises(Exception): store.private_read(self.root, 'grant')


if __name__ == '__main__': unittest.main()
