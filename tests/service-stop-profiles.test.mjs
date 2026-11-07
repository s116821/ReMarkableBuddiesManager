import test from 'node:test';import assert from 'node:assert/strict';import {matchesCandidateStopProfile} from '../host/service-stop-profiles.mjs';import {admitServiceStopProfile} from '../host/service-stop-private.mjs';import {stopProfileFixture} from './fixtures/service-stop-profiles.mjs';
test('both source-shaped candidates match synthetic immutable tuples but never enable production',()=>{for(const profile of ['ordinary-manual','resident-installed']){const f=stopProfileFixture(profile);assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),true,profile);assert.equal(admitServiceStopProfile(f.observation,f.raw),null);}});
test('manual candidate rejects unsafe policy, drift, unsupported mode evidence and copied-observation enrollment',()=>{for(const mutate of [f=>f.raw.buddy.policy.KillMode='process',f=>f.raw.buddy.policy.DropInPaths='/other',f=>f.raw.buddy.state.MainPID='21',f=>f.raw.process.argv.push('SECRET'),f=>f.raw.artifacts.buddy_unit.mode=String(0o100777),f=>f.raw.lease_observation='occupied',f=>f.raw.lease_observation='not-read',f=>f.raw.buddy.stop_extra.EnvironmentFiles='other',f=>f.raw.buddy.policy.TimeoutStopUSec='infinity',f=>f.raw.buddy.stop_extra.ExecStop='/bin/other',f=>f.tuple.artifacts.buddy_executable='f'.repeat(64),f=>f.observation.firmware_conflict=true,f=>f.raw.configuration.effective_mode='local-only']){const f=stopProfileFixture();mutate(f);assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),false);}const f=stopProfileFixture();assert.equal(matchesCandidateStopProfile(f.observation,f.raw,null),false);});
test('resident candidate keeps installed argv/lease/boot/artifact/helper boundaries separate',()=>{for(const mutate of [f=>{f.raw.process.executable='/opt/bin/reader-buddy';f.raw.process.argv=[f.raw.process.executable];},f=>f.raw.lease_base64=null,f=>f.raw.recovery_profile_base64=null,f=>f.raw.buddy.policy.OnFailure='',f=>f.raw.helper.state.ActiveState='active',f=>f.raw.helper.policy.WatchdogUSec='2min',f=>f.raw.platform.kernel='other',f=>f.raw.artifacts.native_profile.sha256='f'.repeat(64),f=>{const l=JSON.parse(Buffer.from(f.raw.lease_base64,'base64'));l.group.context.boot='00000000-0000-4000-8000-000000000099';f.raw.lease_base64=Buffer.from(JSON.stringify(l)).toString('base64');}]){const f=stopProfileFixture('resident-installed');mutate(f);assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),false);}});
test('helper infinity sentinel requires the exact cleared runtime and pinned zero-watchdog policy',()=>{const f=stopProfileFixture('resident-installed');f.raw.helper.policy.WatchdogUSec='infinity';assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),true);for(const key of ['ExecMainPID','ExecMainStartTimestampMonotonic','ControlPID']){const g=structuredClone(f);g.raw.helper.state[key]='10';assert.equal(matchesCandidateStopProfile(g.observation,g.raw,g.tuple),false,key);}const g=structuredClone(f);g.tuple.helper_policy.WatchdogUSec='infinity';assert.equal(matchesCandidateStopProfile(g.observation,g.raw,g.tuple),false);});
test('an unsafe qualified policy is refused even when raw observations and the proposed tuple agree',()=>{for(const mutate of [f=>{f.raw.buddy.policy.KillMode='process';f.tuple.buddy_policy.KillMode='process';},f=>{f.raw.buddy.stop_extra.ExecStop='/bin/other';f.tuple.buddy_extra.ExecStop='/bin/other';},f=>{f.raw.buddy.policy.TimeoutStopUSec='infinity';f.tuple.buddy_policy.TimeoutStopUSec='infinity';}]){const f=stopProfileFixture();mutate(f);assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),false);}});
test('existing lease namespace/type/mount relationships and stock invocation remain closed',()=>{for(const mutate of [l=>l.stock.invocation='0'.repeat(32),l=>l.group.context.mount_namespace.mode=0o40755,l=>l.group.context.slice.inode=l.group.context.mount.inode,l=>l.group.context.mount_record='1 2 0:1 / /sys/fs/cgroup/unified rw - cgroup1 cgroup rw',l=>l.group.parent.start_ticks=99]){const f=stopProfileFixture('resident-installed'),l=JSON.parse(Buffer.from(f.raw.lease_base64,'base64'));mutate(l);f.raw.lease_base64=Buffer.from(JSON.stringify(l)).toString('base64');assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),false);}});

test('all required slots require both positively typed empty hooks',()=>{for(const profile of ['ordinary-manual','resident-installed'])for(const slot of profile==='ordinary-manual'?['buddy']:['buddy','helper','stock','companion'])for(const property of ['ExecStop','ExecStopPost'])for(const observation of ['observed-nonempty','unknown']){const f=stopProfileFixture(profile);f.raw[slot].hooks[property]={property,observation,type_verified:observation!=='unknown',reason:observation==='unknown'?'wrong-envelope':'typed-nonempty'};assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),false,`${profile}/${slot}/${property}/${observation}`);assert.equal(admitServiceStopProfile(f.observation,f.raw),null);}});

test('typed hooks reject missing mixed contradictory and extra private forms',()=>{for(const mutate of [f=>delete f.raw.buddy.hooks,f=>delete f.raw.buddy.hooks.ExecStop,f=>f.raw.buddy.hooks.ExecStop.type_verified=false,f=>f.raw.buddy.hooks.ExecStop.property='ExecStopPost',f=>f.raw.buddy.hooks.ExecStop.reason='PRIVATE_ERROR',f=>f.raw.buddy.hooks.ExecStop.argv='PRIVATE_ARGUMENT',f=>f.raw.buddy.stop_extra.ExecStop='',f=>f.raw.buddy.hooks.Extra=f.raw.buddy.hooks.ExecStop]){const f=stopProfileFixture();mutate(f);assert.equal(matchesCandidateStopProfile(f.observation,f.raw,f.tuple),false);}});

test('ordinary alias candidate keeps argv, link, regular artifact and production admission distinct',async()=>{
 const {ordinaryAliasFixture}=await import('./fixtures/service-stop-profiles.mjs');
 const {parseServiceStopRaw,serviceStopSampleDigest,collectServiceStopSample}=await import('../host/service-stop-private.mjs');
 const {observation,raw,tuple}=ordinaryAliasFixture();
 assert.equal(parseServiceStopRaw(raw,'review'),raw);
 assert.equal(matchesCandidateStopProfile(observation,raw,tuple),true);
 assert.equal(admitServiceStopProfile(observation,raw),null);
 assert.equal(matchesCandidateStopProfile(observation,raw,stopProfileFixture().tuple),false);
 const digest=serviceStopSampleDigest(observation,tuple.profile,raw);
 for(const key of ['inode','link_parents_sha256','target_parents_sha256']){
  const changed=structuredClone(raw);
  changed.ordinary_alias[key]=key==='inode'?'5':'c'.repeat(64);
  assert.notEqual(serviceStopSampleDigest(observation,tuple.profile,changed),digest);
  let read=0;
  await assert.rejects(collectServiceStopSample({capture:async()=>read++?changed:raw,now:()=>0},observation,tuple.profile,10));
 }
 for(const mutate of [
  value=>value.ordinary_alias.literal='/home/root/rem42-ordinary-trial/release-app',
  value=>value.ordinary_alias.links='2',
  value=>value.ordinary_alias.extra=true,
  value=>value.process.argv=[value.process.executable],
  value=>value.process.executable='/opt/bin/reader-buddy',
  value=>value.companion=stopProfileFixture('resident-installed').raw.companion,
  value=>delete value.ordinary_alias,
 ]){
  const changed=structuredClone(raw);mutate(changed);
  assert.throws(()=>parseServiceStopRaw(changed,'review'));
 }
 const changed=structuredClone(raw);changed.artifacts.buddy_executable.mode=String(0o100644);
 assert.equal(matchesCandidateStopProfile(observation,changed,tuple),false);
});
