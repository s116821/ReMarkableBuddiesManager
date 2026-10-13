"""Actual owned SSH with explicit synthetic CLI lines/metadata; not physical/native proof."""
import hashlib
import json
from pathlib import Path
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'host'));sys.path.insert(0,str(ROOT/'tests/wired'))
import runtime_identity_transport as r
import wired_observer as o
from test_observer import Peer, Files
import paramiko
BOOT='11111111-1111-1111-1111-111111111111'
BASE={'generation':1};IDENTITY=hashlib.sha256(json.dumps(BASE,sort_keys=True).encode()).hexdigest()
class Notice:
    def recv(self,_):time.sleep(.01);raise socket.timeout()
    def close(self):pass
class VersionPeer(Peer):
    def __init__(self,line,code=0,mode='normal'):super().__init__();self.line,self.code,self.mode,self.stats=line,code,mode,0
    def check_channel_exec_request(self,channel,command):
        if command.decode()==o.COMMAND:return super().check_channel_exec_request(channel,command)
        self.commands.append(command.decode())
        if command.decode()!=r.COMMAND:return False
        def send():channel.sendall(self.line);channel.send_stderr(b'PRIVATE_STDERR_SENTINEL');channel.send_exit_status(self.code);channel.shutdown_write()
        threading.Thread(target=send,daemon=True).start();return True
class BinaryFiles(Files):
    def stat(self,path):
        if path in ['/opt','/opt/bin']:
            v=paramiko.SFTPAttributes();v.st_mode=stat.S_IFDIR|0o755;v.st_uid=0;v.st_gid=0;v.st_size=4096;v.st_mtime=1
            if self.peer.mode=='unsafe-parent':v.st_mode|=0o002
            return v
        if path!=r.BINARY:return super().stat(path)
        self.peer.stats+=1
        if self.peer.mode=='missing':return paramiko.SFTP_NO_SUCH_FILE
        v=paramiko.SFTPAttributes();v.st_mode=stat.S_IFREG|0o755;v.st_uid=0;v.st_gid=0;v.st_size=100;v.st_mtime=1
        if self.peer.mode=='unsafe':v.st_mode=stat.S_IFLNK|0o777
        if self.peer.mode=='changed' and self.peer.stats>1:v.st_size=101
        return v
    lstat=stat
class Identity(unittest.TestCase):
    def test_exact_cli_lines_and_executable_metadata_guard(self):
        self.assertIsNotNone(r.LINE.fullmatch(b'remarkable-reader-buddy 0.1.4\n'))
        fixtures=json.loads((ROOT/'tests/fixtures/runtime-version-lines.json').read_text())
        for line in fixtures['lines']:
            self.assertEqual(r.LINE.fullmatch(line.encode())[1].decode(),line.split(' ',1)[1].rstrip('\n'))
        for token in ['dev.anything','dev.unknown-dirty','dev.v0.2.0-73-gNOTHEX','dev./secret','dev.'+'a'*97]:
            match=r.LINE.fullmatch(('remarkable-reader-buddy '+token+'\n').encode())
            self.assertTrue(match is None or len(match[1])>96)
        for line in [b'other 0.1.4\n',b'reader-buddy 0.1.4\nSECRET\n',b'reader-buddy PRIVATE_SENTINEL\n',b'reader-buddy 0.1.4\x00\n']:self.assertIsNone(r.LINE.fullmatch(line))
        transport=Mock()
        with patch.object(r.shared,'inspect',return_value={'boot_id':'22222222-2222-2222-2222-222222222222'}):
            with self.assertRaises(o.Refusal):r.inspect_runtime(transport,BOOT)
        transport.open_session.assert_not_called()
    @unittest.skipUnless(sys.platform=='linux','Owned POSIX socket/private-key fixture; no native Windows claim')
    def test_actual_ssh_positive_missing_unsafe_malformed_unsupported_and_changed_binary(self):
        cases=[(b'remarkable-reader-buddy dev.v0.2.0-73-g6254092\n',0,'normal','reported'),(b'remarkable-reader-buddy dev.unknown\n',0,'normal','reported'),(b'reader-buddy 0.1.4-dev-synthetic\n',0,'normal','reported'),(b'PRIVATE_STDOUT_SENTINEL',0,'normal','unsupported'),(b'',2,'normal','unsupported'),(b'',0,'missing','missing'),(b'',0,'unsafe','unsafe'),(b'',0,'unsafe-parent','unsafe'),(b'reader-buddy 0.1.4\n',0,'changed',None)]
        for line,code,mode,expected in cases:
            with self.subTest(mode=mode,status=expected),tempfile.TemporaryDirectory() as folder:
                key=paramiko.RSAKey.generate(2048);p=Path(folder)/'identity';key.write_private_key_file(str(p));p.chmod(0o600)
                hostkey=paramiko.RSAKey.generate(2048);client,server=socket.socketpair();peer=VersionPeer(line,code,mode)
                transport=paramiko.Transport(server);transport.add_server_key(hostkey);transport.set_subsystem_handler('sftp',paramiko.SFTPServer,BinaryFiles);transport.start_server(event=threading.Event(),server=peer)
                try:
                    def read():return o.observe({'host_key_sha256':o.fingerprint(hostkey),'identity_file':str(p)},snapshot=lambda _:BASE,dial=lambda _:client,notices=Notice(),expected_connection=IDENTITY,inspection=lambda t:r.inspect_runtime(t,BOOT))
                    if expected is None:
                        with self.assertRaises(o.Refusal):read()
                    else:
                        result=read();self.assertEqual(result['_runtime_identity']['status'],expected);self.assertIsNone(result['_runtime_identity']['running_version']);self.assertFalse(result['_runtime_identity']['installation_eligible']);self.assertNotIn('PRIVATE_',json.dumps(result))
                    self.assertEqual(peer.commands,[o.COMMAND,o.COMMAND] if mode in ('missing','unsafe','unsafe-parent') else [o.COMMAND,r.COMMAND] if mode=='changed' else [o.COMMAND,r.COMMAND,o.COMMAND])
                finally:transport.close();server.close();client.close()
if __name__=='__main__':unittest.main()
