import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseServiceStopRaw,parseCompanionBaseline,admitServiceStopProfile,serviceStopSampleDigest,emptyServiceStopRaw} from '../host/service-stop-private.mjs';
import {matchesCandidateStopProfile} from '../host/service-stop-profiles.mjs';
import {stopProfileFixture} from './fixtures/service-stop-profiles.mjs';

const fixture=()=>stopProfileFixture('resident-installed');
const read=(f,key)=>JSON.parse(Buffer.from(f.raw[key],'base64'));
const write=(f,key,value)=>{f.raw[key]=Buffer.from(JSON.stringify(value)).toString('base64');};
const lease=(f,mutate)=>{const v=read(f,'lease_base64');mutate(v);write(f,'lease_base64',v);};
const original=(f,mutate)=>lease(f,l=>{const v=JSON.parse(l.companion);mutate(v);l.companion=JSON.stringify(v);});
const match=f=>matchesCandidateStopProfile(f.observation,f.raw,f.tuple);

test('delivered package shape is complete, private, and never enables production',()=>{
 const f=fixture();assert.equal(match(f),true);parseServiceStopRaw(f.raw,'review');assert.equal(admitServiceStopProfile(f.observation,f.raw),null);
 assert.equal(Object.keys(f.raw.artifacts).length,12);assert.equal(read(f,'recovery_profile_base64').version,6);assert.equal(read(f,'lease_base64').version,3);
 assert.equal(parseCompanionBaseline(read(f,'lease_base64').companion).policy.WatchdogUSec,'0');
 const m=stopProfileFixture();assert.equal(match(m),true);for(const key of ['companion','companion_group','vendor_policy'])assert.equal(m.raw[key],null);
 const resource=JSON.parse(readFileSync(new URL('../host/service-stop-vendor-policy.json',import.meta.url)));assert.equal(resource.keys.length,27);for(const k of ['stock','companion'])assert.deepEqual(Object.keys(resource[k]).sort(),resource.keys.toSorted());
});

test('legacy records, alias paths and mixed installed shapes refuse without fallback',()=>{
 for(const mutate of [f=>{const p=read(f,'recovery_profile_base64');p.version=1;delete p.companion;delete p.source_mode;write(f,'recovery_profile_base64',p);},f=>lease(f,l=>l.version=2),f=>lease(f,l=>delete l.companion),f=>f.raw.buddy.policy.FragmentPath='/etc/systemd/system/reader-buddy.service',f=>{f.raw.process.executable='/home/root/.local/lib/reader-buddy/reader-buddy';f.raw.process.argv=[f.raw.process.executable];}]){const f=fixture();mutate(f);assert.equal(match(f),false);}
 for(const key of ['companion','source_mode','development_output']){const f=fixture(),p=read(f,'recovery_profile_base64');if(key==='development_output')p[key]=null;else delete p[key];write(f,'recovery_profile_base64',p);assert.throws(()=>parseServiceStopRaw(f.raw,'review'));}
});

test('nested ServiceBaseline strings and snapshot members are independently closed',()=>{
 for(const mutate of [l=>l.companion={},l=>l.companion='{"version":1,"version":1}',l=>l.companion='\ufeff{}',l=>{const v=JSON.parse(l.companion);v.secret='PRIVATE_CANARY';l.companion=JSON.stringify(v);},l=>{const v=JSON.parse(l.companion);v.snapshot+='Id=rm-sync.service\n';l.companion=JSON.stringify(v);},l=>{const v=JSON.parse(l.companion);v.snapshot=v.snapshot.replace('WatchdogUSec=0\n','');l.companion=JSON.stringify(v);},l=>{const v=JSON.parse(l.companion);v.group.context.boot='99999999-9999-4999-8999-999999999999';l.companion=JSON.stringify(v);},l=>{const v=JSON.parse(l.companion);v.group.group=l.group.group;l.companion=JSON.stringify(v);},l=>{const v=JSON.parse(l.companion);v.group.parent.pid=99;l.companion=JSON.stringify(v);}]){const f=fixture();lease(f,mutate);assert.throws(()=>parseServiceStopRaw(f.raw,'review'));}
});

test('original and current rm-sync watchdog must be zero even when a proposed tuple agrees otherwise',()=>{
 const f=fixture();f.raw.companion.policy.WatchdogUSec='1s';f.tuple.companion_policy.WatchdogUSec='1s';assert.equal(match(f),false);
 const g=fixture();original(g,v=>v.snapshot=v.snapshot.replace('WatchdogUSec=0\n','WatchdogUSec=1s\n'));g.raw.companion.policy.WatchdogUSec='1s';g.tuple.companion_policy.WatchdogUSec='1s';assert.throws(()=>parseServiceStopRaw(g.raw,'review'));assert.equal(match(g),false);
});

test('companion retained and cleared terminal states follow the source group matrix',()=>{
 for(const retained of [false,true])for(const group of ['populated','empty-original','original-absent'])for(const state of ['inactive','failed','active']){
  const f=fixture(),o=parseCompanionBaseline(read(f,'lease_base64').companion).state,s=f.raw.companion.state;f.raw.companion_group=group;
  if(retained)Object.assign(s,{InvocationID:o.InvocationID,ExecMainPID:o.ExecMainPID,ExecMainStartTimestampMonotonic:o.ExecMainStartTimestampMonotonic,ControlGroup:o.ControlGroup});
  s.ActiveState=state;s.SubState=state==='inactive'?'dead':state==='failed'?'failed':'running';
  const allowed=group!=='populated'&&(retained||group==='original-absent')&&(state==='inactive'||retained&&state==='failed');assert.equal(match(f),allowed,`${retained}/${group}/${state}`);
 }
 const f=fixture(),o=parseCompanionBaseline(read(f,'lease_base64').companion).state;Object.assign(f.raw.companion.state,{InvocationID:o.InvocationID,ExecMainPID:o.ExecMainPID,ExecMainStartTimestampMonotonic:o.ExecMainStartTimestampMonotonic});f.raw.companion_group='empty-original';assert.equal(match(f),false);
 const g=fixture();g.raw.companion.state.InvocationID='d'.repeat(32);assert.equal(match(g),false);
 const h=fixture();h.raw.companion.state.ControlGroup='/system.slice/rm-sync.service';assert.equal(match(h),true);h.raw.companion_group='empty-original';assert.equal(match(h),false);
});

test('fixed vendor pins and source policies cannot be weakened by a matching tuple',()=>{
 for(const key of ['companion_executable','companion_unit','companion_dropin','native_profile','adapter']){const f=fixture();f.raw.artifacts[key].sha256='f'.repeat(64);f.tuple.artifacts[key]='f'.repeat(64);assert.equal(match(f),false,key);}
 for(const name of ['stock','companion'])for(const key of Object.keys(fixture().raw.vendor_policy[name])){const f=fixture();f.raw.vendor_policy[name][key]='WRONG';f.tuple.vendor_policy[name][key]='WRONG';assert.equal(match(f),false,`${name}/${key}`);}
 const f=fixture();f.raw.vendor_policy.companion.After=f.raw.vendor_policy.companion.After.split(' ').reverse().join(' ');assert.equal(match(f),true);
 f.raw.vendor_policy.companion.After+=' home.mount';assert.equal(match(f),false);
});

test('every added field and original nested byte participates in the canonical sample digest',()=>{
 const f=fixture(),before=serviceStopSampleDigest(f.observation,'resident-installed',f.raw);
 for(const mutate of [g=>g.raw.companion_group='empty-original',g=>g.raw.companion.state.Job='1',g=>g.raw.vendor_policy.companion.Nice='0',g=>g.raw.artifacts.companion_unit.inode='8',g=>lease(g,l=>l.companion+=' ')]){const g=structuredClone(f);mutate(g);assert.notEqual(serviceStopSampleDigest(g.observation,'resident-installed',g.raw),before);}
});

test('new private fields keep closed nullability and independent component/record/envelope limits',()=>{
 for(const key of ['companion','companion_group','vendor_policy']){const f=fixture();delete f.raw[key];assert.throws(()=>parseServiceStopRaw(f.raw,'review'));const g=fixture();g.raw[key]=null;assert.throws(()=>parseServiceStopRaw(g.raw,'review'));}
 const m=stopProfileFixture();m.raw.companion_group='original-absent';assert.throws(()=>parseServiceStopRaw(m.raw,'review'));
 const f=fixture();for(const k of ['After','Conflicts','OnSuccess','OnFailure','RestartForceExitStatus'])f.raw.buddy.policy[k]='a'.repeat(4000);assert.throws(()=>parseServiceStopRaw(f.raw,'review'));
 const g=fixture();lease(g,l=>l.companion+=' '.repeat(32768));assert.throws(()=>parseServiceStopRaw(g.raw,'review'));
 const r=emptyServiceStopRaw('inspect');r.vendor_policy=fixture().raw.vendor_policy;assert.throws(()=>parseServiceStopRaw(r,'inspect'));
 const h=fixture();h.raw.extra='x'.repeat(262144);assert.throws(()=>parseServiceStopRaw(h.raw,'review'));
});
