import test from 'node:test';import assert from 'node:assert/strict';
import {modelCredentialFixture,identity,secret,begin,save,report,defer} from './fixtures/model-credential.mjs';
import {modelCredentialText,parseModelCredentialChange,parseModelCredentialResult} from '../host/model-credential-protocol.mjs';
import {parseModelCredentialReport,hash} from '../host/model-credential-private.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
const count=(f,s)=>f.calls.filter(x=>x.action==='model-credential'&&x.selector===s).length;
const cleanup=f=>{for(const h of Object.values(f.lanes))h.invalidate();};
test('scalar/nonblank byte grammar preserves controls, CRLF and Rust whitespace boundaries',()=>{
 for(const v of [secret,'SYNTHETIC\0KEY\rTAIL\r\n \t','\ufeff','a'.repeat(8192)]){assert.equal(modelCredentialText(v),true);assert.equal(parseModelCredentialChange({action:'install',value:v}).value,v);}
 for(const v of ['', '\u0085','\u3000','\ud800','a'.repeat(8193),null,true])assert.equal(modelCredentialText(v),false);
 for(const v of [{action:'remove',value:'SYNTHETIC'},{action:'replace'},{action:'install',value:secret,extra:true},[]])assert.throws(()=>parseModelCredentialChange(v));
});
test('install, exact-byte no-op, both replacement modes, remove and absent-remove preserve producer authority',async()=>{
 for(const mode of [256,384]){const f=modelCredentialFixture();
  assert.equal((await save(f,await begin(f))).model_credential.state,'verified');assert.equal(f.modelCredentialState.binding.state.sha256,hash(secret));
  f.modelCredentialState.binding.state.mode=mode;
  assert.equal((await save(f,await begin(f),{action:'replace',value:secret})).model_credential.state,'no-change');assert.equal(count(f,'apply'),1);
  assert.equal((await save(f,await begin(f),{action:'replace',value:secret+'X'})).model_credential.state,'verified');assert.equal(f.modelCredentialState.binding.state.mode,mode);
  assert.equal((await save(f,await begin(f),{action:'remove'})).model_credential.state,'verified');assert.equal((await save(f,await begin(f),{action:'remove'})).model_credential.state,'no-change');
  assert.equal(count(f,'apply'),3);const serialized=JSON.stringify(await f.modelCredential.request({action:'retained'}));for(const privateValue of [secret,hash(secret),'metadata_sha256','binding','intent'])assert.equal(serialized.includes(privateValue),false);cleanup(f);
 }
});
test('original prepare binding/action/hash/mode/UUID mismatches never dispatch apply',async()=>{
 for(const mutate of [r=>{r.data.intent.base.parent_identity_sha256='0'.repeat(64);},r=>{r.data.intent.target.sha256='0'.repeat(64);},r=>{r.data.intent.target.mode=256;},r=>{r.data.intent.operation='00000000-0000-0000-0000-000000000000';},r=>{r.data.intent.action='replace';}]){const f=modelCredentialFixture();f.modelCredentialState.onPrepare=r=>{mutate(r);return r;};assert.equal((await save(f,await begin(f))).model_credential.state,'not-dispatched');assert.equal(count(f,'apply'),0);cleanup(f);}
});
test('private expiry preserves unresolved tombstones and capacity; no status reconstruction or ninth write',async()=>{
 let now=0;const f=modelCredentialFixture({now:()=>now});f.modelCredentialState.onApply=()=>{throw Error(secret);};const refs=[];
 for(let n=0;n<8;n++){const ref=await begin(f);refs.push(ref);assert.equal((await save(f,ref,{action:n?'replace':'install',value:secret+n})).model_credential.state,'unknown');}
 now=1800001;const retained=(await f.modelCredential.request({action:'retained'})).model_credential.retained;assert.equal(retained.length,8);assert.ok(retained.every(x=>!x.status_available));const calls=f.calls.length;
 assert.equal((await f.modelCredential.request({action:'status',...identity,reference:refs[0]})).model_credential.state,'unavailable');assert.equal((await f.modelCredential.request({action:'cancel',reference:refs[0]})).model_credential.state,'unknown');assert.equal((await f.modelCredential.request({action:'begin',...identity})).model_credential.state,'capacity');assert.equal(f.calls.length,calls);assert.equal((await f.modelCredential.request({action:'retained'})).model_credential.retained.length,8);cleanup(f);
});
test('reference/config change refuses exact old status, preserves unknown; new reference presence never settles it',async()=>{
 const f=modelCredentialFixture(),ref=await begin(f);f.modelCredentialState.onApply=()=>{throw Error(secret);};await save(f,ref);const original=f.calls.find(x=>x.action==='model-credential'&&x.selector==='apply').body.intent;
 f.modelCredentialState.binding.config_sha256='0'.repeat(64);assert.equal((await f.modelCredential.request({action:'status',...identity,reference:ref})).model_credential.state,'unavailable');assert.deepEqual(f.calls.findLast(x=>x.action==='model-credential').body,{intent:original});assert.equal((await f.modelCredential.request({action:'retained'})).model_credential.retained[0].reference,ref);assert.equal(count(f,'apply'),1);cleanup(f);
});
test('unresolved then failed/cancel/expired in-flight status never invents a report or settles',async()=>{
 let now=0;const f=modelCredentialFixture({now:()=>now}),ref=await begin(f);f.modelCredentialState.onApply=()=>{throw Error(secret);};await save(f,ref);f.modelCredentialState.binding.state={kind:'absent'};
 const status=()=>f.modelCredential.request({action:'status',...identity,reference:ref});assert.equal((await status()).model_credential.state,'unresolved');
 f.modelCredentialState.onStatus=()=>{throw Error(secret);};let v=(await status()).model_credential;assert.equal(v.state,'unknown');assert.equal(v.report,null);assert.equal(v.retained[0].state,'unresolved');
 now=1799999;f.modelCredentialState.onStatus=r=>{now=1800001;return r;};v=(await status()).model_credential;assert.equal(v.state,'unknown');assert.equal(v.report,null);assert.equal(v.current,null);assert.equal(v.retained[0].status_available,false);assert.equal(v.retained[0].state,'unresolved');cleanup(f);
});
test('ready/prepare deadlines and escaped envelope refusal never permit late apply',async()=>{
 let now=0;const f=modelCredentialFixture({now:()=>now}),ref=await begin(f);now=119999;f.modelCredentialState.onPrepare=r=>{now=120001;return r;};assert.equal((await save(f,ref)).model_credential.state,'not-dispatched');assert.equal(count(f,'apply'),0);cleanup(f);
 const g=modelCredentialFixture();assert.equal((await save(g,await begin(g),{action:'install',value:'SYNTHETIC'+'\x01'.repeat(2640)})).model_credential.state,'not-dispatched');assert.equal(count(g,'apply'),0);cleanup(g);
});
test('old targeted cancel cannot cancel/release newer save and late response cannot disclose private report',async()=>{
 const f=modelCredentialFixture(),old=await begin(f);f.modelCredentialState.onApply=()=>{throw Error(secret);};await save(f,old);f.modelCredentialState.onApply=null;const next=await begin(f),entered=defer(),gate=defer();f.modelCredentialState.onApply=async r=>{entered.resolve();await gate.promise;return r;};const pending=save(f,next,{action:'replace',value:secret+'N'});await entered.promise;const before=f.observer.cancels;
 assert.equal((await f.modelCredential.request({action:'cancel',reference:old})).model_credential.state,'unknown');assert.equal(f.observer.cancels,before);assert.equal((await f.modelCredential.request({action:'status',...identity,reference:old})).model_credential.state,'busy');gate.resolve();assert.equal((await pending).model_credential.state,'verified');cleanup(f);
});
test('safe decoder rejects confidential fields/canaries and private parser rejects unknowns recursively',async()=>{
 const f=modelCredentialFixture(),ref=await begin(f),ready=await f.modelCredential.request({action:'begin',...identity});for(const key of ['binding','intent','sha256','mode','value','config_path_sha256']){const v=structuredClone(ready);v.model_credential[key]=secret;assert.throws(()=>parseModelCredentialResult(v,{action:'begin',...identity},validateResult));}
 const b=f.modelCredentialState.binding;for(const key of ['extra','value']){const r=report('inspect','read-only',{schema_version:1,binding:{...b,[key]:secret}});assert.throws(()=>parseModelCredentialReport(r,'inspect'));}assert.ok(ref);cleanup(f);
});
test('all 56 actual coordinator directions invalidate idle grants and Busy does no hook/cancel/I/O',async()=>{
 const {lanes,verifyFiftySixDirections}=await import('./fixtures/maintenance-eight-lanes.mjs');const names={modelCredential:'modelCredential',credentialReference:'credential',memorySettings:'memory',researchSettings:'research',modelSettings:'model',basicSettings:'basic',memoryForget:'forget',ordinaryExport:'export'};
 const f=modelCredentialFixture();await verifyFiftySixDirections((key,q)=>f.lanes[names[key]].request(q));cleanup(f);
 for(const old of Object.keys(lanes)){const f=modelCredentialFixture(),raw=f.observer.run,entered=defer(),gate=defer();f.observer.run=async function(...args){entered.resolve();await gate.promise;return raw.apply(this,args);};const pending=f.lanes[names[old]].request(lanes[old].begin());await entered.promise;const before=[f.modelCredentialState.hooks,f.observer.cancels,f.calls.length];try{for(const newer of Object.keys(lanes)){if(old===newer)continue;assert.equal((await f.lanes[names[newer]].request(lanes[newer].begin()))[lanes[newer].key].state,'busy');assert.deepEqual([f.modelCredentialState.hooks,f.observer.cancels,f.calls.length],before);}}finally{gate.resolve();await pending;cleanup(f);}}
});
test('confidential malformed output canaries are never returned; duplicate/framing/base64/refusals remain conservative',async()=>{
 for(const bad of [r=>({...r,data:{...r.data,intent:{...r.data.intent,extra:secret}}}),r=>JSON.stringify(r).replace('"report_version":1','"report_version":1,"report_version":1')+'\n',()=>'{"value":"SYNTHETIC_PRIVATE_CANARY"}\n',r=>JSON.stringify(r)+'\n'+JSON.stringify(r)+'\n']){
  const f=modelCredentialFixture();f.modelCredentialState.onPrepare=bad;const v=await save(f,await begin(f));assert.equal(v.model_credential.state,'not-dispatched');assert.equal(count(f,'apply'),0);assert.equal(JSON.stringify(v).includes(secret),false);assert.equal(JSON.stringify(v).includes('SYNTHETIC_PRIVATE_CANARY'),false);cleanup(f);
 }
 const f=modelCredentialFixture();f.modelCredentialState.onApply=r=>({...r,data:{present:true,intent:{value:secret}}});const ref=await begin(f),v=await save(f,ref);assert.equal(v.model_credential.state,'unknown');assert.equal(v.model_credential.report,null);assert.equal(JSON.stringify(v).includes(secret),false);assert.equal((await f.modelCredential.request({action:'status',...identity,reference:ref})).model_credential.state,'desired-file-observed');cleanup(f);
});
test('status deadline clamps to remaining private lifetime without renewal; late status remains unavailable unknown',async()=>{
 let now=0;const f=modelCredentialFixture({now:()=>now}),ref=await begin(f);f.modelCredentialState.onApply=()=>{throw Error(secret);};await save(f,ref);now=1799500;f.modelCredentialState.onStatus=r=>{now=1800001;return r;};const v=await f.modelCredential.request({action:'status',...identity,reference:ref});assert.equal(f.calls.findLast(x=>x.action==='model-credential').budget_ms,500);assert.equal(v.model_credential.state,'unknown');assert.equal(v.model_credential.retained[0].status_available,false);cleanup(f);
});
test('caller change mutation cannot replace cloned original secret while prepare is active',async()=>{
 const f=modelCredentialFixture(),ref=await begin(f),entered=defer(),gate=defer(),change={action:'install',value:secret};f.modelCredentialState.onPrepare=async r=>{entered.resolve();await gate.promise;return r;};const pending=save(f,ref,change);await entered.promise;change.value='SYNTHETIC_MUTATED';gate.resolve();assert.equal((await pending).model_credential.state,'verified');assert.equal(f.calls.findLast(x=>x.action==='model-credential'&&x.selector==='apply').body.change.value,secret);cleanup(f);
});
test('actual reference edit invalidates file binding without settling old file uncertainty or following a new target',async()=>{
 const f=modelCredentialFixture(),old=await begin(f);f.modelCredentialState.onApply=()=>{throw Error(secret);};await save(f,old);const original=structuredClone(f.calls.find(x=>x.action==='model-credential'&&x.selector==='apply').body.intent);
 const ref=(await f.credential.request({action:'begin',...identity})).credential_reference.reference;f.credentialState.onApply=r=>{f.modelCredentialState.binding.config_sha256=r.data.target_sha256;f.modelCredentialState.binding.credential_path_sha256='1'.repeat(64);return r;};assert.equal((await f.credential.request({action:'save',...identity,reference:ref,change:{action:'set',value:'SYNTHETIC_NEW_REFERENCE'}})).credential_reference.state,'verified');
 const status=await f.modelCredential.request({action:'status',...identity,reference:old});assert.equal(status.model_credential.state,'unavailable');assert.equal(status.model_credential.retained[0].reference,old);assert.deepEqual(f.calls.findLast(x=>x.action==='model-credential').body,{intent:original});assert.equal(count(f,'apply'),1);cleanup(f);
});
test('new file observation/action cannot settle an older unknown reference original',async()=>{
 const f=modelCredentialFixture(),ref=(await f.credential.request({action:'begin',...identity})).credential_reference.reference;f.credentialState.onApply=()=>{throw Error('SYNTHETIC_REFERENCE_LOSS');};await f.credential.request({action:'save',...identity,reference:ref,change:{action:'set',value:'SYNTHETIC_REFERENCE'}});
 assert.equal((await save(f,await begin(f))).model_credential.state,'verified');assert.equal((await f.credential.request({action:'retained'})).credential_reference.retained[0].reference,ref);f.credentialState.onStatus=()=>report('status','read-only',null,'conflict');assert.equal((await f.credential.request({action:'status',...identity,reference:ref})).credential_reference.state,'unavailable');assert.equal((await f.credential.request({action:'retained'})).credential_reference.retained.length,1);assert.equal(count(f,'apply'),1);cleanup(f);
});
