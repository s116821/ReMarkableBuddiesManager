"""Synthetic fixed-channel tests; these are not native producer captures."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'host'))
import portable_configuration_transport as q

BOOT='11111111-1111-4111-8111-111111111111'
REQUEST=dict(connection_id='a'*64,boot_id=BOOT,selector='inspect',input_base64=None,budget_ms=12000)
ARTIFACT=dict(portable_configuration_version=1,settings=dict(personalization=dict(enabled=False,text='PRIVATE_雪😀\r\n\t\b')))
INTENT=dict(portable_import_version=1,operation=BOOT,base_sha256='b'*64,target_sha256='c'*64,config_path_sha256=q.PATH_HASH,artifact_sha256='d'*64)
def request(selector, body=None):
    return dict(REQUEST,selector=selector,input_base64=base64.b64encode(json.dumps(body,ensure_ascii=False).encode()).decode() if body is not None else None)
def report(selector):
    if selector=='export':
        return dict(report_version=1,operation=selector,status='ok',runtime_activation='unverified',artifact=ARTIFACT,summary=dict(artifact_sha256='d'*64,declared_settings=1,personalization_included=True))
    return dict(report_version=1,operation=selector,status='unsupported',outcome='read-only' if selector in ('inspect','status') else 'not-dispatched',disk_readback_verified=False,runtime_activation='unverified',data=None)
class Transport(unittest.TestCase):
    def test_exact_private_packets_limits_numeric_alias_and_no_unsafe_selector(self):
        prepare=dict(portable_import_version=1,operation=BOOT,base_sha256='b'*64,config_path_sha256=q.PATH_HASH,artifact=ARTIFACT)
        for selector,body in [('export',None),('inspect',None),('prepare',prepare),('apply',dict(intent=INTENT,artifact=ARTIFACT)),('status',dict(intent=INTENT))]:
            value=request(selector,body);raw=json.dumps(value).encode();self.assertEqual(q.request(raw),value)
        raw=json.dumps(REQUEST).encode();self.assertEqual(q.request(raw+b' '*(360448-len(raw))),REQUEST)
        invalid=[dict(REQUEST,budget_ms=True),dict(REQUEST,path='/private'),dict(REQUEST,selector='choose'),request('status',dict(intent=INTENT,artifact=ARTIFACT)),request('prepare',{**prepare,'portable_import_version':1.0}),request('prepare',{**prepare,'artifact':dict(portable_configuration_version=True,settings={})}),request('apply',dict(intent={**INTENT,'config_path_sha256':'e'*64},artifact=ARTIFACT))]
        for value in invalid:
            with self.assertRaises(ValueError):q.request(json.dumps(value).encode())
        for raw in [b'\xff',b'{} {}',b'{"a":1,"a":2}',b' '*360449]:
            with self.assertRaises((ValueError,UnicodeError)):q.request(raw)
    def channel(self, raw, code=0):
        channel=Mock();channel.recv_ready.side_effect=[True,False,False];channel.recv.return_value=raw;channel.recv_stderr_ready.return_value=False;channel.exit_status_ready.return_value=True;channel.recv_exit_status.return_value=code
        transport=Mock();transport.open_session.return_value=channel;return transport,channel
    def test_fixed_export_inspect_and_apply_commands_exact_stdin_and_one_eof(self):
        for selector,body in [('export',None),('inspect',None),('apply',dict(intent=INTENT,artifact=ARTIFACT)),('status',dict(intent=INTENT))]:
            value=request(selector,body);raw=(json.dumps(report(selector),ensure_ascii=False)+'\n').encode();transport,channel=self.channel(raw)
            with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):result=q.execute(transport,value)
            expected=q.EXPORT if selector=='export' else q.PREFIX+selector+('' if selector=='inspect' else ' --portable-configuration-input -')
            channel.exec_command.assert_called_once_with(expected);channel.shutdown_write.assert_called_once();channel.close.assert_called_once()
            if body is None:channel.sendall.assert_not_called()
            else:self.assertEqual(channel.sendall.call_args.args[0],base64.b64decode(value['input_base64']))
            self.assertEqual(base64.b64decode(result['_portable_raw']['stdout_base64']),raw)
    def test_exact_output_cap_and_changed_identity_or_partial_output_close_owned_channel(self):
        raw=(json.dumps(report('inspect'))+'\n').encode();padded=raw[:-1]+b' '*(16384-len(raw))+b'\n';transport,channel=self.channel(padded)
        with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):self.assertEqual(len(base64.b64decode(q.execute(transport,REQUEST)['_portable_raw']['stdout_base64'])),16384)
        for value in [b'x'*16385,b'\xff\n',b'{"report_version":1,"report_version":1}\n']:
            transport,channel=self.channel(value)
            with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):
                with self.assertRaises((ValueError,UnicodeError)):q.execute(transport,REQUEST)
            channel.close.assert_called_once()
        transport,channel=self.channel(b'{}\n{}\n')
        with patch.object(q.shared,'inspect',return_value={'boot_id':BOOT}):self.assertIsNone(q.execute(transport,REQUEST)['_portable_raw']['stdout_base64'])
        channel.close.assert_called_once()
        transport,channel=self.channel(raw)
        with patch.object(q.shared,'inspect',side_effect=[{'boot_id':BOOT},{'boot_id':'changed'}]):
            with self.assertRaises(q.shared.Refusal):q.execute(transport,REQUEST)
        channel.close.assert_called_once()
    def test_early_invalid_stdin_never_echoes_private_data_or_reads_config(self):
        result=subprocess.run([sys.executable,str(ROOT/'host/portable_configuration_transport.py')],input=b'PRIVATE_CANARY',capture_output=True,timeout=3)
        self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,b'');self.assertNotIn(b'PRIVATE_CANARY',result.stdout);self.assertIsNone(json.loads(result.stdout)['portable_configuration_raw']['stdout_base64'])
if __name__=='__main__':unittest.main()
