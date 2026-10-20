import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryForgetHost } from '../host/memory-forget.mjs';
import { parseForgetRequest,parseForgetReport,parseForgetResult,canonicalEnvelope,sha256 } from '../host/memory-forget-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { observer,prepared,ack,failure,operation,reference,key,id,prepareRequest,golden } from './fixtures/memory-forget.mjs';
const open=(fixture=observer(),options={})=>({fixture,manager:new MemoryForgetHost({observer:fixture.host,reference:()=>reference,uuid:()=>operation,...options})});
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('canonical supported preview matches all913 existing Rust golden bytes and original SHA',async()=>{
  const bytes=canonicalEnvelope(golden.input);assert.equal(bytes,golden.canonical_utf8);assert.equal(Buffer.byteLength(bytes),913);assert.equal(await sha256(bytes),golden.sha256);
  const r=await prepared();assert.equal((await parseForgetReport(r,'prepare-forget',{operation,key,...prepareRequest()})).preview.head.fact.observed_ms,Number.MAX_SAFE_INTEGER);
  for(const change of [r=>{r.data.intent.expected[0].sha256='0'.repeat(64);},r=>{r.data.intent.operation=id(99);},r=>{r.data.preview.payload.observed_ms=9007199254740992;},r=>{r.data.intent.binding.domain.extra=true;},r=>{r.data.preview.payload.subject=' ';},r=>{r.data.preview.payload.key.scope.extra=true;}]){const r=await prepared();change(r);await assert.rejects(parseForgetReport(r,'prepare-forget',{operation,key,...prepareRequest()}));}
});

test('every exact producer phase row is accepted and wrong flags/shapes/selectors refuse',async()=>{
  const rows=[['prepare-forget','invalid-input',false,null],['prepare-forget','unavailable',false,null],['prepare-forget','busy',false,null],['prepare-forget','unsupported',false,null],['prepare-forget','unavailable',true,null],['forget','invalid-input',false,'not-dispatched'],['forget','unavailable',false,'not-dispatched'],['forget','busy',false,'not-dispatched'],['forget','unsupported',false,'not-dispatched'],['forget','conflict',false,'not-dispatched'],['forget','unavailable',true,'not-dispatched'],['forget','unavailable',true,'unknown'],['forget-receipt','invalid-input',false,null],['forget-receipt','unavailable',false,'unresolved'],['forget-receipt','busy',false,'unresolved'],['forget-receipt','unsupported',false,'unresolved'],['forget-receipt','unavailable',true,'unresolved']];
  for(const [selector,status,incomplete,outcome]of rows){const r=failure(selector,status,incomplete,outcome);const v=await parseForgetReport(r,selector,{operation});assert.deepEqual(v.report,{selector,status,incomplete,outcome});await assert.rejects(parseForgetReport({...r,operation:'query'},selector,{operation}));}
  for(const selector of ['forget','forget-receipt']){assert.equal((await parseForgetReport(ack(selector),selector,{operation})).acknowledgement.operation,operation);await assert.rejects(parseForgetReport(ack(selector,id(9)),selector,{operation}));}
  for(const r of [failure('forget','unavailable',false,'unknown'),failure('forget','conflict',true,'not-dispatched'),failure('forget-receipt','unavailable',false,null),failure('forget-receipt','unavailable',true,'not-dispatched'),failure('prepare-forget','partial',true,null)])await assert.rejects(parseForgetReport(r,r.operation,{operation}));
});

test('public requests/views deny private fields and arbitrary replacement authority',async()=>{
  for(const q of [{action:'status',path:'/bad'},{action:'confirm',reference,intent:{}},{action:'receipt',reference,operation},{...prepareRequest(),expected:[]},{action:'cancel',reference:reference+'\n'}])assert.throws(()=>parseForgetRequest(q));
  const {manager}=open();const good=await manager.request(prepareRequest());await parseForgetResult(good,validateResult);
  for(const change of [v=>{v.forget.intent={};},v=>{v.forget.preview.token={};},v=>{v.forget.preview.head.fact.subject=' ';},v=>{v.forget.report.incomplete=true;}]){const v=structuredClone(good);change(v);await assert.rejects(parseForgetResult(v,validateResult));}
  assert.equal(JSON.stringify(good).includes('config_sha256'),false);assert.equal(JSON.stringify(good).includes('accepted_base_sha256'),false);
});

test('shared clients cannot replace reservation and duplicate confirmation sends once with exact original input',async()=>{
  const pending=defer();const fixture=observer(async(selector,body)=>selector==='prepare-forget'?pending.promise:ack(selector,body.intent.operation));const {manager}=open(fixture);
  const first=manager.request(prepareRequest());assert.equal((await manager.request(prepareRequest())).forget.state,'busy');pending.resolve(await prepared());const ready=await first;assert.equal(ready.forget.state,'prepared');
  const [a,b]=await Promise.all([manager.request({action:'confirm',reference}),manager.request({action:'confirm',reference})]);assert.equal([a,b].filter(v=>v.forget.state==='acknowledged').length,1);assert.equal(fixture.calls.filter(c=>c.selector==='forget').length,1);
  assert.equal(JSON.parse(fixture.calls[1].bytes).intent.operation,operation);
});

test('late preparation after invalidation/new slot cannot publish or replace the newer preview',async()=>{
  const slow=defer();let n=0;const fixture=observer(async(selector,body)=>{assert.equal(selector,'prepare-forget');return ++n===1?slow.promise:prepared(body.operation,body.key);});let seed=1;const {manager}=open(fixture,{reference:()=>String(seed++).repeat(64),uuid:()=>id(seed)});
  const old=manager.request(prepareRequest());manager.invalidate();const current=await manager.request(prepareRequest());slow.resolve(await prepared(fixture.calls[0].body.operation));const stale=await old;assert.equal(stale.forget.state,'invalidated');assert.equal(stale.forget.preview,null);assert.equal((await manager.request({action:'status'})).forget.reference,current.forget.reference);
});

test('expiry and external refresh/cancel invalidate ready confirmation; proven refusal stays distinct',async()=>{
  let time=0;const {manager,fixture}=open(observer(),{now:()=>time});await manager.request(prepareRequest());time=120000;assert.equal((await manager.request({action:'confirm',reference})).forget.state,'unavailable');assert.equal(fixture.calls.length,1);
  time=0;await manager.request(prepareRequest());await manager.wrap().observe();assert.equal((await manager.request({action:'status'})).forget.state,'invalidated');
  const f=observer(async(selector,body)=>selector==='prepare-forget'?prepared(body.operation,body.key):failure('forget','conflict',false,'not-dispatched'));const x=open(f).manager;await x.request(prepareRequest());assert.equal((await x.request({action:'confirm',reference})).forget.state,'not-dispatched');x.invalidate();assert.equal((await x.request({action:'status'})).forget.state,'not-dispatched');
});

test('uncertain original bytes survive cancel/refresh and receipt is separate, same-target, read-only and exact',async()=>{
  const f=observer(async(selector,body)=>selector==='prepare-forget'?prepared(body.operation,body.key):selector==='forget'?failure('forget','unavailable',true,'unknown'):ack(selector,body.intent.operation));const {manager}=open(f);await manager.request(prepareRequest());assert.equal((await manager.request({action:'confirm',reference})).forget.state,'unknown');
  manager.invalidate();await manager.wrap().observe();assert.equal((await manager.request(prepareRequest())).forget.state,'busy');const r=await manager.request({action:'receipt',reference});assert.equal(r.forget.state,'acknowledged');assert.deepEqual(f.calls[1].bytes,f.calls[2].bytes);assert.equal(f.calls.filter(c=>c.selector==='forget').length,1);assert.equal(r.forget.preview,null);
});

test('late confirm and receipt completions after a newer observation epoch cannot settle/rearm host state',async()=>{
  for(const selector of ['forget','forget-receipt']){
    const slow=defer();const f=observer(async(sel,body)=>sel==='prepare-forget'?prepared(body.operation,body.key):sel===selector?slow.promise:failure('forget','unavailable',true,'unknown'));const {manager}=open(f);await manager.request(prepareRequest());let pending;
    if(selector==='forget')pending=manager.request({action:'confirm',reference});else{await manager.request({action:'confirm',reference});pending=manager.request({action:'receipt',reference});}
    manager.invalidate();await manager.wrap().observe();slow.resolve(ack(selector));assert.equal((await pending).forget.state,'unknown');assert.equal((await manager.request({action:'status'})).forget.state,'unknown');assert.equal((await manager.request({action:'confirm',reference})).forget.state,'unavailable');
  }
});

test('receipt invalid/pre-attempt report cannot erase prior uncertainty; restart cannot assert no dispatch',async()=>{
  const f=observer(async(selector,body)=>selector==='prepare-forget'?prepared(body.operation,body.key):selector==='forget'?failure('forget','unavailable',true,'unknown'):failure('forget','conflict',false,'not-dispatched'));const {manager}=open(f);await manager.request(prepareRequest());await manager.request({action:'confirm',reference});assert.equal((await manager.request({action:'receipt',reference})).forget.state,'unresolved');assert.equal(f.calls.filter(c=>c.selector==='forget').length,1);
  const restarted=new MemoryForgetHost({observer:f.host});assert.equal((await restarted.request({action:'status'})).forget.state,'none');assert.equal((await restarted.request({action:'receipt',reference})).forget.state,'unavailable');assert.equal(f.calls.filter(c=>c.selector==='forget').length,1);
});

test('host rechecks generation after asynchronous public validation, not just before it',async t=>{
  const fixture=await prepared();
  const original=globalThis.crypto.subtle.digest, paused=defer(), release=defer();let sha1=0;
  globalThis.crypto.subtle.digest=async function(algorithm,data){if(algorithm==='SHA-1'&&++sha1===3){paused.resolve();await release.promise;}return original.call(this,algorithm,data);};
  t.after(()=>{globalThis.crypto.subtle.digest=original;});
  const {manager}=open(observer(async()=>fixture));const pending=manager.request(prepareRequest());await paused.promise;manager.invalidate();release.resolve();assert.equal((await pending).forget.state,'invalidated');assert.equal((await manager.request({action:'status'})).forget.preview,null);
});


test('every preparation refusal preserves exact report flags without trapping the shared slot',async()=>{
 for(const [status,incomplete]of [['invalid-input',false],['unavailable',false],['busy',false],['unsupported',false],['unavailable',true]]){
  let refuse=true;const f=observer(async(selector,body)=>refuse?failure(selector,status,incomplete):prepared(body.operation,body.key));const {manager}=open(f);
  const result=await manager.request(prepareRequest());await parseForgetResult(result,validateResult);
  assert.equal(result.forget.state,status==='invalid-input'?'unavailable':status);assert.equal(result.forget.report.status,status);assert.equal(result.forget.report.incomplete,incomplete);assert.equal(result.forget.preview,null);
  refuse=false;assert.equal((await manager.request(prepareRequest())).forget.state,'prepared');assert.equal(f.calls.length,2);
 }
});
