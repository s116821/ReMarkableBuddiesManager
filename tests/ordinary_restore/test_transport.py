"""Synthetic transport only; no tablet or producer execution."""
import base64
import hashlib
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'host'))
sys.path.insert(0,str(root/'tests/wired'))
import ordinary_restore_transport as q
import wired_observer as o
from test_observer import Peer, Files
import paramiko
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
V=json.loads((root/'tests/fixtures/ordinary-restore-reference-vectors.json').read_text(encoding='utf-8'))
BOOT='11111111-1111-1111-1111-111111111111'
BASELINE={'generation':1}
IDENTITY=hashlib.sha256(json.dumps(BASELINE,sort_keys=True).encode()).hexdigest()
def request(selector):
    context=V['context']
    action=selector.removesuffix('-notebook')
    version=2 if selector.endswith('-notebook') else 1
    body=({'restore_version':version,'operation':context['operation'],'source':context['source']} if action=='prepare' else {'source':context['source'],'intent':dict(context['intent'],restore_version=version,complete_media=True) if version==2 else context['intent']})
    return dict(selector=selector,connection_id=IDENTITY,boot_id=BOOT,budget_ms=12000,input_base64=base64.b64encode(json.dumps(body,separators=(',',':')).encode()).decode())
def report(selector):
    action=selector.removesuffix('-notebook')
    name={'prepare':'prepared-valid-target-media-differs-from-source','apply':'restored-exact-target','status':'desired-exact-target-not-receipt'}[action]
    raw=next(c['stdout_utf8'].encode('utf-8') for c in V['raw_cases'] if c['id']==name)
    if not selector.endswith('-notebook'):return raw
    v=json.loads(raw);v.update(report_version=2,operation=selector)
    if action=='prepare':
        v['data']['intent'].update(restore_version=2,complete_media=True)
        for kind in ('source','target'):v['data']['preview'][kind]['complete_media']=True
    else:v['data']['inspection']['complete_media']=True
    return (json.dumps(v,separators=(',',':'))+'\n').encode()
class Transport(unittest.TestCase):
    def channel(self,raw,code=0):
        c=Mock();c.recv_ready.side_effect=[True,False,False];c.recv.return_value=raw;c.recv_stderr_ready.return_value=False;c.exit_status_ready.return_value=True;c.recv_exit_status.return_value=code;t=Mock();t.open_session.return_value=c;return t,c
    def test_closed_original_input_and_caps(self):
        for selector in ('prepare','apply','status','prepare-notebook','apply-notebook','status-notebook'):
            value=request(selector);raw=json.dumps(value).encode();self.assertEqual(q.request(raw),value);self.assertEqual(q.request(raw+b' '*(24576-len(raw))),value)
            for bad in [dict(value,selector='list'),dict(value,selector=';echo'),dict(value,invocation=BOOT),dict(value,budget_ms=True),dict(value,input_base64=None),dict(value,input_base64='e30='),dict(value,path='/synthetic')]:
                with self.assertRaises((ValueError,TypeError)):q.request(json.dumps(bad).encode())
        for raw in [b'x'*24577,b'{"selector":0,"selector":1}',b'\xef\xbb\xbf{}',b'"\\ud800"']:
            with self.assertRaises((ValueError,UnicodeError)):q.request(raw)
    def test_fixed_family_versions_and_notebook_complete_media(self):
        for selector in ('prepare','apply','status','prepare-notebook','apply-notebook','status-notebook'):
            value=request(selector);body=json.loads(base64.b64decode(value['input_base64']))
            versioned=body if selector.startswith('prepare') else body['intent']
            versioned['restore_version']=1 if selector.endswith('-notebook') else 2
            value['input_base64']=base64.b64encode(json.dumps(body).encode()).decode()
            with self.assertRaises(ValueError):q.request(json.dumps(value).encode())
        for selector in ('apply-notebook','status-notebook'):
            value=request(selector);body=json.loads(base64.b64decode(value['input_base64']));body['intent']['complete_media']=False
            value['input_base64']=base64.b64encode(json.dumps(body).encode()).decode()
            with self.assertRaises(ValueError):q.request(json.dumps(value).encode())
        self.assertEqual(q.request(json.dumps(request('apply')).encode()),request('apply'))
    def test_wrong_path_domains_and_apply_wrapper_refuse(self):
        for field in ('config_path_sha256','source_path_sha256'):
            intent=dict(V['context']['intent']);intent[field]='0'*64
            with self.assertRaises(ValueError):q.intent(intent,V['context']['source'])
        value=request('status');body=json.loads(base64.b64decode(value['input_base64']));body['restore_version']=1
        value['input_base64']=base64.b64encode(json.dumps(body).encode()).decode()
        with self.assertRaises(ValueError):q.request(json.dumps(value).encode())
    def test_fixed_argv_exact_stdin_eof_bounds_and_identity(self):
        for selector in ('prepare','apply','status','prepare-notebook','apply-notebook','status-notebook'):
            value=request(selector);raw=report(selector);padded=raw[:-1]+b' '*(16384-len(raw))+b'\n';t,c=self.channel(padded)
            with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):result=q.execute(t,value)
            self.assertEqual(base64.b64decode(result['_ordinary_restore_raw']['stdout_base64']),padded)
            c.exec_command.assert_called_once_with(q.PREFIX+selector+' --restore-input -');c.sendall.assert_called_once_with(base64.b64decode(value['input_base64']));c.shutdown_write.assert_called_once();c.close.assert_called_once()
        for raw in [report('prepare')+b'\n',b'\xff\n',b'{}\n{}\n',b'x'*16385,b'{"report_version":1,"report_version":2}\n']:
            t,c=self.channel(raw)
            with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):
                try:self.assertIsNone(q.execute(t,request('prepare'))['_ordinary_restore_raw']['stdout_base64'])
                except (ValueError,UnicodeError):pass
            c.close.assert_called_once()
        t,c=self.channel(report('prepare'))
        with patch.object(q.shared,'inspect',side_effect=[{'boot_id':BOOT},{'boot_id':'changed'}]),self.assertRaises(o.Refusal):q.execute(t,request('prepare'))
        t=Mock()
        with patch.object(q.shared,'inspect',return_value={'boot_id':'changed'}),self.assertRaises(o.Refusal):q.execute(t,request('prepare'))
        t.open_session.assert_not_called()
    def test_deadline_before_open_and_future_report_preserved_privately(self):
        t=Mock()
        with patch.object(q.time,'monotonic',return_value=2),self.assertRaises(o.Refusal):q.execute(t,request('prepare'),deadline=1)
        t.open_session.assert_not_called()
        t,c=self.channel(b'{"report_version":2}\n')
        with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):self.assertEqual(q.execute(t,request('prepare'))['_ordinary_restore_raw']['status'],'reported')

class ModePeer(Peer):
    def __init__(self,selector):super().__init__();self.selector=selector;self.received=None
    def check_channel_exec_request(self,channel,command):
        if command.decode()==o.COMMAND:return super().check_channel_exec_request(channel,command)
        self.commands.append(command.decode())
        if command.decode()!=q.PREFIX+self.selector+' --restore-input -':return False
        def send():
            self.received=bytearray()
            while part:=channel.recv(4096):self.received.extend(part)
            channel.sendall(report(self.selector));channel.send_stderr(b'SYNTHETIC_PRIVATE_STDERR');channel.send_exit_status(0);channel.shutdown_write()
        threading.Thread(target=send,daemon=True).start();return True
class Notice:
    def recv(self,_):raise socket.timeout()
    def close(self):pass
def key(seed):
    p=ed25519.Ed25519PrivateKey.from_private_bytes(seed);b=p.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.OpenSSH,serialization.NoEncryption());return b,paramiko.Ed25519Key.from_private_key(io.StringIO(b.decode()))
class SSH(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='linux','POSIX local SSH fixture, no Windows native USB claim')
    def test_real_local_ssh_peer_all_three_selectors_exact_original_stdin(self):
        for selector in ('prepare','apply','status','prepare-notebook','apply-notebook','status-notebook'):
            with self.subTest(selector=selector),tempfile.TemporaryDirectory() as folder:
                client_bytes,_=key(bytes(range(32)));_,hostkey=key(bytes([7])*32);p=Path(folder)/'public-fixture';p.write_bytes(client_bytes);p.chmod(0o600)
                client,server=socket.socketpair();peer=ModePeer(selector);transport=paramiko.Transport(server);transport.add_server_key(hostkey);transport.set_subsystem_handler('sftp',paramiko.SFTPServer,Files);transport.start_server(event=threading.Event(),server=peer)
                try:
                    value=request(selector);observed=o.observe({'host_key_sha256':o.fingerprint(hostkey),'identity_file':str(p)},snapshot=lambda _:BASELINE,dial=lambda _:client,notices=Notice(),expected_connection=IDENTITY,inspection=lambda t:q.execute(t,value))
                    self.assertEqual(peer.commands,[o.COMMAND,q.PREFIX+selector+' --restore-input -',o.COMMAND]);self.assertEqual(peer.received,base64.b64decode(value['input_base64']));self.assertNotIn('SYNTHETIC_PRIVATE_STDERR',json.dumps(observed));self.assertEqual(base64.b64decode(observed['_ordinary_restore_raw']['stdout_base64']),report(selector))
                finally:transport.close();client.close();server.close()
