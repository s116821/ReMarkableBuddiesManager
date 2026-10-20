import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseModelSettingsReport,parseModelFields,parseModelChanges,parseModelIntent,parseModelSettingsRequest,parseModelSettingsResult,modelPatchJson,modelText} from '../host/model-settings-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {tablet,identity} from './fixtures/basic-settings.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const corpusBytes=await readFile(new URL('./fixtures/model-settings-c785afe-corpus.json',import.meta.url)),corpus=JSON.parse(corpusBytes),rows=corpus.records;
const patchHash=v=>hash('urn:remarkable-buddies:model-settings-patch:v1:'+modelPatchJson(v));
const row=n=>rows.find(x=>x.name===n),report=n=>JSON.parse(row(n).stdout_utf8),input=n=>JSON.parse(Buffer.from(row(n).stdin_base64,'base64'));
const before=report('inspect-original').data.current,prepared=report('prepare-two-fields'),intent=prepared.data.intent;
test('all32 captured model reports/60 original hashes and independent opaque patch vector remain exact',async()=>{
 assert.equal(corpusBytes.length,90529);assert.equal(hash(corpusBytes),'1445676ff01ad2cfebbd94ed6a33845fccf63b5630848419f4fd15584408fcfe');assert.equal(rows.length,32);let hashes=0;
 for(const r of rows){assert.equal(hash(Buffer.from(r.stdout_utf8)),r.stdout_sha256);hashes++;if(r.stdin_base64!==null){assert.equal(hash(Buffer.from(r.stdin_base64,'base64')),r.stdin_sha256);hashes++;}else assert.equal(r.stdin_sha256,null);
  const v=JSON.parse(r.stdout_utf8),q=r.stdin_base64===null||v.status!=='ok'?null:JSON.parse(Buffer.from(r.stdin_base64,'base64')),context={};
  if(v.status==='ok'&&v.operation==='prepare')Object.assign(context,{current:v.data.before??v.data.current,changes:q.changes,operation:q.operation,base_sha256:q.base_sha256,config_path_sha256:q.config_path_sha256,changes_sha256:patchHash(q.changes)});
  if(v.status==='ok'&&['apply','status'].includes(v.operation))Object.assign(context,{intent:q.intent,after:v.data?.current??prepared.data.after});
  const parsed=parseModelSettingsReport(v,v.operation,context);assert.equal(parsed.report.outcome,v.outcome,r.name);assert.equal(JSON.stringify(parsed.report).includes('sha256'),false);
 }
 assert.equal(hashes,60);const vector=JSON.parse(await readFile(new URL('./fixtures/model-settings-patch-vector.json',import.meta.url)));assert.equal(modelPatchJson(vector.changes),vector.canonical_patch_utf8);assert.equal(patchHash(vector.changes),'7b8b312e53ce731e251614648218ebf89f994b4d03b047e67278ae0b8ff2c226');
});
test('opaque scalar text preserves CRLF/control/trailing bytes and producer whitespace semantics with isolated16384 request cap',()=>{
 const exact='PRIVATE\r\n\t trailing \uFEFF';assert.equal(parseModelChanges({model:{action:'set',value:exact}}).model.value,exact);assert.equal(modelText('model','\uFEFF'),true);for(const v of ['','\u0085','\r\n','\ud800','x'.repeat(257)])assert.equal(modelText('model',v),false);
 const changes={model:{action:'set',value:'\0'.repeat(256)},base_url:{action:'set',value:'\0'.repeat(2048)}};const q={action:'save',...identity,reference:'b'.repeat(64),changes};assert.ok(Buffer.byteLength(JSON.stringify(q))>1024);assert.equal(parseModelSettingsRequest(q),q);assert.throws(()=>parseModelSettingsRequest({...q,path:'/arbitrary'}));for(const changes of [{},{model:{action:'set',value:null}},{model:{action:'clear',value:''}},{basic:{action:'clear'}}])assert.throws(()=>parseModelChanges(changes));
});
test('original patch/hash/fields and model-specific status null-data consistency refuse cross-kind or altered reports',()=>{
 const q=input('prepare-two-fields'),context={current:before,...q,changes_sha256:patchHash(q.changes)};assert.equal(parseModelSettingsReport(prepared,'prepare',context).intent.changes_sha256,intent.changes_sha256);
 for(const prop of ['changes_sha256','base_sha256','config_path_sha256'])assert.throws(()=>parseModelSettingsReport(prepared,'prepare',{...context,[prop]:'0'.repeat(64)}));
 assert.throws(()=>parseModelSettingsReport({...prepared,data:{...prepared.data,after:before}},'prepare',context));assert.throws(()=>parseModelIntent({...intent,changes:q.changes}));assert.throws(()=>parseModelFields({model:{origin:'declared',present:false},base_url:{origin:'default',present:false}}));
 assert.equal(parseModelSettingsReport(report('status-before-apply'),'status',{intent,after:prepared.data.after}).current,null);assert.throws(()=>parseModelSettingsReport({...report('status-before-apply'),data:{current:before,observed_sha256:'0'.repeat(64)}},'status',{intent,after:prepared.data.after}));
});
test('safe model projection cannot carry private value/hash or a mismatched phase/current/identity',()=>{
 const reference='b'.repeat(64),q={action:'begin',...identity},base={contract_version:1,status:'observed',observation:tablet,model_settings:{state:'ready',reference,current:parseModelFields(before),report:{operation:'inspect',status:'ok',outcome:'read-only',disk_readback_verified:false,runtime_activation:'unverified'},retained:[]}};
 assert.equal(parseModelSettingsResult(base,q,validateResult),base);assert.throws(()=>parseModelSettingsResult(base,{action:'status',...identity,reference},validateResult));
 for(const tweak of [v=>v.model_settings.current.model.value='PRIVATE',v=>v.model_settings.report.base_sha256=intent.base_sha256,v=>v.model_settings.state='verified',v=>v.observation.boot_id='99999999-9999-4999-8999-999999999999']){const bad=structuredClone(base);tweak(bad);assert.throws(()=>parseModelSettingsResult(bad,q,validateResult));}
 const unresolved={...base,model_settings:{state:'unresolved',reference,current:null,report:{operation:'status',status:'ok',outcome:'unresolved',disk_readback_verified:false,runtime_activation:'unverified'},retained:[{reference,...identity,state:'unresolved'}]}};assert.equal(parseModelSettingsResult(unresolved,{action:'status',...identity,reference},validateResult),unresolved);
});
