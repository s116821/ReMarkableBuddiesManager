import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHelper } from '../host/browser-helper.mjs';
import { MemoryForgetController } from '../src/memory-forget.ts';
import { observer,prepared,ack,failure,prepareRequest,reference,operation } from './fixtures/memory-forget.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('actual helper shared-session clients reserve/claim once and deny malformed/origin/private inputs',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'manager-forget-helper-'));await writeFile(path.join(root,'index.html'),'<main>fixture</main>');t.after(()=>rm(root,{recursive:true,force:true}));
 const pending=deferred();const f=observer(async(selector,body)=>selector==='prepare-forget'?pending.promise:ack(selector,body.intent.operation));
 const helper=await startHelper({root,observer:f.host,driveAuth:{dispose(){}}});t.after(()=>helper.close());
 const initial=await fetch(helper.origin+'/preview/');const headers={Origin:helper.origin,Cookie:initial.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
 const send=(q,h=headers,suffix='')=>fetch(helper.origin+'/manager-memory-forget'+suffix,{method:'POST',headers:h,body:typeof q==='string'?q:JSON.stringify(q)});
 for(const h of [{...headers,Origin:'https://untrusted.invalid'},{...headers,Cookie:''},{...headers,'Content-Type':'text/plain'}])assert.equal((await send({action:'status'},h)).status,403);
 assert.equal((await send({action:'status'},headers,'?path=/bad')).status,403);
 for(const q of [' {"action":"status"}','{"action":"status","action":"prepare"}',{...prepareRequest(),intent:{}},{action:'confirm',reference,packet:{}}])assert.equal((await send(q)).status,400);
 assert.equal((await send('x'.repeat(2049))).status,413);assert.equal(f.calls.length,0);
 const read=await fetch(helper.origin+'/manager-host',{method:'POST',headers,body:'{"action":"observe"}'});assert.equal(read.status,200);
 const first=send(prepareRequest());while(!f.calls.length)await new Promise(r=>setTimeout(r,2));assert.equal((await (await send(prepareRequest())).json()).forget.state,'busy');
 pending.resolve(await prepared(f.calls[0].body.operation));const ready=await (await first).json();const ref=ready.forget.reference;assert.equal(ready.forget.state,'prepared');assert.equal(JSON.stringify(ready).includes('config_sha256'),false);
 const outputs=await Promise.all([send({action:'confirm',reference:ref}),send({action:'confirm',reference:ref})]);const values=await Promise.all(outputs.map(r=>r.json()));assert.equal(values.filter(v=>v.forget.state==='acknowledged').length,1);assert.equal(f.calls.filter(c=>c.selector==='forget').length,1);
});

test('controller preserves uncertain state across clear/new-host none and receipt refusals, never auto retries',async()=>{
 const c=new MemoryForgetController(()=>{});let calls=0;
 const empty=(state,ref=null)=>({contract_version:1,status:'unconfigured',observation:null,forget:{state,reference:ref,preview:null,acknowledgement:null,report:null}});
 // Use the real coordinator for valid prepared projections; mock only bounded transport.
 const {MemoryForgetHost}=await import('../host/memory-forget.mjs');
 const f=observer(async(selector,body)=>selector==='prepare-forget'?prepared(body.operation,body.key):failure(selector,'unavailable',true,selector==='forget'?'unknown':'unresolved'));
 const host=new MemoryForgetHost({observer:f.host,reference:()=>reference,uuid:()=>operation});const adapter={memoryForget:async q=>{calls++;return host.request(q);}};
 await c.run(adapter,prepareRequest());await c.run(adapter,{action:'confirm',reference});assert.equal(c.state.uncertain,true);assert.equal(c.state.view.preview,null);
 c.clear();await c.run({memoryForget:async()=>empty('none')},{action:'status'});assert.equal(c.state.uncertain,true);assert.match(c.state.status,/unavailable|unresolved/);
 assert.equal(calls,2);await c.run(adapter,{action:'receipt',reference});assert.equal(c.state.uncertain,true);assert.equal(f.calls.filter(c=>c.selector==='forget').length,1);
});

test('controller serializes stop completion before allowing another receipt/status operation',async()=>{
 const c=new MemoryForgetController(()=>{});const pending=deferred();let reads=0;
 const stopping=c.stop(null,()=>pending.promise);assert.equal(c.state.busy,true);
 await c.run({memoryForget:async()=>{reads++;throw Error('Unexpected call');}},{action:'status'});assert.equal(reads,0);
 pending.resolve();await stopping;assert.equal(c.state.busy,false);assert.match(c.state.status,/invalidated/);
});

test('actual helper refuses preparation invalidated during its second public validation before output',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'manager-forget-bridge-'));await writeFile(path.join(root,'index.html'),'<main>fixture</main>');t.after(()=>rm(root,{recursive:true,force:true}));
 const fixture=await prepared();const f=observer(async(selector,body)=>{assert.equal(selector,'prepare-forget');const report=structuredClone(fixture);report.data.intent.operation=body.operation;return report;});const helper=await startHelper({root,observer:f.host,driveAuth:{dispose(){}}});t.after(()=>helper.close());
 const initial=await fetch(helper.origin+'/preview/');const headers={Origin:helper.origin,Cookie:initial.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
 await fetch(helper.origin+'/manager-host',{method:'POST',headers,body:'{"action":"observe"}'});
 const pause=deferred(),release=deferred(),original=globalThis.crypto.subtle.digest;let sha1=0;
 globalThis.crypto.subtle.digest=async function(algorithm,data){if(algorithm==='SHA-1'&&++sha1===4){pause.resolve();await release.promise;}return original.call(this,algorithm,data);};t.after(()=>{globalThis.crypto.subtle.digest=original;});
 const pending=fetch(helper.origin+'/manager-memory-forget',{method:'POST',headers,body:JSON.stringify(prepareRequest())});
 await pause.promise;await fetch(helper.origin+'/preview/');release.resolve();assert.equal((await pending).status,503);
 const state=await (await fetch(helper.origin+'/manager-memory-forget',{method:'POST',headers,body:'{"action":"status"}'})).json();assert.equal(state.forget.state,'invalidated');assert.equal(state.forget.preview,null);
});


test('preparation hides an older terminal reference so stop invalidates the pending reservation',async()=>{
 const c=new MemoryForgetController(()=>{}),pending=deferred();
 const {MemoryForgetHost}=await import('../host/memory-forget.mjs');
 let delayed=false,n=0;
 const f=observer(async(selector,body)=>selector==='prepare-forget'?(delayed?pending.promise:prepared(body.operation,body.key)):ack(selector,body.intent.operation));
 const host=new MemoryForgetHost({observer:f.host,reference:()=>String(++n).repeat(64),uuid:()=>operation});
 const adapter={memoryForget:q=>host.request(q)};
 await c.run(adapter,prepareRequest());const first=c.state.reference;
 await c.run(adapter,{action:'confirm',reference:first});assert.equal(c.state.view.state,'acknowledged');
 delayed=true;const preparing=c.run(adapter,prepareRequest());assert.equal(c.state.reference,null);
 let canceled=0;await c.stop(adapter,async()=>{canceled++;host.invalidate();f.host.cancel();});
 assert.equal(canceled,1);pending.resolve(await prepared());await preparing;
 assert.equal(c.state.view,null);assert.equal((await host.request({action:'status'})).forget.state,'invalidated');
});

test('cancel racing an already completed acknowledgement can recover it without another CLI call',async()=>{
 const {MemoryForgetHost}=await import('../host/memory-forget.mjs');const f=observer();
 const host=new MemoryForgetHost({observer:f.host,reference:()=>reference,uuid:()=>operation});
 await host.request(prepareRequest());await host.request({action:'confirm',reference});
 await host.request({action:'cancel',reference});const c=new MemoryForgetController(()=>{});
 c.state={status:'unknown',busy:false,uncertain:true,reference,view:null};
 await c.run({memoryForget:q=>host.request(q)},{action:'receipt',reference});
 assert.equal(c.state.view.state,'acknowledged');assert.equal(c.state.uncertain,false);assert.equal(f.calls.length,2);
});


test('deliberate same-original host status settles a lost definitive refusal, while later/null/foreign refusals do not',async()=>{
 const {MemoryForgetHost}=await import('../host/memory-forget.mjs');
 const f=observer(async(selector,body)=>selector==='prepare-forget'?prepared(body.operation,body.key):failure('forget','conflict',false,'not-dispatched'));
 const host=new MemoryForgetHost({observer:f.host,reference:()=>reference,uuid:()=>operation}),c=new MemoryForgetController(()=>{});
 const adapter={memoryForget:async q=>{const value=await host.request(q);if(q.action==='confirm')throw Error('Synthetic renderer reply loss');return value;}};
 await c.run(adapter,prepareRequest());await c.run(adapter,{action:'confirm',reference});
 assert.equal(c.state.uncertain,true);assert.equal((await host.request({action:'status'})).forget.state,'not-dispatched');
 const retained=await host.request({action:'status'});
 // A row offered as a later receipt invocation is not retained-host reconciliation.
 await c.run({memoryForget:async()=>retained},{action:'receipt',reference});assert.equal(c.state.uncertain,true);
 for(const ref of [null,'1'.repeat(64)]){const value=structuredClone(retained);value.forget.reference=ref;await c.run({memoryForget:async()=>value},{action:'status'});assert.equal(c.state.uncertain,true);assert.equal(c.state.reference,reference);}
 await c.run(adapter,{action:'receipt',reference});assert.equal(c.state.uncertain,true);
 await c.run(adapter,{action:'status'});assert.equal(c.state.view.state,'not-dispatched');assert.equal(c.state.uncertain,false);assert.match(c.state.status,/refused before mutation attempt/);
 assert.equal(f.calls.filter(x=>x.selector==='forget').length,1);
 assert.equal(f.calls.filter(x=>x.selector==='forget-receipt').length,0);
 await c.run(adapter,prepareRequest());assert.equal(c.state.view.state,'prepared');
});
