"""The isolated public Stop adapter remains disabled in shipped source."""
import hashlib
import json
from pathlib import Path
import shlex
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'host'))
import service_stop_transport as t


class TypedPublicStop(unittest.TestCase):
    def setUp(self):
        self.boot = '11111111-1111-4111-8111-111111111111'
        self.invocation = '22222222-2222-4222-8222-222222222222'
        self.owner = dict(nonce='a'*32, boot_id=self.boot, bus_id='b'*32,
                          manager=':1.4', owner_sha256='c'*64)
        self.value = dict(connection_id='d'*64, boot_id=self.boot, selector='stop',
                          budget_ms=12000, expected=dict(profile='ordinary-manual',
                              sample_sha256='e'*64, invocation=self.invocation))
        self.facts = dict(t.empty_raw('review', None), ordinary_alias={'literal':'fixture'},
                          buddy={'state':{'ExecMainStartTimestampMonotonic':'27','InvocationID':'f'*32}},
                          process={'pid':'20','start_ticks':'40'})
        self.sampler = Mock()
        self.sampler.text.return_value = b'100.25 200.00\n'
        self.sampler.bracket.return_value = self.facts, 'e'*64

    def response(self, command):
        body = shlex.split(command)[-1]
        words = shlex.split(body)
        binding = words[words.index('printf')+2]
        self.assertEqual(binding,
            f"PublicStop1 {'a'*32} {self.invocation} {'e'*64} {'d'*64} {self.boot} 101150\n")
        self.assertEqual(words[-2:], [f"/home/root/rem42-ordinary-{'a'*32}/device-owner.sh", 'public-stop'])
        sha = hashlib.sha256(binding.encode('ascii')).hexdigest()
        return f"{'a'*32} public-stop {self.boot} {'b'*32} :1.4 20:27:{'f'*32}:40:2:4 51 {'1'*64} {sha}\n".encode()

    def test_private_variant_is_closed_and_production_disabled(self):
        raw = json.dumps(self.value).encode()
        self.assertEqual(t.QUALIFIED_PROFILES, ())
        self.assertIsNone(t.TYPED_PUBLIC_STOP_OWNER)
        with self.assertRaises(ValueError):
            t.request(raw)
        with patch.object(t, 'TYPED_PUBLIC_STOP_OWNER', self.owner):
            self.assertEqual(t.request(raw), self.value)
            for key, value in [('invocation','not-a-uuid'),('command','systemctl'),('stage','/other')]:
                modified = json.loads(raw)
                modified['expected'][key] = value
                with self.assertRaises(ValueError):
                    t.request(json.dumps(modified).encode())

    def test_original_deadline_and_exact_ack(self):
        with patch.object(t.time,'monotonic',return_value=10):
            command, ack = t.typed_public_stop(self.sampler,self.value,self.facts,11,self.owner)
            response = self.response(command)
            self.assertTrue(ack(0,response,b''))
            for code,out,err in [(1,response,b''),(0,response[:-1],b''),(0,response,b'x'),
                                 (0,response.replace(b':1.4',b':1.5'),b''),
                                 (0,response.replace(b' 51 ',b' 4294967296 '),b'')]:
                self.assertFalse(ack(code,out,err))
        with patch.object(t.time,'monotonic',return_value=11):
            self.assertFalse(ack(0,response,b''))
            with self.assertRaises(t.shared.Refusal):
                t.typed_public_stop(self.sampler,self.value,self.facts,11,self.owner)
        self.sampler.text.return_value=b'100.250 200.00\n'
        with patch.object(t.time,'monotonic',return_value=10), self.assertRaises(t.shared.Refusal):
            t.typed_public_stop(self.sampler,self.value,self.facts,11,self.owner)

    def test_fixed_child_marks_possible_before_one_send_and_keeps_refusal_unknown(self):
        for valid in (True,False):
            sent = []
            def run(transport,command,deadline,cap):
                self.assertEqual(sent,['possible'])
                self.assertEqual((deadline,cap),(11,512))
                sent.append('exec')
                return 0,self.response(command) if valid else b'',b''
            with patch.object(t,'QUALIFIED_PROFILES',('ordinary-manual',)), \
                 patch.object(t,'TYPED_PUBLIC_STOP_OWNER',self.owner), \
                 patch.object(t,'Sampler',return_value=self.sampler), \
                 patch.object(t,'run_fixed',side_effect=run), \
                 patch.object(t.shared,'inspect',side_effect=lambda _: {'boot_id':self.boot}), \
                 patch.object(t.time,'monotonic',return_value=10):
                result = t.execute(Mock(),self.value,11,lambda:sent.append('possible'))
            self.assertEqual(sent,['possible','exec'])
            self.assertEqual(result['_service_stop_raw']['command'], 'request-accepted' if valid else 'unknown')


if __name__ == '__main__':
    unittest.main()
