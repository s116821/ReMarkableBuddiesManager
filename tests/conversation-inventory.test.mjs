import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {parseConversationRaw,ConversationUnsupported} from '../host/conversation-inventory-private.mjs';
import {parseConversationRequest,parseConversationResult} from '../host/conversation-inventory-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {conversationFixture,identity,defer,inventoryReport,secret} from './fixtures/conversation-inventory.mjs';
const cleanup=f=>{for(const h of Object.values(f.lanes))h.invalidate();};
test('41 independent accepted wire/authority/UUID/framing vectors and safe reductions',async()=>{
 const v=JSON.parse(await readFile(new URL('./fixtures/conversation-inventory-reference-vectors.json',import.meta.url),'utf8'));let count=0;
 for(const section of ['valid','invalid','invalid_framing'])for(const row of v[section]){const b=Buffer.from(row.encoded_utf8);assert.equal(b.length,row.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),row.sha256);let value=null,status='accept';try{value=parseConversationRaw(b);}catch(e){status=e instanceof ConversationUnsupported?'unsupported':'unavailable';}assert.equal(status,row.expected,row.name);if(section==='valid'){const {report_version,scope,...view}=row.report;void report_version;void scope;assert.deepEqual(value,view);assert.equal(Object.keys(value).length,11);}count++;}
 assert.equal(count,41);
});
test('identity-only request and guarded safe envelope never admit raw owner/report/action/path',async()=>{
 for(const q of [{...identity,path:'/SYNTHETIC'},{...identity,action:'inspect'},{...identity,budget_ms:1},{...identity,boot_id:'00000000-0000-0000-0000-000000000000'},[],null])assert.throws(()=>parseConversationRequest(q));
 const f=conversationFixture(),v=await f.conversations.request(identity);assert.equal(v.conversation_inventory.status,'reported');for(const key of ['actor','generation','raw','report','path']){const bad=structuredClone(v);bad.conversation_inventory.view[key]='SYNTHETIC_PRIVATE';assert.throws(()=>parseConversationResult(bad,identity,validateResult));}cleanup(f);
});
test('empty and all producer refusals remain distinct with safe fields and exact nulls',async()=>{
 for(const status of ['complete','too-large','unsupported','unavailable','busy','conflict']){const f=conversationFixture();f.conversationState.report=inventoryReport([],status);const v=await f.conversations.request(identity);assert.equal(v.conversation_inventory.status,'reported');assert.equal(v.conversation_inventory.view.status,status);assert.deepEqual(v.conversation_inventory.view.candidates,status==='complete'?[]:null);assert.equal(v.conversation_inventory.view.candidate_count,status==='complete'?0:null);assert.equal(JSON.stringify(v).includes('11111111-1111-4111-8111-111111111111'),false);cleanup(f);}
});
test('raw observer admits real read token; Busy has no hook/cancel/I/O and late output cannot cross epoch',async()=>{
 const ref="9".repeat(64),f=conversationFixture({reference:()=>ref}),entered=defer(),gate=defer();f.conversationState.onInspect=async r=>{const owner=f.io.ownerFor('conversation-inventory',ref);assert.ok(owner);assert.equal(f.io.owns(owner),true);entered.resolve();await gate.promise;return r;};const pending=f.conversations.request(identity);await entered.promise;const before=[f.conversationState.hooks,f.observer.cancels,f.calls.length];assert.equal((await f.conversations.request(identity)).conversation_inventory.status,'busy');assert.deepEqual([f.conversationState.hooks,f.observer.cancels,f.calls.length],before);f.conversations.invalidate();gate.resolve();assert.equal((await pending).conversation_inventory.status,'unavailable');cleanup(f);
});
test('remaining host budget and old timer/finally cannot cancel or release a newer owner',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0;const f=conversationFixture({now:()=>now}),entered=defer(),gate=defer();f.conversationState.onInspect=async r=>{entered.resolve();await gate.promise;return r;};const pending=f.conversations.request(identity);await entered.promise;assert.equal(f.calls.findLast(x=>x.action==='conversation-inventory').budget_ms,12000);f.conversations.invalidate();const newer=f.io.acquire('SYNTHETIC_NEW_OWNER','new','save'),cancels=f.observer.cancels;now=13001;t.mock.timers.tick(13001);const v=await pending;assert.equal(v.conversation_inventory.status,'unavailable');assert.equal(f.observer.cancels,cancels);assert.equal(f.io.owns(newer),true);gate.resolve();for(let i=0;i<6;i++)await Promise.resolve();assert.equal(f.io.owns(newer),true);f.io.release(newer);cleanup(f);
});
test('13s never-resolving observer is bounded, releases only its read and exposes no metadata',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0;const f=conversationFixture({now:()=>now});f.conversationState.onInspect=()=>new Promise(()=>{});const pending=f.conversations.request(identity);now=13001;t.mock.timers.tick(13001);const v=await pending;assert.equal(v.conversation_inventory.status,'unavailable');assert.equal(v.conversation_inventory.view,null);assert.equal(f.io.acquire('new','new','save')!==null,true);cleanup(f);
});
test('inventory preserves eight uncertain originals and never renews their private expiry',async()=>{
 let now=0;const f=conversationFixture({}, {now:()=>now}),refs=[];f.modelCredentialState.onApply=()=>{throw Error(secret);};
 for(let n=0;n<8;n++){const reference=(await f.modelCredential.request({action:'begin',...identity})).model_credential.reference;refs.push(reference);assert.equal((await f.modelCredential.request({action:'save',...identity,reference,change:{action:n?'replace':'install',value:secret+n}})).model_credential.state,'unknown');}
 const original=(await f.modelCredential.request({action:'retained'})).model_credential.retained;assert.equal(original.length,8);assert.ok(original.every(x=>x.status_available));now=1799999;await f.conversations.request(identity);assert.deepEqual((await f.modelCredential.request({action:'retained'})).model_credential.retained,original);
 now=1800001;await f.conversations.request(identity);const expired=(await f.modelCredential.request({action:'retained'})).model_credential.retained;assert.deepEqual(expired.map(x=>x.reference),refs);assert.ok(expired.every(x=>!x.status_available));const before=f.calls.length;assert.equal((await f.modelCredential.request({action:'status',...identity,reference:refs[0]})).model_credential.state,'unavailable');assert.equal(f.calls.length,before);assert.equal(f.calls.filter(x=>x.action==='model-credential'&&x.selector==='apply').length,8);cleanup(f);
});
test('inventory preserves each of eight prior operation uncertainty records without dispatching status/apply',async()=>{
 const {lanes}=await import('./fixtures/maintenance-eight-lanes.mjs');const map={modelCredential:'modelCredential',credentialReference:'credential',memorySettings:'memory',researchSettings:'research',modelSettings:'model',basicSettings:'basic',memoryForget:'forget',ordinaryExport:'export'};
 for(const [name,a]of Object.entries(lanes)){const f=conversationFixture(),host=f.lanes[map[name]],ready=(await host.request(a.begin()))[a.key];assert.ok(ready.reference,name);const originalRun=f.observer.run;f.observer.run=async function(action,q){const r=await originalRun.call(this,action,q);if(['apply','forget'].includes(q.selector))throw Error('SYNTHETIC_LOST_REPLY');return r;};const q=a.change?{action:'save',...identity,reference:ready.reference,change:a.change}:a.changes?{action:'save',...identity,reference:ready.reference,changes:a.changes}:name==='memoryForget'?{action:'confirm',reference:ready.reference}:{action:'confirm',...identity,reference:ready.reference};assert.equal((await host.request(q))[a.key].state,'unknown',name);
 const retainedRequest=name==='memoryForget'?{action:'status'}:{action:'retained'},before=(await host.request(retainedRequest))[a.key];const original=name==='memoryForget'?{reference:before.reference,state:before.state}:before.retained;const calls=f.calls.length;await f.conversations.request(identity);const after=(await host.request(retainedRequest))[a.key];assert.deepEqual(name==='memoryForget'?{reference:after.reference,state:after.state}:after.retained,original,name);assert.equal(f.calls.length,calls+1,'only inventory dispatches');cleanup(f);}
});

test('discovery preserves the tenth cleanup owner unknown original without retry or expiry renewal',async()=>{
 const f=conversationFixture();const ready=(await f.cacheCleanup.request({action:'prepare',...identity,document:'22222222-2222-4222-8222-222222222222',invocation:'33333333-3333-4333-8333-333333333333'})).source_cache_cleanup;
 assert.equal(ready.state,'ready');
 const applied=(await f.cacheCleanup.request({action:'confirm',...identity,reference:ready.reference,invocation:'44444444-4444-4444-8444-444444444444'})).source_cache_cleanup;
 assert.equal(applied.state,'unknown');const before=(await f.cacheCleanup.request({action:'retained'})).source_cache_cleanup;
 const calls=f.calls.length;await f.conversations.request(identity);
 assert.deepEqual((await f.cacheCleanup.request({action:'retained'})).source_cache_cleanup,before);
 assert.equal(f.calls.length,calls+1);cleanup(f);
});
