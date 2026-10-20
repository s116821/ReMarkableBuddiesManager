import test from 'node:test';
import assert from 'node:assert/strict';
import { basicFixture,begin,save,identity,defer,report } from './fixtures/basic-settings.mjs';
import { prepareRequest } from './fixtures/memory-forget.mjs';
const started=async(f,selector)=>{for(let i=0;i<100;i++){if(f.calls.some(x=>x.selector===selector))return;await new Promise(r=>setImmediate(r));}throw Error('Expected fixture invocation not started');};
test('one Save privately prepares/applies once; clear/null and no-op preserve finite projection',async()=>{
 const f=basicFixture(),ref=await begin(f),v=await save(f,ref);assert.equal(v.basic_settings.state,'verified');assert.equal(v.basic_settings.report.disk_readback_verified,true);assert.equal(v.basic_settings.report.runtime_activation,'restart-required');assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);assert.equal((await save(f,ref)).basic_settings.state,'unavailable');
 const text=JSON.stringify(v);for(const s of ['base_sha256','target_sha256','config_path_sha256','intent','5'.repeat(64),'6'.repeat(64)])assert.equal(text.includes(s),false);
 const next=await begin(f),noop=await save(f,next);assert.equal(noop.basic_settings.state,'no-change');assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);
 const third=await begin(f),clear=await save(f,third,{log_level:{action:'clear'}});assert.equal(clear.basic_settings.current.log_level.origin,'default');
});
test('lost apply retains original packet, no retry; status observes desired file without historical/runtime verification',async()=>{
 const f=basicFixture();f.state.onApply=()=>{throw Error('Synthetic reply loss');};const ref=await begin(f);assert.equal((await save(f,ref)).basic_settings.state,'unknown');const original=f.calls.find(x=>x.selector==='apply').bytes;
 const snapshot=await f.basic.request({action:'retained'});assert.equal(snapshot.basic_settings.retained[0].reference,ref);assert.equal(f.calls.filter(x=>x.selector==='status').length,0);
 f.state.onStatus=()=>report('status','read-only',null,'unavailable');assert.equal((await f.basic.request({action:'status',...identity,reference:ref})).basic_settings.state,'unknown');
 f.state.onStatus=null;const checked=await f.basic.request({action:'status',...identity,reference:ref});assert.equal(checked.basic_settings.state,'desired-file-observed');assert.equal(checked.basic_settings.report.disk_readback_verified,false);assert.equal(checked.basic_settings.report.runtime_activation,'unverified');assert.deepEqual(f.calls.filter(x=>x.selector==='status').map(x=>x.bytes),[original,original]);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);
});
test('older remote status is busy during new Save, then invalidates an idle ready grant before I/O',async()=>{
 const f=basicFixture();f.state.onApply=()=>{throw Error('Synthetic loss');};const old=await begin(f);await save(f,old);const next=await begin(f),gate=defer();f.state.onApply=async r=>{await gate.promise;return r;};const active=save(f,next,{debug_dump:{action:'set',value:false}});await started(f,'apply');await new Promise(r=>setImmediate(r));const baseline=f.observer.cancels;
 const busy=await f.basic.request({action:'status',...identity,reference:old});assert.equal(busy.basic_settings.state,'busy');assert.equal(f.observer.cancels,baseline);gate.resolve();assert.equal((await active).basic_settings.state,'verified');
 const ready=await begin(f);await f.basic.request({action:'status',...identity,reference:old});const count=f.calls.length;assert.equal((await save(f,ready)).basic_settings.state,'unavailable');assert.equal(f.calls.length,count);
});
test('old forget cancel cannot cancel new basic apply; receipt keeps original bytes and uncertainty',async()=>{
 const f=basicFixture(),p=await f.forget.request(prepareRequest());f.state.forgetLost=true;await f.forget.request({action:'confirm',reference:p.forget.reference});const original=f.calls.find(x=>x.selector==='forget').bytes;
 const ref=await begin(f),gate=defer();f.state.onApply=async r=>{await gate.promise;return r;};const pending=save(f,ref);await started(f,'apply');const generation=f.observer.generation,cancels=f.observer.cancels;
 assert.equal((await f.forget.request({action:'cancel',reference:p.forget.reference})).forget.state,'unknown');assert.equal(f.observer.generation,generation);assert.equal(f.observer.cancels,cancels);gate.resolve();assert.equal((await pending).basic_settings.state,'verified');await f.forget.request({action:'receipt',reference:p.forget.reference});assert.deepEqual(f.calls.find(x=>x.selector==='forget-receipt').bytes,original);
});
test('ready expiry/budget and late callbacks do not dispatch apply or restore old authority',async()=>{
 let clock=0;const f=basicFixture({now:()=>clock});const ref=await begin(f);clock=120000;assert.equal((await save(f,ref)).basic_settings.state,'unavailable');assert.equal(f.calls.filter(x=>x.selector==='prepare').length,0);
 clock=0;const next=await begin(f);f.state.onPrepare=r=>{clock+=13001;return r;};assert.equal((await save(f,next)).basic_settings.state,'not-dispatched');assert.equal(f.calls.filter(x=>x.selector==='apply').length,0);
 f.state.onPrepare=null;clock=0;const old=await begin(f),gate=defer();f.state.onApply=async r=>{await gate.promise;return r;};const pending=save(f,old);await started(f,'apply');f.wrapped.cancel();const newer=await begin(f);gate.resolve();assert.equal((await pending).basic_settings.state,'unknown');assert.ok(newer);assert.equal(f.io.ownerFor('basic',newer),null);
});
test('eight unresolved originals are retained and capacity refuses a ninth Save before prepare',async()=>{
 const f=basicFixture();f.state.onApply=()=>{throw Error('Synthetic loss');};const refs=[];for(let i=0;i<8;i++){const ref=await begin(f);refs.push(ref);assert.equal((await save(f,ref,{debug_dump:{action:'set',value:i%2===0}})).basic_settings.state,'unknown');}
 const ref=await begin(f),count=f.calls.length;assert.equal((await save(f,ref,{debug_dump:{action:'set',value:true}})).basic_settings.state,'capacity');assert.equal(f.calls.length,count);assert.deepEqual((await f.basic.request({action:'retained'})).basic_settings.retained.map(x=>x.reference),refs);
});

test('one total coordinator timer cancels owned apply and retains unknown original; raw external run invalidates ready',async()=>{
 const f=basicFixture({budgetMs:500}),ref=await begin(f),gate=defer();f.state.onApply=async r=>{f.state.cancelled=()=>gate.resolve();await gate.promise;return r;};const value=await save(f,ref);assert.equal(value.basic_settings.state,'unknown');assert.equal(f.io.ownerFor('basic',ref),null);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);f.state.cancelled=null;
 const g=basicFixture(),ready=await begin(g);await g.wrapped.run('basic-settings',{selector:'inspect',input_base64:null,...identity});const count=g.calls.length;assert.equal((await save(g,ready)).basic_settings.state,'unavailable');assert.equal(g.calls.length,count);
});
