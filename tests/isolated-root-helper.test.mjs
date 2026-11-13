import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {startHelper} from '../host/browser-helper.mjs';
import {IsolatedRootHost} from '../host/isolated-root.mjs';
import {setup,id,identity,view} from './fixtures/isolated-root.mjs';

async function open(t,s){
 const root=await mkdtemp(path.join(os.tmpdir(),'manager-isolated-root-'));
 await writeFile(path.join(root,'index.html'),'<main>fixture</main>');t.after(()=>rm(root,{recursive:true,force:true}));
 const helper=await startHelper({root,observer:s.observer,isolatedRootStore:s.store,driveAuth:{dispose(){}}});t.after(()=>helper.close());
 const page=await fetch(helper.origin+'/preview/');
 const headers={Origin:helper.origin,Cookie:page.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
 const send=(q,route='/manager-isolated-root',override=headers)=>fetch(helper.origin+route,{method:'POST',headers:override,
  body:typeof q==='string'||Buffer.isBuffer(q)?q:JSON.stringify(q)});
 let wait=3000;
 const request=(action,reference)=>({action,...identity(s.observer.lastObservation),wait_id:id(++wait),...(reference?{reference}:{})});
 return {...helper,headers,send,request,result:async q=>{const r=await send(q);assert.equal(r.status,200);return view(await r.json());}};
}

test('actual isolated-root HTTP route keeps origin/session/shape/size guards and reduced authority',async t=>{
 const s=setup(),h=await open(t,s);
 for(const headers of [{},{...h.headers,Origin:'https://invalid.example'},{...h.headers,Cookie:'other'}])
  assert.equal((await h.send({action:'retained'},undefined,headers)).status,403);
 for(const body of [null,{action:'retained',path:'/private'},'{"action":"retained","action":"retained"}',Buffer.from([255]),
  {...h.request('begin'),input_base64:'eA=='},{...h.request('begin'),wait_id:'invalid'}])assert.equal((await h.send(body)).status,400);
 assert.equal((await h.send('x'.repeat(513))).status,413);
 assert.equal((await h.send({action:'retained'},'/manager-isolated-root?mode=prepare')).status,403);assert.equal(s.calls.length,0);
 const ready=await h.result(h.request('begin'));assert.equal(ready.state,'ready');
 const prepared=await h.result(h.request('prepare',ready.reference));assert.equal(prepared.state,'verified');assert.equal(s.calls.length,2);
 for(const field of ['actor','sha256','operation','expected','token','binding_sha256','input_base64','root_id'])
  assert.equal(JSON.stringify([ready,prepared]).includes('"'+field+'"'),false);
 const original=IsolatedRootHost.prototype.request;
 IsolatedRootHost.prototype.request=async function(q){const result=await original.call(this,q);if(q.action==='retry')this.invalidate();return result;};
 t.after(()=>{IsolatedRootHost.prototype.request=original;});
 assert.equal((await h.send(h.request('retry',ready.reference))).status,503);
});

test('actual helper restart recovers the original and replays only on explicit retry',async t=>{
 const s=setup({reject:true}),first=await open(t,s),ready=await first.result(first.request('begin'));
 assert.equal((await first.result(first.request('prepare',ready.reference))).state,'unknown');const bytes=s.calls.at(-1).input_base64;
 await first.close();const next=await open(t,s),count=s.calls.length;
 const recovered=await next.result({action:'retained'});assert.equal(recovered.retained[0].reference,ready.reference);assert.equal(s.calls.length,count);
 s.options.reject=false;assert.equal((await next.result(next.request('retry',ready.reference))).state,'verified');assert.equal(s.calls.at(-1).input_base64,bytes);
});

test('actual helper navigation invalidates a pending original without losing its retained recovery',async t=>{
 const s=setup({delay:true}),h=await open(t,s),ready=await h.result(h.request('begin'));
 const pending=h.result(h.request('prepare',ready.reference));
 for(let i=0;i<100&&!s.release;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(typeof s.release,'function');
 await new Promise((resolve,reject)=>{const request=httpRequest(h.origin+'/preview/',{headers:{'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}},response=>{
  response.resume();response.on('end',resolve);
 });request.on('error',reject);request.end();});
 s.release();const stale=await pending;assert.equal(stale.state,'invalidated');assert.equal(stale.report,null);
 assert.equal((await h.result({action:'retained'})).retained[0].state,'unknown');
});
