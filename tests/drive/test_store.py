"""Real temporary host custody tests, separate from OAuth protocol and USB evidence."""
import importlib.util
import base64
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

script = Path(__file__).resolve().parents[2] / 'host/drive_store.py'
sys.path.insert(0, str(script.parent))
from wired_observer import Refusal

spec = importlib.util.spec_from_file_location('drive_store', script)
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


def original(n=1, *, actor=None, epoch=None, padding=0):
    def uid(index):
        return f'00000000-0000-4000-8000-{index:012d}'
    token = {'actor': actor or uid(1), 'sha256': 'a' * 64}
    body = {'control_version': 1, 'operation': uid(100 + n), 'expected': token}
    raw = json.dumps(body, separators=(',', ':')).encode() + b' ' * padding
    return {
        'reference': f'{n:064x}', 'connection_id': 'b' * 64, 'boot_id': uid(2),
        'snapshot': {'device': uid(3), 'epoch': epoch or uid(200 + n), 'token': token,
                     'mode': {'kind': 'isolated-backup', 'backup': uid(4), 'binding_sha256': 'c' * 64}},
        'input_base64': base64.b64encode(raw).decode('ascii'), 'input_sha256': store.identity(raw),
    }


def tablet_original(n=1, *, intent='connect', connection=None):
    def uid(index):
        return f'00000000-0000-4000-8000-{index:012d}'
    present = {'kind': 'present', 'sha256': 'c' * 64, 'binding_sha256': 'd' * 64, 'collection': uid(10)}
    absent = {'kind': 'absent'}
    return {
        'reference': f'{n:064x}', 'connection_id': connection or f'{100 + n:064x}', 'boot_id': uid(2), 'intent': intent,
        'readback': {
            'control_version': 1, 'action': 'readback', 'operation': uid(100 + n),
            'original': {'config_sha256': 'a' * 64, 'credential_path_sha256': 'b' * 64,
                         'parent_identity_sha256': 'f' * 64, 'device': uid(3), 'epoch': uid(11),
                         'mode': {'kind': 'local-only'}, 'mode_token': {'actor': uid(1), 'sha256': 'a' * 64},
                         'slot': absent if intent == 'connect' else dict(present, metadata_sha256='e' * 64)},
            'desired': present if intent == 'connect' else absent,
        },
    }


def tablet_binding(entry):
    original = entry['readback']['original']
    slot = entry['readback']['desired'] if entry['intent'] == 'connect' else original['slot']
    return {'connection_id': entry['connection_id'], 'device': original['device'],
            'collection': slot['collection'], 'binding_sha256': slot['binding_sha256']}


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

    def test_distributed_client_preserves_private_precedence_and_rejects_drift(self):
        resource = self.parent / 'google-drive-client-id'
        fresh = self.parent / 'fresh' / 'drive-auth'
        first_id = b'1234567890-synthetic.apps.googleusercontent.com'
        with patch.object(store, 'PUBLIC_CLIENT', resource):
            self.assertIsNone(store.credential_read(fresh, 'client'))
            resource.write_bytes(first_id + b'\r\n')
            record = store.operate(fresh, {'operation': 'read-client'})
            self.assertEqual(record['value']['clientId'], first_id.decode())
            self.assertIsNone(record['value']['clientSecret'])
            request = {'operation': 'save', 'client_digest': record['digest'],
                       'grant_digest': None, 'value': {'token': 'synthetic'}}
            resource.write_bytes(b'1234567890-replacement.apps.googleusercontent.com')
            with self.assertRaises(ValueError):
                store.operate(fresh, request)
            self.assertFalse(fresh.parent.exists())
            for invalid in (b'', first_id + b'\n\n', b'{"client_secret":"synthetic"}', b'x' * 257):
                resource.write_bytes(invalid)
                with self.assertRaises(ValueError):
                    store.credential_read(fresh, 'client')
                self.assertEqual(store.operate(self.root, {'operation': 'read-client'})['digest'], self.client)
            resource.write_bytes(first_id)
            with store.exclusive(self.root / 'invalid-client') as stream:
                stream.write(b'invalid private registration')
            (self.root / 'invalid-client').replace(self.root / 'client.json')
            with self.assertRaises(ValueError):
                store.credential_read(self.root, 'client')

    def retained(self):
        return store.operate(self.root, {'operation': 'read-isolated-root-operations'})

    def append(self, entry, expected=None):
        return store.operate(self.root, {
            'operation': 'append-isolated-root-operation', 'record': entry, 'expected_digest': expected,
        })

    def append_child(self, entry, expected=None):
        request = {'operation': 'append-isolated-root-operation', 'record': entry, 'expected_digest': expected}
        return subprocess.run([sys.executable, '-I', '-B', str(script), str(self.root)],
                              input=json.dumps(request).encode(), capture_output=True, timeout=5)

    def tablet_read(self):
        return store.operate(self.root, {'operation': 'read-tablet-drive-operations'})

    def tablet_save(self, originals, expected=None, *, bindings=()):
        return store.operate(self.root, {'operation': 'save-tablet-drive-operations',
            'value': {'version': 1, 'originals': originals, 'bindings': list(bindings)}, 'expected_digest': expected})

    def test_tablet_originals_survive_restart_and_resolve_by_cas(self):
        self.save({'token': 'synthetic-original-alone'})
        credentials = [store.private_read(self.root, key) for key in ('client', 'grant')]
        self.assertEqual(self.tablet_read(), {'digest': None, 'value': None})
        first, second = tablet_original(), tablet_original(2, intent='remove')
        binding = tablet_binding(second)
        prior = self.tablet_save([first])
        current = self.tablet_save([first, second], prior['digest'], bindings=[binding])
        child = subprocess.run([sys.executable, '-I', '-B', str(script), str(self.root)],
            input=b'{"operation":"read-tablet-drive-operations"}', capture_output=True, timeout=5)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(child.stderr, b'')
        self.assertEqual(json.loads(child.stdout), {
            'digest': current['digest'], 'value': {'version': 1, 'originals': [first, second], 'bindings': [binding]}})
        self.assertNotIn(b'synthetic-original-alone', child.stdout)
        with self.assertRaises(ValueError):
            self.tablet_save([], prior['digest'])
        resolved = self.tablet_save([second], current['digest'], bindings=[binding])
        empty = self.tablet_save([], resolved['digest'], bindings=[binding])
        self.assertEqual(self.tablet_read(), {
            'digest': empty['digest'], 'value': {'version': 1, 'originals': [], 'bindings': [binding]}})
        self.assertEqual([store.private_read(self.root, key) for key in ('client', 'grant')], credentials)
        self.assertFalse((self.root / store.NAMES[store.RETENTION]).exists())

    def test_tablet_binding_shape_capacity_and_unique_target(self):
        entries = [tablet_binding(tablet_original(n)) for n in range(1, 10)]
        shared_connection = dict(entries[0], device='00000000-0000-4000-8000-000000000099')
        initial = self.tablet_save([], bindings=[entries[0], shared_connection])
        for bindings in (
            [entries[0], entries[0]],
            [entries[0], dict(entries[0], collection=shared_connection['device'])],
            [dict(entries[0], credential_b64='synthetic-no-storage')],
            [dict(entries[0], collection='00000000-0000-0000-0000-000000000000')],
            [dict(entries[0], device=entries[0]['device'] + '\n')],
            [dict(entries[0], binding_sha256=True)],
            entries,
        ):
            with self.assertRaises(ValueError):
                self.tablet_save([], initial['digest'], bindings=bindings)
        updated = self.tablet_save([], initial['digest'], bindings=entries[:8])
        with self.assertRaises(ValueError):
            self.tablet_save([], initial['digest'])
        self.assertEqual(self.tablet_read(), {
            'digest': updated['digest'], 'value': {'version': 1, 'originals': [], 'bindings': entries[:8]}})

    def test_pending_tablet_original_reserves_binding_capacity_across_cas_writers(self):
        entries = [tablet_binding(tablet_original(n)) for n in range(1, 9)]
        pending = tablet_original(9)
        full = self.tablet_save([], bindings=entries)
        before = self.tablet_read()
        with self.assertRaises(ValueError):
            self.tablet_save([pending], full['digest'], bindings=entries)
        self.assertEqual(self.tablet_read(), before)
        same = self.tablet_save([tablet_original(1)], full['digest'], bindings=entries)
        reserved = self.tablet_save([pending], same['digest'], bindings=entries[:7])
        before = self.tablet_read()
        with self.assertRaises(ValueError):
            self.tablet_save([pending], reserved['digest'], bindings=entries)
        self.assertEqual(self.tablet_read(), before)
        final = self.tablet_save([], reserved['digest'], bindings=[*entries[:7], tablet_binding(pending)])
        self.assertEqual(self.tablet_read()['digest'], final['digest'])

    def test_tablet_originals_cannot_be_overwritten_or_replaced_in_same_cas(self):
        first = tablet_original()
        version = self.tablet_save([first])
        changed = deepcopy(first)
        changed['readback']['desired']['sha256'] = '0' * 64
        same_connection = tablet_original(2, connection=first['connection_id'])
        for originals in ([changed], [same_connection], [first, same_connection],
                          [first, dict(tablet_original(2), reference=first['reference'])]):
            with self.assertRaises(ValueError):
                self.tablet_save(originals, version['digest'])
        self.assertEqual(self.tablet_read()['value']['originals'], [first])
        complete = self.tablet_save([tablet_original(n) for n in range(1, 9)], version['digest'])
        with self.assertRaises(ValueError):
            self.tablet_save([tablet_original(n) for n in range(1, 10)], complete['digest'])
        self.assertEqual(len(self.tablet_read()['value']['originals']), 8)

    def test_tablet_store_rejects_corrupt_or_secret_bearing_custody(self):
        path = self.root / store.NAMES[store.TABLET_DRIVE]
        sample = tablet_original()
        token = b'synthetic-secret-bearing-record'
        extra = dict(sample, extra=token.decode())
        secret = deepcopy(sample)
        secret['readback']['desired']['credential_b64'] = token.decode()
        wrong_action = deepcopy(sample)
        wrong_action['readback']['action'] = 'apply'
        foreign_binding = tablet_original(intent='remove')
        foreign_binding['readback']['original']['mode'] = {
            'kind': 'isolated-backup', 'backup': foreign_binding['boot_id'], 'binding_sha256': '1' * 64}
        for record in [extra, secret, wrong_action, foreign_binding, dict(sample, intent='remove')]:
            with self.assertRaises(ValueError):
                self.tablet_save([record])
            self.assertFalse(path.exists())
        for raw in [
            b'{"version":1,"version":1,"originals":[],"bindings":[]}',
            store.compact({'version': 1, 'originals': [secret], 'bindings': []}),
            store.compact({'version': 1, 'originals': []}),
            store.compact({'version': 1, 'originals': [], 'bindings': []}).ljust(store.MAX_TABLET_DRIVE + 1),
        ]:
            with store.exclusive(path) as stream:
                stream.write(raw)
            with self.assertRaises((ValueError, Refusal)):
                self.tablet_read()
            with self.assertRaises((ValueError, Refusal)):
                self.tablet_save([sample], store.identity(raw))
            self.assertEqual(path.read_bytes(), raw)
            path.unlink()

    def test_isolated_append_cas_and_capacity_preserve_credential_bytes(self):
        self.save({'token': 'synthetic-original'})
        credentials = [store.private_read(self.root, k) for k in ('client', 'grant')]
        self.assertEqual(self.retained(), {'value': None, 'digest': None})
        self.assertFalse((self.root / store.RETENTION_LOCK).exists())
        first = original(padding=7)
        version = self.append(first)
        self.assertEqual(self.retained(), {'value': {'version': 1, 'originals': [first]}, 'digest': version['digest']})
        with self.assertRaises(ValueError):
            self.append(original(2))
        with self.assertRaises(ValueError):
            self.append(original(2), '0' * 64)
        for n in range(2, 9):
            version = self.append(original(n), version['digest'])
        before = self.retained()
        with self.assertRaises(ValueError):
            self.append(original(9), version['digest'])
        self.assertEqual(self.retained(), before)
        self.assertEqual([store.private_read(self.root, k) for k in ('client', 'grant')], credentials)
        self.assertTrue((self.root / store.RETENTION_LOCK).is_file())

    def test_isolated_rejects_invalid_and_duplicate_originals(self):
        first = original()
        state = self.append(first)
        second = original(2)
        raw = base64.b64decode(second['input_base64'])
        duplicate_json = b'{"control_version":1,' + raw[1:]
        tampered_token = json.dumps(dict(json.loads(raw), expected={'actor': first['snapshot']['token']['actor'],
                                      'sha256': 'd'*64})).encode()
        nil_uuid = '00000000-0000-0000-0000-000000000000'
        for invalid in [
            {**second, 'extra': True}, {**second, 'input_sha256': '0'*64},
            {**second, 'input_base64': second['input_base64'] + '='},
            {**second, 'input_base64': 'YR==', 'input_sha256': store.identity(b'a')},
            {**second, 'input_base64': base64.b64encode(duplicate_json).decode(),
             'input_sha256': store.identity(duplicate_json)},
            {**second, 'input_base64': base64.b64encode(tampered_token).decode(),
             'input_sha256': store.identity(tampered_token)},
            {**second, 'boot_id': nil_uuid}, {**second, 'reference': first['reference']},
            original(2, epoch=first['snapshot']['epoch']), original(2, padding=512),
        ]:
            with self.subTest(reference=invalid['reference']), self.assertRaises(ValueError):
                self.append(invalid, state['digest'])
        self.assertEqual(self.retained()['value']['originals'], [first])

    def test_isolated_existing_corrupt_or_oversize_journal_is_preserved(self):
        path = self.root / store.NAMES[store.RETENTION]
        first, second = original(), original(2)
        bad = deepcopy(second)
        bad['input_sha256'] = '0' * 64
        for raw in [
            b'{"version":1,"version":1,"originals":[]}',
            store.compact({'version': 2, 'originals': []}),
            store.compact({'version': 1, 'originals': [first, first]}),
            store.compact({'version': 1, 'originals': [first, bad]}),
            store.compact({'version': 1, 'originals': [original(n) for n in range(1, 10)]}),
            store.compact({'version': 1, 'originals': []}) + b' ' * store.MAX_RETENTION,
        ]:
            with store.exclusive(path) as stream:
                stream.write(raw)
            with self.assertRaises((ValueError, Refusal)):
                self.retained()
            with self.assertRaises((ValueError, Refusal)):
                self.append(second, store.identity(raw))
            self.assertEqual(path.read_bytes(), raw)
            path.unlink()

    def test_isolated_writer_process_exit_releases_lock_without_touching_oauth(self):
        self.save({'token': 'synthetic-preserved'})
        credentials = [store.private_read(self.root, k) for k in ('client', 'grant')]
        first = self.append(original())
        ready = self.parent / 'lock-held'
        # Interrupt an actual append after it syncs the stage and before it
        # replaces the journal. The next writer must leave the old stage alone.
        code = ('import json,sys,time; from pathlib import Path; '
                'sys.path.insert(0,sys.argv[1]); import drive_store as s\n'
                'def pause(stage, _):\n'
                ' Path(sys.argv[3]).write_text(stage.name); time.sleep(30)\n'
                's.os.replace = pause\n'
                's.operate(Path(sys.argv[2]), json.loads(sys.argv[4]))\n')
        next_request = {'operation': 'append-isolated-root-operation',
                        'record': original(2), 'expected_digest': first['digest']}
        holder = subprocess.Popen([sys.executable, '-I', '-B', '-c', code,
                                   str(script.parent), str(self.root), str(ready), json.dumps(next_request)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 4
            while not ready.exists() and holder.poll() is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            contended = self.append_child(original(2), first['digest'])
            self.assertEqual(contended.returncode, 1)
            self.assertEqual(contended.stdout.strip(), b'{"error":"protected-storage-unavailable"}')
            self.assertEqual(contended.stderr, b'')
            self.assertEqual(self.retained()['digest'], first['digest'])
            # The unrelated OAuth writer can commit in parallel with retention.
            self.save({'token': 'synthetic-preserved'}, store.identity(credentials[1]))
        finally:
            if holder.poll() is None:
                holder.kill()
            holder.wait(timeout=5)
        stage = self.root / ready.read_text()
        staged_bytes = stage.read_bytes()
        resumed = self.append_child(original(2), first['digest'])
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertTrue(json.loads(resumed.stdout)['committed'])
        self.assertEqual(self.retained()['value']['originals'], [original(), original(2)])
        self.assertEqual([store.private_read(self.root, k) for k in ('client', 'grant')], credentials)
        self.assertTrue((self.root / store.RETENTION_LOCK).is_file())
        self.assertEqual(stage.read_bytes(), staged_bytes)

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX permission/link semantics')
    def test_isolated_writer_refuses_foreign_lock_without_repair(self):
        lock = self.root / store.RETENTION_LOCK
        lock.symlink_to(self.root / 'client.json')
        with self.assertRaises(OSError):
            self.append(original())
        self.assertTrue(lock.is_symlink())
        self.assertEqual(self.retained()['value'], None)

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
