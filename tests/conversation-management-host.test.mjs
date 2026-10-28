import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {managementFixture,defer} from './fixtures/conversation-management.mjs';
const c=v=>v.conversation_management;
const cancel=(f,reference,invocation)=>f.host.request({action:'cancel',reference,invocation});
test('explicit inspect then fresh prepare then once-only apply and byte-identical status',async()=>{
 const f=managementFixture();assert.equal(c(await f.use('prepare','a'.repeat(64))).state,'invalidated');assert.equal(f.calls.length,0);
 const inspected=c(await f.inspect());assert.equal(inspected.state,'inspected');assert.equal(c(await f.use('confirm',inspected.reference)).state,'not-dispatched');
 const ready=c(await f.use('prepare',inspected.reference));assert.equal(ready.state,'ready');assert.equal(c(await f.use('confirm',ready.reference)).state,'unknown');assert.equal(c(await f.use('confirm',ready.reference)).state,'not-dispatched');assert.equal(c(await f.use('status',ready.reference)).state,'unchanged');
 assert.deepEqual(f.calls.map(x=>x.selector),['inspect','prepare','apply','status']);assert.deepEqual(f.calls[2].body,f.calls[3].body);assert.deepEqual(Object.keys(f.calls[2].body),['intent']);assert.equal(c(await f.inspect()).state,'capacity');
 const safe=JSON.stringify(await f.host.request({action:'retained'}));for(const key of ['intent_sha256','receipt','actor','generation','config_path','input_base64'])assert.equal(safe.includes(key),false);
});
test('acknowledgment and changed current state remain distinct; partial without receipt unresolved',async()=>{
 const f=managementFixture(),ready=c(await f.prepare());f.state.apply='unresolved';f.state.onRaw=r=>{r.possible_effect=true;return r;};assert.equal(c(await f.use('confirm',ready.reference)).state,'unresolved');
 f.state.status='acknowledged';f.state.onRaw=r=>{r.current_state='changed';return r;};const ack=c(await f.use('status',ready.reference));assert.equal(ack.state,'acknowledged');assert.equal(ack.report.current_state,'changed');assert.equal(ack.retained.length,0);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);
});
test('lost apply/future output preserves original; status positive-effect conflict is unknown',async()=>{
 const f=managementFixture(),ready=c(await f.prepare());f.state.onRaw=(r,q)=>{if(q.selector==='apply')throw Error('PRIVATE');return r;};assert.equal(c(await f.use('confirm',ready.reference)).state,'unknown');
 f.state.onRaw=r=>{r.status='conflict';r.possible_effect=true;r.current_state=null;return r;};const result=c(await f.use('status',ready.reference));assert.equal(result.state,'unknown');assert.equal(result.report.status,'conflict');assert.equal(result.retained.length,1);
});
test('shared busy leaves hook/ledger/child/cancel untouched and ready can still confirm',async()=>{
 const f=managementFixture(),ready=c(await f.prepare()),token=f.io.acquire('peer','other','write'),before=[f.calls.length,f.state.hooks,f.observer.cancels];for(let n=0;n<40;n++)assert.equal(c(await f.use('confirm',ready.reference)).state,'busy');assert.deepEqual([f.calls.length,f.state.hooks,f.observer.cancels],before);assert.ok(f.io.owns(token));f.io.release(token);assert.equal(c(await f.use('confirm',ready.reference)).state,'unknown');
});
test('late same-reference cancellation cannot cancel later original status',async()=>{
 const f=managementFixture(),ready=c(await f.prepare());await f.use('confirm',ready.reference);const old=randomUUID();await f.use('status',ready.reference,old);const entered=defer(),gate=defer();f.state.onRaw=async r=>{entered.resolve();await gate.promise;return r;};const inv=randomUUID(),pending=f.use('status',ready.reference,inv);await entered.promise;const owner=f.io.ownerFor('conversation-management',ready.reference),before=f.observer.cancels;assert.equal(c(await cancel(f,ready.reference,old)).state,'unavailable');assert.ok(f.io.owns(owner));assert.equal(f.observer.cancels,before);gate.resolve();assert.equal(c(await pending).state,'unchanged');
});
test('cancellation before confirm fences only intended invocation and never retries',async()=>{
 const f=managementFixture(),ready=c(await f.prepare()),inv=randomUUID();await cancel(f,ready.reference,inv);assert.equal(c(await f.use('confirm',ready.reference,inv)).state,'not-dispatched');assert.equal(f.calls.length,2);assert.equal(c(await f.use('confirm',ready.reference)).state,'unknown');
});
test('expiry is nonrenewable, no target replacement or capacity eviction',async()=>{
 let now=0;const f=managementFixture({now:()=>now}),old=c(await f.prepare());now=120001;assert.equal(c(await f.use('confirm',old.reference)).state,'not-dispatched');
 const refs=[];for(let n=0;n<8;n++){const r=c(await f.prepare(randomUUID()));refs.push(r.reference);await f.use('confirm',r.reference);}assert.equal(c(await f.inspect()).state,'capacity');now+=1799999;await f.use('status',refs[0]);now+=2;const rows=c(await f.host.request({action:'retained'})).retained;assert.equal(rows.length,8);assert.ok(rows.every(r=>!r.status_available));assert.equal(c(await f.use('status',refs[0])).state,'unavailable');
});
test('never-resolving apply bounded; old timeout/finally cannot revoke successor',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0;const f=managementFixture({now:()=>now}),ready=c(await f.prepare()),gate=defer(),entered=defer();f.state.onRaw=async r=>{entered.resolve();await gate.promise;return r;};const inv=randomUUID(),pending=f.use('confirm',ready.reference,inv);await entered.promise;assert.equal(c(await cancel(f,ready.reference,inv)).state,'unknown');const next=f.io.acquire('peer','next','read');now=13001;t.mock.timers.tick(13001);gate.resolve();await pending;assert.ok(f.io.owns(next));f.io.release(next);
});
test('original ledger exhaustion retains all originals with status unavailable',async()=>{
 const f=managementFixture(),ready=c(await f.prepare());await f.use('confirm',ready.reference);for(let n=0;n<29;n++)await cancel(f,ready.reference,randomUUID());const row=c(await f.host.request({action:'retained'})).retained[0];assert.equal(row.status_available,false);assert.equal(c(await f.use('status',ready.reference)).state,'capacity');assert.equal(f.calls.length,3);
});
test('never-resolving apply expires at original13s and retains uncertainty',async t=>{t.mock.timers.enable({apis:['setTimeout']});let now=0;const f=managementFixture({now:()=>now}),ready=c(await f.prepare());f.state.onRaw=()=>new Promise(()=>{});const pending=f.use('confirm',ready.reference);now=13001;t.mock.timers.tick(13001);const r=c(await pending);assert.equal(r.state,'unknown');assert.equal(r.retained.length,1);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);const token=f.io.acquire('peer','next','read');assert.ok(token);f.io.release(token);});
test('all valid prepublication Apply refusals settle only this invocation and never repeat',async()=>{for(const status of ['invalid-input','unavailable','unsupported','busy','conflict']){const f=managementFixture(),ready=c(await f.prepare());f.state.apply=status;const r=c(await f.use('confirm',ready.reference));assert.equal(r.state,'not-dispatched',status);assert.equal(r.report.possible_effect,false);assert.equal(r.retained.length,0);assert.equal(c(await f.use('confirm',ready.reference)).state,'not-dispatched');assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);}});
test('malformed/future Apply reply remains original-only unknown and cannot reprepare target',async()=>{for(const bad of ['{"report_version":2}\n','{}\n','\ufeff{}\n']){const f=managementFixture(),ready=c(await f.prepare());f.state.onRaw=(r,q)=>q.selector==='apply'?bad:r;const r=c(await f.use('confirm',ready.reference));assert.equal(r.state,'unknown');assert.equal(r.report,null);assert.equal(r.retained.length,1);assert.equal(c(await f.inspect()).state,'capacity');assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);}});
