"""Synthetic fixed-channel tests; these are not native producer captures."""
import base64
import json
import socket
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
class ScheduledChannel:
    """Exit status arrives first; receive completion and late bytes are independent."""
    def __init__(self, clock, stdout, stderr=(), eof=.03):
        self.clock, self.stdout, self.stderr, self.eof = clock, list(stdout), list(stderr), eof
        self.closed = False
        self.received_stderr = bytearray()
        self.stdout_complete = self.stderr_complete = False
    def settimeout(self, value): pass
    def exec_command(self, value): pass
    def shutdown_write(self): pass
    def close(self): self.closed = True
    def exit_status_ready(self): return True
    def recv_exit_status(self): return 0
    def recv_ready(self): return bool(self.stdout and self.stdout[0][0] <= self.clock[0])
    def recv_stderr_ready(self): return bool(self.stderr and self.stderr[0][0] <= self.clock[0])
    def receive(self, queue, size):
        if queue and queue[0][0] <= self.clock[0]:
            at, data = queue.pop(0)
            if len(data) > size: queue.insert(0, (at, data[size:]))
            return data[:size]
        if self.eof is not None and self.clock[0] >= self.eof: return b''
        raise socket.timeout()
    def recv(self, size):
        data = self.receive(self.stdout, size)
        if not data: self.stdout_complete = True
        return data
    def recv_stderr(self, size):
        data = self.receive(self.stderr, size)
        if not data: self.stderr_complete = True
        self.received_stderr.extend(data)
        return data

class Completion(unittest.TestCase):
    def run_channel(self, trailing=(), stderr=(), eof=.03):
        clock = [0.0]
        raw = (json.dumps(report('inspect'))+'\n').encode()
        channel = ScheduledChannel(clock, [(0, raw), *trailing], stderr, eof)
        transport = Mock(); transport.open_session.return_value = channel
        def sleep(value): clock[0] += value
        with patch.object(q.time, 'monotonic', side_effect=lambda:clock[0]), patch.object(q.time, 'sleep', side_effect=sleep), patch.object(q.shared, 'inspect', return_value={'boot_id':BOOT}):
            try: result = q.execute(transport, REQUEST, deadline=.08)
            except Exception as error: result = error
        self.assertTrue(channel.closed)
        return result, channel, clock[0], raw
    def test_exit_status_before_delayed_second_stdout_frame_is_refused(self):
        result, channel, elapsed, _ = self.run_channel(trailing=[(.01, b'{}\n')])
        self.assertIsNone(result['_portable_raw']['stdout_base64'])
        self.assertEqual(result['_portable_raw']['status'], 'unavailable')
        self.assertTrue(channel.stdout_complete and channel.stderr_complete)
        self.assertGreaterEqual(elapsed, .03)
    def test_exit_status_before_delayed_stderr_drains_to_completion(self):
        result, channel, elapsed, raw = self.run_channel(stderr=[(.01, b'PRIVATE_DIAGNOSTIC')])
        self.assertEqual(channel.received_stderr, b'PRIVATE_DIAGNOSTIC')
        self.assertNotIn('PRIVATE_DIAGNOSTIC', json.dumps(result))
        self.assertEqual(base64.b64decode(result['_portable_raw']['stdout_base64']), raw)
        self.assertTrue(channel.stdout_complete and channel.stderr_complete)
        self.assertGreaterEqual(elapsed, .03)
    def test_delayed_stderr_over_cap_is_refused(self):
        result, _, _, _ = self.run_channel(stderr=[(.01, b'x'*8193)])
        self.assertIsInstance(result, ValueError)
    def test_exit_status_without_eof_uses_original_deadline(self):
        result, channel, elapsed, _ = self.run_channel(eof=None)
        self.assertIsInstance(result, q.shared.Refusal)
        self.assertEqual(result.status, 'timeout')
        self.assertFalse(channel.stdout_complete or channel.stderr_complete)
        self.assertGreaterEqual(elapsed, .08)
        self.assertLess(elapsed, .10)
    def test_valid_frame_requires_both_receive_completions(self):
        result, channel, elapsed, raw = self.run_channel()
        self.assertEqual(result['_portable_raw']['status'], 'reported')
        self.assertEqual(base64.b64decode(result['_portable_raw']['stdout_base64']), raw)
        self.assertTrue(channel.stdout_complete and channel.stderr_complete)
        self.assertGreaterEqual(elapsed, .03)

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
        channel=Mock();channel.recv_ready.side_effect=[True,False,False];channel.recv.side_effect=[raw,b''];channel.recv_stderr_ready.return_value=False;channel.recv_stderr.return_value=b'';channel.exit_status_ready.return_value=True;channel.recv_exit_status.return_value=code
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

class SharedPreferences(unittest.TestCase):
    def test_fixed_selector_and_exact_original_status_stdin(self):
        import shared_preferences_transport as shared_preferences

        guard = dict(group=BOOT, mode_epoch=BOOT, store_generation=BOOT,
                     local_config_sha256='a'*64, binding_sha256='b'*64,
                     selection={'kind': 'absent'})
        body = dict(shared_preferences_version=1, operation=BOOT, guard=guard,
                    patch_sha256='c'*64)
        wire = request('status', body)
        self.assertEqual(shared_preferences.request(json.dumps(wire).encode()), wire)
        with self.assertRaises(ValueError):
            shared_preferences.request(json.dumps(request('status', dict(body, patch=ARTIFACT))).encode())
        with self.assertRaises(ValueError):
            shared_preferences.request(json.dumps(dict(wire, selector='status; id')).encode())

        raw = (json.dumps(dict(report_version=1, operation='status', status='unknown',
                               runtime_activation='unverified', data=None)) + '\n').encode()
        clock = [0.0]
        channel = ScheduledChannel(clock, [(0, raw)])
        channel.exec_command = Mock()
        channel.sendall = Mock()
        channel.shutdown_write = Mock()
        transport = Mock()
        transport.open_session.return_value = channel
        with patch.object(q.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(q.time, 'sleep', side_effect=lambda value: clock.__setitem__(0, clock[0] + value)), \
                patch.object(q.shared, 'inspect', return_value={'boot_id': BOOT}):
            observed = shared_preferences.invoke(transport, wire, deadline=.08)
        channel.exec_command.assert_called_once_with(
            shared_preferences.PREFIX + 'status --shared-preferences-input -')
        channel.sendall.assert_called_once_with(base64.b64decode(wire['input_base64']))
        channel.shutdown_write.assert_called_once()
        self.assertTrue(channel.closed)
        self.assertEqual(base64.b64decode(observed['_portable_raw']['stdout_base64']), raw)

if __name__=='__main__':unittest.main()
