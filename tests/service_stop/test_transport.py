"""Local admission and zero-channel refusal; no tablet connection."""
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'host'))
import service_stop_transport as q
import wired_observer as shared
BASE=dict(connection_id='a'*64,boot_id='11111111-1111-4111-8111-111111111111',selector='review',budget_ms=12000,expected=None)
class Cases(unittest.TestCase):
 def test_closed_private_requests(self):
  self.assertEqual(q.request(json.dumps(BASE).encode()),BASE)
  for change in [dict(extra=True),dict(selector='restart'),dict(budget_ms=True),dict(budget_ms=12001),dict(expected={}),dict(connection_id='A'*64)]:
   with self.assertRaises(ValueError):q.request(json.dumps(dict(BASE,**change)).encode())
  with self.assertRaises(ValueError):q.request(json.dumps(BASE).replace('"budget_ms": 12000','"budget_ms": 1e3').encode())
  with self.assertRaises(ValueError):q.request(json.dumps(BASE).replace('"selector": "review"','"selector":"review","selector":"inspect"').encode())
 def test_disabled_stop_opens_no_channel_or_observation(self):
  v=dict(BASE,selector='stop',expected=dict(profile='ordinary-manual',sample_sha256='b'*64));q.request(json.dumps(v).encode());transport=Mock()
  with patch.object(shared,'inspect') as inspect:
   with self.assertRaises(shared.Refusal):q.execute(transport,v)
   inspect.assert_not_called();transport.open_session.assert_not_called()
 def test_read_uses_existing_readonly_inspector_and_no_new_command(self):
  transport=Mock()
  with patch.object(shared,'inspect',return_value=dict(boot_id=BASE['boot_id'])) as inspect:
   out=q.execute(transport,BASE);inspect.assert_called_once_with(transport);transport.open_session.assert_not_called()
   self.assertEqual(out['_service_stop_raw']['command'],'not-submitted');self.assertEqual(out['_service_stop_raw']['reason'],'lifecycle-unqualified')
 def test_expired_and_foreign_boot_refuse(self):
  with patch.object(shared,'inspect',return_value=dict(boot_id='other')):
   with self.assertRaises(shared.Refusal):q.execute(Mock(),BASE)
  with patch.object(shared,'inspect') as inspect:
   with self.assertRaises(shared.Refusal):q.execute(Mock(),BASE,time.monotonic()-1)
   inspect.assert_not_called()
if __name__=='__main__':unittest.main()
