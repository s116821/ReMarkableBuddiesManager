import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {credentialFixture,begin,save,identity,name,defer,report} from './fixtures/credential-reference.mjs';
import {credentialName,parseCredentialChange,credentialPatchJson,parseCredentialReferenceRequest} from '../host/credential-reference-protocol.mjs';
import {lanes,verifyFortyTwoDirections} from './fixtures/maintenance-seven-lanes.mjs';
const count=(f,s)=>f.calls.filter(x=>x.action==='credential-reference'&&x.selector===s).length;
const names={credentialReference:'credential',memorySettings:'memory',researchSettings:'research',modelSettings:'model',basicSettings:'basic',memoryForget:'forget',ordinaryExport:'export'};
test('exact private grammar, strict singular change, vectors and raw case preserve producer semantics',async()=>{
 for(const value of ['a','A'.repeat(80),'MODEL_api-01'])assert.equal(credentialName(value),true);
 for(const value of ['', 'a'.repeat(81),'a\n','a\r\n',' a','a ','a/b','é',null,true]){assert.equal(credentialName(value),false);assert.throws(()=>parseCredentialChange({action:'set',value}));}
 for(const v of [[],{},['clear'],{action:'clear',value:'x'},{action:'set',value:'ok',other:true}])assert.throws(()=>parseCredentialChange(v));
 for(const [change,expected] of [[{value:'MODEL_api-01',action:'set'},'8827f2f47ed870c6f825ed0877ed30acb9587da784ef4a74ec767f963b4aa560'],[{action:'clear'},'88c0eb350510891f14d2c7604bc047490a468f9f575b8b1d57b60294cb085f80']])assert.equal(createHash('sha256').update('urn:remarkable-buddies:credential-reference-patch:v1:'+credentialPatchJson(change)).digest('hex'),expected);
 assert.throws(()=>parseCredentialReferenceRequest({action:'save',...identity,reference:'a'.repeat(64),changes:{model_credential:{action:'clear'}}}));
 for(const initial of [undefined,null,name])for(const change of [{action:'clear'},{action:'set',value:name},{action:'set',value:name.toLowerCase()}]){
  const f=credentialFixture();if(initial===undefined)delete f.credentialState.document.model_credential;else f.credentialState.document.model_credential=initial;
  const r=await begin(f),v=await save(f,r,change),same=change.action==='clear'?initial===undefined:initial===change.value;
  assert.equal(v.credential_reference.state,same?'no-change':'verified');assert.equal(count(f,'apply'),same?0:1);assert.equal(v.credential_reference.report.runtime_activation,'unverified');assert.equal(JSON.stringify(v).includes(name),false);assert.equal(f.credentialState.document.reader,'SYNTHETIC_READER_DRAFT');for(const h of Object.values(f.lanes))h.invalidate();
 }
});
test('all42 actual-coordinator directions invalidate idle grants; all42 Busy calls cause no hook/cancel/I/O',async()=>{
 const f=credentialFixture();await verifyFortyTwoDirections((key,q)=>f.lanes[names[key]].request(q));for(const h of Object.values(f.lanes))h.invalidate();
 for(const old of Object.keys(lanes)){
  const f=credentialFixture(),raw=f.observer.run,entered=defer(),gate=defer();f.observer.run=async function(...args){entered.resolve();await gate.promise;return raw.apply(this,args);};const pending=f.lanes[names[old]].request(lanes[old].begin());await entered.promise;
  const before=[f.credentialState.hooks,f.observer.cancels,f.calls.length,f.exportState.calls.length];
  try{for(const newer of Object.keys(lanes)){if(old===newer)continue;assert.equal((await f.lanes[names[newer]].request(lanes[newer].begin()))[lanes[newer].key].state,'busy');assert.deepEqual([f.credentialState.hooks,f.observer.cancels,f.calls.length,f.exportState.calls.length],before);}}finally{gate.resolve();await pending;for(const h of Object.values(f.lanes))h.invalidate();}
 }
});
for(const followup of ['cancel','failed-status','late-status'])test(`original unresolved followed by ${followup} retains exact intent without invented observation`,async()=>{
 let now=0;const f=credentialFixture({now:()=>now}),r=await begin(f);f.credentialState.onApply=()=>{throw Error('Synthetic loss');};assert.equal((await save(f,r)).credential_reference.state,'unknown');const original=structuredClone(f.calls.find(x=>x.action==='credential-reference'&&x.selector==='apply').body.intent);
 f.credentialState.hash='e'.repeat(64);assert.equal((await f.credential.request({action:'status',...identity,reference:r})).credential_reference.state,'unresolved');const calls=f.calls.length;
 if(followup==='failed-status')f.credentialState.onStatus=()=>{throw Error('Synthetic lost status');};if(followup==='late-status')f.credentialState.onStatus=v=>{now+=13001;return v;};
 const v=(await f.credential.request(followup==='cancel'?{action:'cancel',reference:r}:{action:'status',...identity,reference:r})).credential_reference;assert.equal(v.state,'unknown');assert.equal(v.current,null);assert.equal(v.report,null);assert.deepEqual(v.retained,[{reference:r,...identity,state:'unresolved'}]);assert.equal(count(f,'apply'),1);assert.equal(f.calls.length,calls+(followup==='cancel'?0:1));
 if(followup!=='cancel')assert.deepEqual(f.calls.findLast(x=>x.action==='credential-reference'&&x.selector==='status').body,{intent:original});for(const h of Object.values(f.lanes))h.invalidate();
});
test('unknown peer survives reference change and refusal; no credential-file action or implicit reconciliation',async()=>{
 const f=credentialFixture(),old=(await f.memory.request({action:'begin',...identity})).memory_settings.reference;f.memoryState.onApply=()=>{throw Error('Synthetic loss');};await f.memory.request({action:'save',...identity,reference:old,changes:{profile:{action:'set',value:'SYNTHETIC_PRIVATE_PROFILE'}}});
 await save(f,await begin(f));f.memoryState.onStatus=()=>report('status','read-only',null,'conflict');assert.equal((await f.memory.request({action:'status',...identity,reference:old})).memory_settings.state,'unavailable');assert.equal((await f.memory.request({action:'retained'})).memory_settings.retained[0].reference,old);
 assert.equal(f.calls.some(x=>/credential.file|model.credential/.test(x.action)),false);for(const h of Object.values(f.lanes))h.invalidate();
});
test('original path/after/intent mismatches, expiry, remaining budget, capacity and caller mutation are bounded',async()=>{
 for(const mutate of [r=>{r.data.intent.changes_sha256='e'.repeat(64);return r;},r=>{r.data.after.model_credential={origin:'default',present:false};return r;}]){const f=credentialFixture();f.credentialState.onPrepare=mutate;assert.equal((await save(f,await begin(f))).credential_reference.state,'not-dispatched');assert.equal(count(f,'apply'),0);}
 const path=credentialFixture();path.credentialState.path='0'.repeat(64);assert.equal(await begin(path),null);
 let now=0;const f=credentialFixture({now:()=>now}),r=await begin(f);now=119999;f.credentialState.onPrepare=v=>{now=120001;return v;};assert.equal((await save(f,r)).credential_reference.state,'not-dispatched');assert.equal(count(f,'apply'),0);
 now=0;f.credentialState.onPrepare=v=>{now+=4000;return v;};f.credentialState.onApply=v=>{now+=10001;return v;};assert.equal((await save(f,await begin(f))).credential_reference.state,'unknown');assert.equal(f.calls.findLast(x=>x.selector==='apply').budget_ms,9000);f.credential.invalidate();
 const g=credentialFixture();g.credentialState.onApply=()=>{throw Error('Synthetic loss');};const refs=[];for(let n=0;n<8;n++){const r=await begin(g);refs.push(r);await save(g,r,{action:'set',value:name+n});}const ninth=await begin(g),calls=g.calls.length;assert.equal((await save(g,ninth)).credential_reference.state,'capacity');assert.equal(g.calls.length,calls);assert.deepEqual((await g.credential.request({action:'retained'})).credential_reference.retained.map(v=>v.reference),refs);
 const h=credentialFixture(),ref=await begin(h),entered=defer(),gate=defer(),change={action:'set',value:name};h.credentialState.onPrepare=async v=>{entered.resolve();await gate.promise;return v;};const pending=save(h,ref,change);await entered.promise;change.value='MUTATED';gate.resolve();assert.equal((await pending).credential_reference.state,'verified');assert.equal(h.calls.find(x=>x.selector==='apply').body.change.value,name);
 for(const fixture of [g,h])for(const host of Object.values(fixture.lanes))host.invalidate();
});
