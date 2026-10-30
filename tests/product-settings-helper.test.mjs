import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { startHelper } from '../host/browser-helper.mjs';
import { ProductSettingsHost } from '../host/product-settings.mjs';
import { productFixture,identity,defer } from './fixtures/product-settings.mjs';
import { prepareRequest } from './fixtures/memory-forget.mjs';
async function open(t,f){const root=await mkdtemp(path.join(os.tmpdir(),'manager-product-'));await writeFile(path.join(root,'index.html'),'<main>fixture</main>');t.after(()=>rm(root,{recursive:true,force:true}));const h=await startHelper({root,observer:f.observer,driveAuth:{dispose(){}}});t.after(()=>h.close());const page=await fetch(h.origin+'/preview/');const headers={Origin:h.origin,Cookie:page.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};const send=(q,route='/manager-product-settings',override=headers)=>fetch(h.origin+route,{method:'POST',headers:override,body:typeof q==='string'?q:Buffer.isBuffer(q)?q:JSON.stringify(q)});return {...h,headers,send,product:async q=>{const r=await send(q);assert.equal(r.status,200);return r.json();},forget:async q=>{const r=await send(q,'/manager-memory-forget');assert.equal(r.status,200);return r.json();}};}
const get=(url,headers)=>new Promise((resolve,reject)=>{const req=httpRequest(url,{headers},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);req.end();});
test('actual HTTP origin/session/size/UTF8/duplicate guards and final public generation guard stay installed',async t=>{
 const f=productFixture(),h=await open(t,f);for(const headers of [{},{...h.headers,Origin:'https://invalid.example'},{...h.headers,Cookie:'other'}])assert.equal((await h.send({action:'retained'},undefined,headers)).status,403);
 for(const body of [{action:'begin',...identity,path:'/private'},{action:'begin',...identity,boot_id:identity.boot_id+'\n'},{action:'begin',...identity,connection_id:identity.connection_id+'\n'},'{"action":"retained","action":"retained"}',Buffer.from([255]),null])assert.equal((await h.send(body)).status,400);
 assert.equal((await h.send('x'.repeat(1025))).status,413);assert.equal((await h.send({action:'retained'},'/manager-product-settings?mode=apply')).status,403);assert.equal(f.calls.length,0);
 const ready=await h.product({action:'begin',...identity});assert.equal(ready.product_settings.state,'ready');const text=JSON.stringify(ready);for(const key of ['base_sha256','target_sha256','config_path_sha256','intent'])assert.equal(text.includes(key),false);
 const original=ProductSettingsHost.prototype.request;ProductSettingsHost.prototype.request=async function(q){const value=await original.call(this,q);if(q.action==='begin')this.invalidate();return value;};t.after(()=>{ProductSettingsHost.prototype.request=original;});assert.equal((await h.send({action:'begin',...identity})).status,503);
});
test('actual HTTP old forget cancel cannot touch newer product apply or original receipt bytes',async t=>{
 const f=productFixture(),h=await open(t,f);const old=await h.forget(prepareRequest());f.state.forgetLost=true;assert.equal((await h.forget({action:'confirm',reference:old.forget.reference})).forget.state,'unknown');const original=f.calls.find(x=>x.selector==='forget').bytes;
 const ready=await h.product({action:'begin',...identity}),started=defer(),gate=defer();f.state.onApply=async r=>{started.resolve();await gate.promise;return r;};const pending=h.product({action:'save',...identity,reference:ready.product_settings.reference,changes:{reader_enabled:{action:'set',value:false}}});await started.promise;
 const generation=f.observer.generation,cancels=f.observer.cancels;assert.equal((await h.forget({action:'cancel',reference:old.forget.reference})).forget.state,'unknown');assert.equal(f.observer.generation,generation);assert.equal(f.observer.cancels,cancels);gate.resolve();assert.equal((await pending).product_settings.state,'verified');await h.forget({action:'receipt',reference:old.forget.reference});assert.deepEqual(f.calls.find(x=>x.selector==='forget-receipt').bytes,original);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);
});
test('actual HTTP older remote status is busy during newer Save and invalidates a merely ready grant',async t=>{
 const f=productFixture(),h=await open(t,f);f.state.onApply=()=>{throw Error('Synthetic report loss');};const first=await h.product({action:'begin',...identity}),old=first.product_settings.reference;await h.product({action:'save',...identity,reference:old,changes:{reader_enabled:{action:'set',value:false}}});
 const next=await h.product({action:'begin',...identity}),started=defer(),gate=defer();f.state.onApply=async r=>{started.resolve();await gate.promise;return r;};const pending=h.product({action:'save',...identity,reference:next.product_settings.reference,changes:{reader_enabled:{action:'set',value:true}}});await started.promise;
 const generation=f.observer.generation;assert.equal((await h.product({action:'cancel',reference:old})).product_settings.state,'unknown');assert.equal(f.observer.generation,generation);assert.equal((await h.product({action:'status',...identity,reference:old})).product_settings.state,'busy');assert.equal(f.observer.generation,generation);gate.resolve();assert.equal((await pending).product_settings.state,'verified');
 const ready=await h.product({action:'begin',...identity});await h.product({action:'status',...identity,reference:old});const count=f.calls.length;assert.equal((await h.product({action:'save',...identity,reference:ready.product_settings.reference,changes:{reader_enabled:{action:'set',value:false}}})).product_settings.state,'unavailable');assert.equal(f.calls.length,count);
});
test('actual helper distinguishes document from resource/iframe and never publishes late ready or verified result',async t=>{
 const f=productFixture(),h=await open(t,f),ready=await h.product({action:'begin',...identity}),generation=f.observer.generation;
 for(const headers of [{'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'},{'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe'}])assert.equal(await get(h.origin+'/preview/',headers),200);assert.equal(f.observer.generation,generation);
 const gate=defer(),started=defer();f.state.onApply=async r=>{started.resolve();await gate.promise;return r;};const pending=h.product({action:'save',...identity,reference:ready.product_settings.reference,changes:{reader_enabled:{action:'set',value:false}}});await started.promise;await get(h.origin+'/preview/',{'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'});gate.resolve();assert.equal((await pending).product_settings.state,'unknown');assert.equal((await h.product({action:'retained'})).product_settings.retained.length,1);
 for(const change of ['document','same-ID-refresh']){
  const reading=defer(),response=defer();f.state.onInspect=async r=>{reading.resolve();await response.promise;return r;};const late=h.product({action:'begin',...identity});await reading.promise;
  if(change==='document')await get(h.origin+'/preview/',{'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'});
  else {const observed=await h.send({action:'observe'},'/manager-host');assert.equal(observed.status,200);assert.equal((await observed.json()).observation.boot_id,identity.boot_id);}
  response.resolve();const rejected=await late;assert.equal(rejected.product_settings.state,'invalidated',change);assert.equal(rejected.product_settings.current,null,change);assert.equal(rejected.product_settings.reference,null,change);
 }
});
