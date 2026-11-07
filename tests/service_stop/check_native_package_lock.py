"""Actual kernel-lock/read-sharing checks. Run directly on Linux and Windows.

No network, tablet, provider, subprocess shell or mocks. Creates one protected
TemporaryDirectory; all child processes are exact owned Python processes.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

HOST = Path(__file__).resolve().parents[2] / 'host'
sys.path.insert(0, str(HOST))
from resident_package_goal import IntentLease, retained_lease
import resident_package_transition as transition


def protect(root):
    root.chmod(0o700)
    if sys.platform == 'win32':
        import win32api, win32con, win32security as security
        token=security.OpenProcessToken(win32api.GetCurrentProcess(),win32con.TOKEN_QUERY)
        try:user=security.GetTokenInformation(token,security.TokenUser)[0]
        finally:token.Close()
        acl=security.ACL()
        acl.AddAccessAllowedAce(security.ACL_REVISION,win32con.GENERIC_ALL,user)
        security.SetNamedSecurityInfo(str(root),security.SE_FILE_OBJECT,
            security.DACL_SECURITY_INFORMATION|security.PROTECTED_DACL_SECURITY_INFORMATION,None,None,acl,None)


class NativePackageLockTest(unittest.TestCase):
    def test_actual_retained_and_initial_writer_exclusion_readability_death(self):
        for mode in ('initial','retained'):
            with self.subTest(mode=mode), TemporaryDirectory() as directory:
                root=Path(directory);protect(root);path=root/'resident-stop.json'
                if mode=='retained':transition.write_private_record(path,{'version':1})
                source='''from pathlib import Path
import sys,time
from resident_package_goal import initial_lease,retained_lease
import resident_package_transition as t
from wired_observer import private_bytes
p=Path(sys.argv[1]);mode=sys.argv[2]
a=t.Activation('12345678-1234-1234-1234-123456789abc','22345678-1234-1234-1234-123456789abc','a'*64,'b'*64,'1'*32,10,'c'*64)
own={'boot_id':a.boot_id,'package':'remarkable-buddies-1.2.3-r2','database_sha256':'e'*64}
g={'operation':'disable','operation_id':'32345678-1234-1234-1234-123456789abc','installed_version':'1.2.3-r2','replacement':None}
with initial_lease() if mode=='initial' else retained_lease(p):
 if mode=='initial':t.record_intent(p,'d'*64,a,own,goal=g)
 # Read through the actual protected same-process reader AFTER initial writer's
 # stream closed, while its duplicated native lease handle remains alive.
 raw=private_bytes(p,parent_private=True,maximum=4096)
 print(__import__('hashlib').sha256(raw).hexdigest(),flush=True)
 sys.stdin.buffer.read(1)
'''
                child=subprocess.Popen([sys.executable,'-u','-c',source,str(path),mode],stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                    env=dict(os.environ,PYTHONPATH=str(HOST)))
                try:
                    line=child.stdout.readline().strip()
                    if len(line)!=64:
                        try:startup_out,startup_err=child.communicate(timeout=3)
                        except subprocess.TimeoutExpired:
                            child.kill();startup_out,startup_err=child.communicate(timeout=3)
                        self.fail(f'Native writer startup failed: first_stdout={line!r}; '
                                  f'remaining_stdout={startup_out!r}; stderr={startup_err!r}; exit={child.returncode}')
                    raw=path.read_bytes()
                    self.assertEqual(hashlib.sha256(raw).hexdigest(),line)
                    self.assertLessEqual(len(raw),4096);self.assertIsNone(child.poll())
                    fd=os.open(path,os.O_RDWR|getattr(os,'O_BINARY',0))
                    try:
                        # Direct native lock contention. A protected reader's
                        # Windows sharing refusal is NOT counted as lock proof.
                        with self.assertRaises(OSError):IntentLease(fd)
                    finally:os.close(fd)
                    self.assertEqual(path.read_bytes(),raw)
                    # The private reader's cap remains strict even though its
                    # reserved lock is beyond the extra guarded read byte.
                    oversized=root/'oversized.json'
                    with transition.exclusive(oversized,write_through=True) as stream:
                        stream.write(b'x'*4097)
                    from wired_observer import private_bytes
                    with self.assertRaises(transition.shared.Refusal) as refusal:
                        private_bytes(oversized,parent_private=True,maximum=4096)
                    self.assertEqual(refusal.exception.status,'unconfigured')
                    child.kill();child.wait(timeout=3)
                    self.assertEqual(child.stderr.read(),'')
                    with retained_lease(path):self.assertEqual(path.read_bytes(),raw)
                    with retained_lease(path):self.assertEqual(path.read_bytes(),raw)
                    print(json.dumps({'platform':sys.platform,'mode':mode,'excluded_actual_writer':True,
                        'same_process_reader':True,'parent_readable':True,'killed_child_reaped':True,
                        'reacquired_twice':True,'bytes':len(raw),'sha256':line}),flush=True)
                finally:
                    if child.poll() is None:child.kill();child.wait(timeout=3)
                    child.stdin.close();child.stdout.close();child.stderr.close()


if __name__=='__main__':unittest.main(verbosity=2)
