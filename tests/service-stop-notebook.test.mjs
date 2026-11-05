// Synthetic source custody only; production Stop registries remain empty.
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {ServiceStopHost} from '../host/service-stop.mjs';
import {NotebookArchiveHost} from '../host/notebook-archive.mjs';
import {serviceStopFixture,identity,defer} from './fixtures/service-stop.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
for(const first of ['stop','notebook'])test(`late ${first} acknowledgement preserves unknown and actual reciprocal peer ownership`,async()=>{
 const f=serviceStopFixture(),old=defer(),entered=defer(),next=defer(),nextEntered=defer();
 const stop=new ServiceStopHost({observer:f.observer,io:f.io,budgetMs:first==='stop'?5:13000,admitProfile:()=> 'ordinary-manual'}),book=new NotebookArchiveHost({observer:f.observer,io:f.io,budgetMs:first==='notebook'?5:13000});
 stop.beforeIO=()=>book.invalidate();book.beforeIO=()=>stop.invalidate();
 const q=(action,rest={})=>({action,...identity,invocation:randomUUID(),...rest});
 let record,pending;
 try{
  if(first==='stop'){
   record=(await stop.request({action:'begin',...identity})).service_stop;
   assert.equal(record.state,'ready');f.stop.onRun=async q=>{if(q.selector==='stop'){entered.resolve();await old.promise;}};
   const work=stop.request(q('confirm',{reference:record.reference}));await entered.promise;assert.equal((await work).service_stop.state,'unknown');
   f.notebookState.onRaw=async r=>{nextEntered.resolve();await next.promise;return r;};pending=book.request(q('inspect',{path:'/synthetic/notebook'}));
  }else{
   record=(await book.request(q('prepare-export',{path:'/synthetic/notebook'}))).notebook_archive;
   f.notebookState.onRaw=async r=>{entered.resolve();await old.promise;return r;};
   const work=book.request(q('confirm-export',{reference:record.reference}));await entered.promise;assert.equal((await work).notebook_archive.state,'unknown');
   f.stop.onRun=async()=>{nextEntered.resolve();await next.promise;};pending=stop.request({action:'begin',...identity});
  }
  await nextEntered.promise;assert.equal(f.io.acquire('probe','late','read'),null);old.resolve();await turn();assert.equal(f.io.acquire('probe','late','read'),null,'late original cannot release actual reciprocal peer');
  if(first==='stop')assert.equal((await stop.request({action:'retained'})).service_stop.retained[0].outcome,'unknown');
  else assert.equal((await book.request({action:'retained'})).notebook_archive.retained[0].original_outcome,'unknown');
  next.resolve();await pending;const token=f.io.acquire('probe','finished','read');assert.ok(token);f.io.release(token);
 }finally{old.resolve();next.resolve();await pending;stop.invalidate();book.invalidate();}
});
