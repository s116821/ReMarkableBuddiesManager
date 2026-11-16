import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIsolatedRootRequest,parseIsolatedRootResult} from '../host/isolated-root-protocol.mjs';
import {readIsolatedRootRecords,isolatedRootHash} from '../host/isolated-root-records.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {original,historical,id,identity,view,setup} from './fixtures/isolated-root.mjs';

test('new prepare privately persists its exact original before one dispatch and exposes reduced evidence',async()=>{
 const s=setup(),ready=await s.begin(),ref=view(ready).reference;
 assert.equal(view(ready).state,'ready');assert.equal(s.store.value,null);
 const result=await s.request('prepare',ref);
 assert.equal(view(result).state,'verified');assert.equal(view(result).report.result.currency,'current');
 await s.request('prepare',ref);assert.equal(s.calls.length,2);
 for(const field of ['actor','sha256','operation','expected','token','binding_sha256','input_base64','root_id'])assert.equal(JSON.stringify([ready,result]).includes('"'+field+'"'),false);
 assert.throws(()=>s.host.assertCurrent(ready));
});

test('lost response survives host restart and explicit retry reuses exact original bytes',async()=>{
 const s=setup({reject:true}),ref=view(await s.begin()).reference;
 assert.equal(view(await s.request('prepare',ref)).state,'unknown');
 const input=s.calls.at(-1).input_base64;s.restart();
 assert.equal(view(await s.host.request({action:'retained'})).retained[0].state,'unknown');
 assert.equal(view(await s.begin()).reference,ref);assert.equal(s.store.value.originals.length,1);
 s.options.reject=false;assert.equal(view(await s.request('retry',ref)).state,'verified');
 assert.equal(s.calls.at(-1).input_base64,input);
});

test('recovered refusal and pending reports remain separate from original uncertainty',async()=>{
 for(const [outcome,status,incomplete] of [['outcome-unknown','unavailable',true],['authorization-required','unavailable',true],
  ['retry-later','unavailable',true],['recovery-required','failed',true],['provider-binding-unqualified','unsupported',false]]){
  const s=setup({reject:true}),ref=view(await s.begin()).reference;await s.request('prepare',ref);s.restart();
  s.options.reject=false;s.options.report=structuredClone(original);Object.assign(s.options.report,{status,incomplete});s.options.report.data.isolated_root.outcome=outcome;
  const result=view(await s.request('retry',ref));assert.equal(result.state,'unknown');assert.equal(result.report.result.outcome,outcome);
  assert.equal(view(await s.begin()).reference,ref);assert.equal(s.store.value.originals.length,1);
 }
 const s=setup({report:{report_version:1,operation:'provision-isolated-backup',status:'conflict',incomplete:false,activation_performed:false,data:null}});
 const ref=view(await s.begin()).reference;const result=view(await s.request('prepare',ref));assert.equal(result.state,'unknown');assert.equal(result.report.status,'conflict');
});

test('explicit recovered original can settle with historical evidence without rebasing',async()=>{
 const s=setup({reject:true}),ref=view(await s.begin()).reference;await s.request('prepare',ref);s.restart();
 const input=s.calls.at(-1).input_base64;s.options.reject=false;s.options.report=historical;
 const result=view(await s.request('retry',ref));assert.equal(result.state,'verified');assert.equal(result.report.result.currency,'historical');assert.equal(s.calls.at(-1).input_base64,input);
 s.restart();assert.equal(view(await s.host.request({action:'retained'})).retained[0].state,'unknown');
});

test('uncertain storage acknowledgment never dispatches, and an appended original remains recoverable',async()=>{
 for(const writeFailure of ['before','after']){
  const s=setup({writeFailure}),ref=view(await s.begin()).reference;
  assert.equal(view(await s.request('prepare',ref)).state,'storage-unavailable');assert.equal(s.calls.length,1);
  s.options.writeFailure=null;s.restart();const retained=view(await s.host.request({action:'retained'})).retained;
  assert.equal(retained.length,writeFailure==='after'?1:0);
  if(writeFailure==='after'){assert.equal(retained[0].reference,ref);assert.equal(retained[0].state,'unknown');}
 }
});

test('private records reject corruption, duplicate identity, expanded authority and oversized bodies before inspection',async()=>{
 const source=setup();const ref=view(await source.begin()).reference;await source.request('prepare',ref);
 const base=source.store.isolatedRootOperations();
 const mutations=[v=>{v.value.originals[0].input_sha256='0'.repeat(64);},v=>{v.value.originals[0].input_base64+='=';},
  v=>{v.value.originals[0].snapshot.mode.binding_sha256='bad';},v=>{v.value.originals[0].path='private-secret';},
  v=>{v.value.originals.push(structuredClone(v.value.originals[0]));},v=>{v.value.originals[0].snapshot.token.sha256='a'.repeat(64);},
  v=>{v.value.version=2;},v=>{v.value.originals[0].input_base64='a'.repeat(800);},v=>{v.value.originals[0].snapshot.mode.extra=true;}];
 for(const mutate of mutations){const bad=structuredClone(base);mutate(bad);assert.throws(()=>readIsolatedRootRecords(bad),/^Error: Isolated backup storage unavailable$/);}
 source.store.value.originals[0].input_sha256='a'.repeat(64);const count=source.calls.length;
 assert.equal(view(await source.begin()).state,'storage-unavailable');assert.equal(source.calls.length,count);
});

test('record recovery preserves input whitespace and order rather than reserializing parsed input',async()=>{
 const s=setup({reject:true}),ref=view(await s.begin()).reference;await s.request('prepare',ref);
 const record=s.store.value.originals[0],parsed=JSON.parse(Buffer.from(record.input_base64,'base64'));
 const exact=Buffer.from(JSON.stringify({expected:parsed.expected,operation:parsed.operation,control_version:1},null,1));
 record.input_base64=exact.toString('base64');record.input_sha256=isolatedRootHash(exact);s.restart();
 s.options.reject=false;await s.request('retry',ref);assert.equal(s.calls.at(-1).input_base64,exact.toString('base64'));
});

test('expiry, cancellation and connection/boot changes refuse new dispatch',async()=>{
 for(const change of ['expiry','cancel','boot','connection']){
  const s=setup(),ref=view(await s.begin()).reference;
  if(change==='expiry')s.setClock(120000);
  if(change==='cancel')await s.host.request({action:'cancel',reference:ref,wait_id:s.wait});
  if(change==='boot')s.observer.lastObservation.boot_id=id(9);
  if(change==='connection')s.observer.lastObservation.connection_id=isolatedRootHash('another');
  await s.request('prepare',ref);assert.equal(s.calls.length,1);assert.equal(s.store.value,null);
 }
});

test('late acknowledgment after cancellation cannot settle original or release another owner',async()=>{
 const s=setup({delay:true}),ref=view(await s.begin()).reference,pending=s.request('prepare',ref);
 assert.equal(s.calls.length,2);await s.host.request({action:'cancel',reference:ref,wait_id:s.wait});
 const token=s.io.acquire('other','other','other');assert.ok(token);s.release();
 assert.equal(view(await pending).state,'invalidated');assert.equal(s.io.owns(token),true);
});

test('old cancellation and late completion cannot interrupt or replace a newer replay of the same original',async()=>{
 const s=setup({delay:true}),ref=view(await s.begin()).reference,first=s.request('prepare',ref);
 const firstWait=s.wait,releaseFirst=s.release;
 await s.host.request({action:'cancel',reference:ref,wait_id:firstWait});
 const second=s.request('retry',ref),releaseSecond=s.release;
 assert.notEqual(s.wait,firstWait);assert.equal(s.observer.cancelCount,1);
 await s.host.request({action:'cancel',reference:ref,wait_id:firstWait});
 assert.equal(s.observer.cancelCount,1,'stale cancel does not reach the newer child');
 releaseSecond();assert.equal(view(await second).state,'verified');
 releaseFirst();const stale=view(await first);assert.equal(stale.state,'invalidated');assert.equal(stale.report,null);
 assert.equal(stale.retained[0].state,'verified');
});

test('reading retained references during dispatch preserves the active record and its eventual evidence',async()=>{
 const s=setup({delay:true}),ref=view(await s.begin()).reference,pending=s.request('prepare',ref);
 assert.equal(view(await s.host.request({action:'retained'})).retained[0].state,'unknown');s.release();
 assert.equal(view(await pending).state,'verified');
});

test('cancelled old transport failures cannot borrow a newer replay result',async()=>{
 for(const cancelled of [true,false]){
  const s=setup({delay:true}),ref=view(await s.begin()).reference,first=s.request('prepare',ref);
  const firstWait=s.wait,releaseFirst=s.release;
  await s.host.request({action:'cancel',reference:ref,wait_id:firstWait});
  const second=s.request('retry',ref);s.release();assert.equal(view(await second).state,'verified');
  if(cancelled)s.options.cancelled=true;else s.options.reject=true;
  releaseFirst();const stale=view(await first);assert.equal(stale.state,'invalidated');assert.equal(stale.report,null);
  assert.equal(stale.retained[0].state,'verified');assert.equal(s.observer.cancelCount,1);
 }
});

test('an invalidated old timer cannot surface or cancel a newer original invocation',async()=>{
 const s=setup({delay:true,budgetMs:40}),ref=view(await s.begin()).reference,first=s.request('prepare',ref);
 const firstWait=s.wait,releaseFirst=s.release;
 await s.host.request({action:'cancel',reference:ref,wait_id:firstWait});
 const second=s.request('retry',ref);s.release();assert.equal(view(await second).state,'verified');
 const stale=view(await first);assert.equal(stale.state,'invalidated');assert.equal(stale.report,null);
 assert.equal(stale.retained[0].state,'verified');assert.equal(s.observer.cancelCount,1);releaseFirst();
});

test('invalidated inspection rejection cannot publish a fresh unavailable result',async()=>{
 const s=setup({inspectDelay:true}),pending=s.begin();s.host.invalidate();
 const token=s.io.acquire('other','other','other');s.options.inspectReject=true;s.release();
 assert.equal(view(await pending).state,'invalidated');assert.equal(s.io.owns(token),true);
});

test('one total deadline includes storage and closes an unresponsive owned transport',async()=>{
 const s=setup({storageDelay:45001}),ref=view(await s.begin()).reference;
 assert.equal(view(await s.request('prepare',ref)).state,'unknown');assert.equal(s.calls.length,1);
 const delayed=setup({budgetMs:25,delay:true}),otherRef=view(await delayed.begin()).reference;
 assert.equal(view(await delayed.request('prepare',otherRef)).state,'unknown');assert.equal(delayed.observer.cancelCount,1);
 delayed.release();
});

test('busy admission preserves ready preview and does not touch another maintenance owner',async()=>{
 const s=setup(),ready=await s.begin(),ref=view(ready).reference,token=s.io.acquire('other','other','other');
 assert.equal(view(await s.request('prepare',ref)).state,'busy');assert.equal(s.io.owns(token),true);s.host.assertCurrent(ready);
 s.io.release(token);assert.equal(view(await s.request('prepare',ref)).state,'verified');
});

test('bounded retention never evicts originals or replaces the same actor and epoch',async()=>{
 const s=setup({raw:'partial'});
 for(let i=1;i<=8;i++){s.options.snapshot=structuredClone(original.data.current_snapshot);s.options.snapshot.epoch=id(i);
  const ref=view(await s.begin()).reference;await s.request('prepare',ref);}
 s.options.snapshot.epoch=id(9);assert.equal(view(await s.begin()).state,'capacity');assert.equal(s.store.value.originals.length,8);
 s.options.snapshot.epoch=id(2);const existing=view(await s.begin());assert.equal(existing.reference,s.store.value.originals[1].reference);
});

test('public protocol refuses renderer authority, uncorrelated success and reports without fresh observation',async()=>{
 const s=setup(),ready=await s.begin(),ref=view(ready).reference,result=await s.request('prepare',ref);
 const q={action:'prepare',reference:ref,wait_id:s.wait,...identity(s.observer.lastObservation)};
 for(const v of [{...q,path:'/tmp/x'},{...q,input_base64:'eA=='},{...q,operation:id(3)},{...q,reference:null}])assert.throws(()=>parseIsolatedRootRequest(v));
 for(const mutate of [v=>{v.isolated_root_preparation.report.token='private-secret';},v=>{v.isolated_root_preparation.report.result.backup=id(99);},
  v=>{v.isolated_root_preparation.state='unknown';},v=>{v.status='unconfigured';v.observation=null;},v=>{v.isolated_root_preparation.report.result.outcome=['root-verified'];},
  v=>{v.isolated_root_preparation.retained[0].connection_id=isolatedRootHash('different-session');},v=>{v.isolated_root_preparation.retained[0].boot_id=id(71);}]){
  const v=structuredClone(result);mutate(v);assert.throws(()=>parseIsolatedRootResult(v,q,validateResult));
 }
 assert.throws(()=>parseIsolatedRootResult(result,{action:'begin',wait_id:id(72),...identity(s.observer.lastObservation)},validateResult));
});

test('non-isolated or unsupported inspect cannot create an original',async()=>{
 for(const mode of [null,{kind:'local-only'},{kind:'isolated-backup',backup:'bad',binding_sha256:'a'.repeat(64)}]){
  const snapshot=structuredClone(original.data.current_snapshot);snapshot.mode=mode;
  const s=setup({snapshot});assert.equal(view(await s.begin()).state,'unavailable');assert.equal(s.store.value,null);
 }
});
