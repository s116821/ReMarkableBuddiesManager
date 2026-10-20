import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseBasicSettingsReport,parseBasicSettingsRequest,parseBasicFields,parseBasicChanges,changedBasicFields,parseBasicIntent,parseBasicSettingsResult } from '../host/basic-settings-protocol.mjs';
import { parseSavedConfigurationReport } from '../host/saved-configuration.mjs';
import { MaintenanceIO } from '../host/maintenance-io.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity={connection_id:'1'.repeat(64),boot_id:'11111111-1111-4111-8111-111111111111'};
const current={debug_dump:{origin:'default',value:null},log_level:{origin:'declared-null',value:null},trigger_corner:{origin:'declared',value:'UR'}};
const clone=v=>structuredClone(v);
test('original45 captured CLI reports retain72 stdin/stdout hashes,38 basic/7 general typed meanings and before-shape attribution',async()=>{
 const bytes=await readFile(new URL('./fixtures/basic-settings-87bc8d4-corpus.json',import.meta.url));assert.equal(hash(bytes),'8adbd87c292d886a9aceed52e701cb1941ca8abc8c1671ac187446d32b375b10');const corpus=JSON.parse(bytes);
 assert.equal(corpus.source_commit,'87bc8d4bae88a1f1e3ecb64d6aa11535e4df464e');assert.equal(corpus.capture_executable_sha256,'ed2f34f39d1e14abb379ea5c56041394b4068ffb6f72086bac7b14acbe00e799');assert.equal(corpus.cases.length,45);
 const inspections=new Map(),prepared=new Map();let basic=0,general=0,inputs=0;
 for(const row of corpus.cases){
  assert.equal(hash(Buffer.from(row.stdout_utf8)),row.stdout_sha256,row.name+' stdout');assert.equal(row.exit_code,0);assert.equal(row.stderr_utf8,'');
  let input=null;if(row.stdin_base64!==null){const b=Buffer.from(row.stdin_base64,'base64');assert.equal(hash(b),row.stdin_sha256,row.name+' stdin');inputs++;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{/* actual refusal specimen */}}else assert.equal(row.stdin_sha256,null);
  const r=JSON.parse(row.stdout_utf8);
  if('snapshot'in r){parseSavedConfigurationReport(r);general++;continue;}
  let context={};if(r.operation==='prepare'&&r.status==='ok')context={...input,current:inspections.get(input.base_sha256)};
  if(['apply','status'].includes(r.operation)&&r.status==='ok')context={intent:input.intent,after:prepared.get(input.intent.operation)?.after};
  const p=parseBasicSettingsReport(r,r.operation,context);basic++;
  if(r.status==='ok'&&r.operation==='inspect')inspections.set(p.base_sha256,p.current);
  if(p.intent)prepared.set(p.intent.operation,p);
  const publicText=JSON.stringify(p.report);for(const key of ['base_sha256','target_sha256','config_path_sha256','intent'])assert.equal(publicText.includes(key),false);
 }
 assert.deepEqual({basic,general,inputs},{basic:38,general:7,inputs:27});const before=corpus.before_shape_observation;assert.equal(hash(before.stdout_utf8),before.stdout_sha256);assert.equal(before.source_commit,'4bc7eb0c6bf55af8392ee36a8eb3a7ca400a5389');parseSavedConfigurationReport(JSON.parse(before.stdout_utf8));
});
test('finite dirty patch preserves omission and distinguishes clearing declared-null from setting false',()=>{
 assert.deepEqual(changedBasicFields(current,{log_level:{action:'clear'}}),{...current,log_level:{origin:'default',value:null}});assert.deepEqual(changedBasicFields(current,{debug_dump:{action:'set',value:false}}).debug_dump,{origin:'declared',value:false});
 for(const patch of [{},[],{model:{action:'clear'}},{debug_dump:{action:'set',value:null}},{trigger_corner:{action:'set',value:'ur'}},{log_level:{action:'clear',value:'debug'}}])assert.throws(()=>parseBasicChanges(patch));
 for(const mutate of [v=>v.debug_dump.value=false,v=>v.log_level.origin='declared',v=>v.extra={},v=>v.trigger_corner.value='bad']){const v=clone(current);mutate(v);assert.throws(()=>parseBasicFields(v));}
 for(const v of [{action:'begin',...identity,path:'/private'},{action:'begin',...identity,connection_id:identity.connection_id+'\n'},{action:'begin',...identity,boot_id:identity.boot_id+'\n'},{action:'save',...identity,reference:'2'.repeat(64),changes:{}},{action:'retained',connection_id:identity.connection_id},{action:'cancel',reference:'not-a-reference'}])assert.throws(()=>parseBasicSettingsRequest(v));
 parseBasicSettingsRequest({action:'save',...identity,reference:'2'.repeat(64),changes:{debug_dump:{action:'set',value:true}}});
});
test('private outcome/intent linkage refuses false verification and public raw injection',()=>{
 const intent={basic_version:1,operation:identity.boot_id,base_sha256:'a'.repeat(64),target_sha256:'b'.repeat(64),config_path_sha256:'c'.repeat(64),changes:{debug_dump:{action:'set',value:false}}};parseBasicIntent(intent);
 assert.throws(()=>parseBasicIntent({...intent,target_sha256:intent.base_sha256}));for(const field of ['base_sha256','target_sha256','config_path_sha256','operation'])assert.throws(()=>parseBasicIntent({...intent,[field]:intent[field]+'\n'}));
 const refusal={report_version:1,operation:'apply',status:'failed',outcome:'unknown',disk_readback_verified:false,runtime_activation:'unverified',data:null};parseBasicSettingsReport(refusal,'apply');
 for(const v of [{...refusal,disk_readback_verified:true},{...refusal,runtime_activation:'restart-required'},{...refusal,status:'conflict'},{...refusal,data:{target_sha256:intent.target_sha256}}])assert.throws(()=>parseBasicSettingsReport(v,'apply'));
 const result={contract_version:1,status:'unconfigured',observation:null,basic_settings:{state:'none',reference:null,current:null,report:null,retained:[]}};parseBasicSettingsResult(result,{action:'retained'},validateResult);
 for(const mutate of [v=>v.basic_settings.intent=intent,v=>v.basic_settings.reference=intent.base_sha256,v=>v.basic_settings.current=current,v=>v.basic_settings.state='verified']){const v=clone(result);mutate(v);assert.throws(()=>parseBasicSettingsResult(v,{action:'retained'},validateResult));}
});
test('shared ownership rejects old status/cancel and conditionally releases only its current token',()=>{
 const io=new MaintenanceIO(),old=io.acquire('forget','old','confirm');assert.ok(old);assert.equal(io.acquire('basic','new','apply'),null);io.revoke();const next=io.acquire('basic','new','save');assert.ok(next);assert.equal(io.ownerFor('forget','old'),null);assert.equal(io.acquire('basic','older-diagnostic','status'),null);io.release(old);assert.equal(io.ownerFor('basic','new'),next);io.release(next);assert.ok(io.acquire('basic','older-diagnostic','status'));
});
