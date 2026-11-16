"""Real durable records/locks, synthetic wire facts; no tablet/package execution."""
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'host'))
import resident_package_transition as transition
import resident_package_disable as disable
import resident_package_uninstall as uninstall
import resident_package_replacement as replacement
import resident_package_removal as coordinator
from resident_package_goal import retained_lease, initial_lease, preflight, validate_goal, IntentLease
from resident_package_transport import fingerprint, request


class ContinuationTest(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.config = Path(tmp.name) / 'wired.json'
        self.config.parent.chmod(0o700)
        self.connection = 'd' * 64
        self.active = transition.Activation('12345678-1234-1234-1234-123456789abc',
            '22345678-1234-1234-1234-123456789abc', 'a'*64, 'b'*64, '1'*32, 10, 'c'*64)
        self.stock = dict(boot_id=self.active.boot_id, activation_id=self.active.activation_id,
            lease_sha256=self.active.lease_sha256, recovery_invocation='2'*32,
            reader_invocation='3'*32, sync_invocation='4'*32)
        self.version = '1.2.3-r2'
        self.ownership = dict(boot_id=self.active.boot_id, package='remarkable-buddies-'+self.version, database_sha256='e'*64)
        self.plan = dict(ownership=self.ownership, world_sha256='a'*64, solver_sha256='b'*64)
        self.candidate = dict(nonce='5'*32, version='1.2.4-r0', apk_sha256='6'*64, index_sha256='7'*64)
        self.replace_plan = dict(ownership=self.ownership, candidate_version=self.candidate['version'],
            apk_sha256=self.candidate['apk_sha256'], index_sha256=self.candidate['index_sha256'],
            world_sha256='8'*64, other_world_sha256='9'*64, solver_sha256='a'*64)
        self.replacement = dict(candidate=self.candidate, profile_sha256='f'*64, plan=self.replace_plan)
        self.args = (self.config, self.connection, self.active.boot_id, self.active.activation_id,
                     self.active.profile_sha256, time.monotonic()+30)
        self.recovery = Mock(); self.commands=[]; self.disabled=False
        self.recovery.package_ownership.return_value=self.ownership
        self.recovery.removal_plan.return_value=self.plan
        self.recovery.capture_activation.return_value=self.active
        self.recovery.observe_recovery.return_value=self.stock
        self.recovery.unit_file_state.side_effect=lambda unit: b'static\n' if unit==disable.HELPER else (b'disabled\n' if self.disabled else b'enabled\n')
        def read(command, cap):
            if command==disable.DISABLE_COMMAND:
                self.commands.append('disable');self.disabled=True
                return b''
            if command.startswith('readlink '):return (disable.PACKAGE_UNIT+'\n').encode()
            return b''
        self.recovery.read.side_effect=read
        def wire(config, inspect, connection=None):
            self.assertEqual(connection,self.connection)
            result=inspect('wire')
            return dict(result,connection_id=self.connection) if isinstance(result,dict) else result
        for module in (transition,disable,uninstall,replacement):
            for name,value in [('on_wire',wire),('PackageRecovery',lambda *args:self.recovery)]:
                p=patch.object(module,name,side_effect=value);p.start();self.addCleanup(p.stop)
        p=patch.object(coordinator,'PackageRecovery',return_value=self.recovery);p.start();self.addCleanup(p.stop)
        def stop(*args):self.commands.append('stop');return (0,b'',b'')
        p=patch.object(transition,'run_fixed',side_effect=stop);p.start();self.addCleanup(p.stop)
        for module,name,value in [(uninstall,'run_locked',lambda *args:self.commands.append('remove')),
                (uninstall,'removed',lambda *args:{'removed':self.ownership['package']}),
                (replacement,'run_locked_transaction',lambda *args:self.commands.append('replace')),
                (replacement,'observe_replaced',lambda *args:{'ownership':{'package':'new'}}),
                (replacement,'replacement_plan',lambda *args,**kwargs:self.replace_plan),
                (replacement,'preview',lambda *args,**kwargs:{'replacement_plan':self.replace_plan})]:
            p=patch.object(module,name,side_effect=value);p.start();self.addCleanup(p.stop)

    def goal(self,operation):
        return dict(operation=operation,operation_id='32345678-1234-1234-1234-123456789abc',
            installed_version=self.version,replacement=self.replacement if operation=='replace' else None)

    def prepare(self,operation):
        with initial_lease():
            return transition.prepare(self.config,self.connection,self.active,self.active.profile_sha256,
                self.args[-1],approved_version=self.version,removal=operation=='remove',
                expected_plan=self.plan if operation=='remove' else None,goal=self.goal(operation))

    def review(self):return coordinator.review_continuation(*self.args,approved_version=self.version)
    def advance(self,r):return coordinator.continue_transition(*self.args,approved_version=self.version,expected=fingerprint(r))

    def test_restart_records_continue_one_phase_and_complete_only_goal(self):
        for operation in ('disable','remove','replace'):
            with self.subTest(operation=operation):
                self.prepare(operation)
                before=self.review();self.assertEqual(before['outcome'],'prepared')
                after=self.advance(before)
                self.assertEqual(self.commands,['stop','disable'])
                if operation=='disable':self.assertEqual(after['state'],'completed')
                else:
                    self.assertEqual(after['state'],'continuable')
                    # Reload all goal/phase proofs from disk; no original process state is needed.
                    after=self.advance(self.review())
                    self.assertEqual(after['state'],'completed')
                    self.assertEqual(self.commands,['stop','disable',operation])
                self.assertEqual(after['outcome'],{'disable':'disabled','remove':'removed','replace':'replaced'}[operation])
                with self.assertRaises(ValueError):self.advance(after)
                for p in self.config.parent.glob('resident-*.json'):
                    self.assertLessEqual(p.stat().st_size,4096);p.unlink()
                self.commands=[];self.disabled=False

    def test_final_record_with_failed_proof_never_replays(self):
        self.prepare('remove');prepared=self.review();disabled=self.advance(prepared)
        path=uninstall.removal_path(*self.args[:1], self.active.boot_id,self.active.activation_id)
        _,stop,_=transition.load_intent(*self.args[:5],self.version)
        transition.write_private_record(path,dict(version=1,stop=stop,stock=self.stock))
        with patch.object(uninstall,'removed',side_effect=ValueError('incomplete')):
            with self.assertRaises(ValueError):self.review()
            with self.assertRaises(ValueError):self.advance(disabled)
        self.assertEqual(self.commands,['stop','disable'])

    def test_changed_goal_or_review_and_retained_prepare_refuse(self):
        self.prepare('remove');r=self.review()
        with self.assertRaises(transition.RecoveryPending):self.prepare('remove')
        with self.assertRaises(ValueError):self.advance({**r,'outcome':'disabled'})
        self.assertEqual(self.commands,['stop'])
        path=transition.intent_path(self.config,self.active.boot_id,self.active.activation_id)
        v=json.loads(path.read_text());v['goal']['operation']='disable';path.write_text(json.dumps(v))
        with self.assertRaises(ValueError):self.review()

    def test_absent_optional_disable_record_still_uses_full_proof(self):
        self.prepare('disable');self.disabled=True
        r=self.review();self.assertEqual((r['state'],r['outcome']),('completed','disabled'))
        self.assertEqual(self.commands,['stop'])
        self.recovery.observe_disabled_recovery.assert_called_once()

    def test_deadline_is_passed_unchanged_and_prior_lease_blocks_mutation(self):
        self.prepare('remove');r=self.review()
        path=transition.intent_path(self.config,self.active.boot_id,self.active.activation_id)
        with retained_lease(path):
            with self.assertRaises(OSError):self.advance(r)
        self.assertEqual(self.commands,['stop'])
        with patch.object(disable,'execute',side_effect=TimeoutError('expired')) as apply:
            with self.assertRaises(TimeoutError):self.advance(r)
            self.assertEqual(apply.call_args.args,self.args)

    def test_legacy_and_oversized_goals_never_gain_continuation_authority(self):
        path=transition.intent_path(self.config,self.active.boot_id,self.active.activation_id)
        transition.record_intent(path,self.connection,self.active,self.ownership)
        with self.assertRaises(ValueError):self.review()
        path.unlink()
        g=self.goal('replace');g['replacement']['plan']['unexpected']='x'*4096
        with self.assertRaises(ValueError):validate_goal(g,self.ownership,None)
        with self.assertRaises(ValueError):preflight({'goal':g,'oversized':'x'*4096})
        self.assertEqual(self.commands,[])

    def test_closed_private_input_and_empty_policy_do_not_open_config(self):
        q=dict(selector='review',operation='remove',connection_id=self.connection,boot_id=self.active.boot_id,
               budget_ms=100,policy_id='a'*64,expected=None,invocation=self.goal('remove')['operation_id'])
        self.assertEqual(request(json.dumps(q).encode()),q)
        for bad in [dict(q,path='secret'),dict(q,budget_ms=True),dict(q,selector='shell')]:
            with self.assertRaises(ValueError):request(json.dumps(bad).encode())
        env=dict(os.environ,MANAGER_WIRED_CONFIG='/NO-SUCH-CONFIG')
        p=subprocess.run([sys.executable,'host/resident_package_transport.py'],input=json.dumps(q),text=True,capture_output=True,env=env,timeout=3)
        self.assertEqual(p.returncode,0);self.assertEqual(p.stderr,'')
        self.assertEqual(json.loads(p.stdout)['status'],'unconfigured')

    def test_fixed_private_adapter_reviews_executes_and_discovers_same_original_goal(self):
        from resident_package_transport import dispatch
        observation=dict(boot_id=self.active.boot_id,model='reMarkable 2.0',architecture='armv7l',
                         firmware='3.28.0.172',firmware_conflict=False)
        binding=dict(id='a'*64,operation='remove',profile_sha256=self.active.profile_sha256,
                     installed_version=self.version,replacement=None,**{k:observation[k] for k in ('model','architecture','firmware')})
        q=dict(selector='review',operation='remove',connection_id=self.connection,boot_id=self.active.boot_id,
               budget_ms=12000,policy_id=binding['id'],expected=None,invocation=self.goal('remove')['operation_id'])
        with patch.object(transition.shared,'inspect',return_value=observation):
            # Initial review deliberately does not assume a preexisting connection callback argument.
            with patch.object(transition,'on_wire',side_effect=lambda c,f,connection=None:dict(f('wire'),connection_id=self.connection)):
                _,raw=dispatch(q,self.config,self.args[-1],binding)
                self.assertEqual(raw['state'],'ready')
                expected={**raw['context'],'operation_id':q['invocation']}
                _,done=dispatch(dict(q,selector='execute',expected=expected),self.config,self.args[-1],binding)
                self.assertEqual(done['state'],'completed')
                _,retained=dispatch(q,self.config,self.args[-1],binding)
                self.assertEqual(retained['retained'][0]['operation_id'],q['invocation'])
                _,checked=dispatch(dict(q,selector='observe',expected=done['context']),self.config,self.args[-1],binding)
                self.assertEqual(checked['state'],'completed')
        self.assertEqual(self.commands,['stop','disable','remove'])


class NativeLeaseTest(unittest.TestCase):
    def test_actual_process_exclusion_death_and_reacquisition(self):
        with TemporaryDirectory() as directory:
            root=Path(directory);root.chmod(0o700)
            if sys.platform=='win32':
                import win32api,win32con,win32security as security
                token=security.OpenProcessToken(win32api.GetCurrentProcess(),win32con.TOKEN_QUERY)
                try:user=security.GetTokenInformation(token,security.TokenUser)[0]
                finally:token.Close()
                acl=security.ACL();acl.AddAccessAllowedAce(security.ACL_REVISION,win32con.GENERIC_ALL,user)
                security.SetNamedSecurityInfo(str(root),security.SE_FILE_OBJECT,
                    security.DACL_SECURITY_INFORMATION|security.PROTECTED_DACL_SECURITY_INFORMATION,None,None,acl,None)
            path=root/'resident-stop.json'
            transition.write_private_record(path,{'version':1})
            source="from resident_package_goal import retained_lease; from wired_observer import private_bytes; import sys,time\nwith retained_lease(__import__('pathlib').Path(sys.argv[1])):\n print(private_bytes(__import__('pathlib').Path(sys.argv[1]),parent_private=True,maximum=4096).decode(),flush=True)\n time.sleep(20)\n"
            child=subprocess.Popen([sys.executable,'-u','-c',source,str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                env=dict(os.environ,PYTHONPATH=str(Path('host').resolve())))
            try:
                self.assertEqual(child.stdout.readline().strip(),'{"version":1}')
                self.assertIsNone(child.poll())
                fd=os.open(path,os.O_RDWR|getattr(os,'O_BINARY',0))
                try:
                    with self.assertRaises(OSError):IntentLease(fd)
                finally:os.close(fd)
                child.kill();child.wait(timeout=3)
                with retained_lease(path):self.assertEqual(path.stat().st_size,13)
                self.assertEqual(child.stderr.read(),'')
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3)
                child.stdout.close();child.stderr.close()


if __name__=='__main__':unittest.main()
