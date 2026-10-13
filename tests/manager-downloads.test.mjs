import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManagerDownloads } from '../host/manager-downloads.mjs';
import { downloadState, parseDownloadState, parseDownloadRequest } from '../host/manager-download-protocol.mjs';
import { DownloadController } from '../src/manager-downloads.ts';
import { startHelper } from '../host/browser-helper.mjs';
const tag='v0.3.1',id='a'.repeat(64);
const pending=()=>({...downloadState('downloading'),tag,operation_id:id,folder:`manager-download-${id}`});
const receipt=()=>({ok:true,receipt:{state:'manager-bundles-quarantined',repository:'s116821/ReMarkableBuddiesManager',tag,sourceSha:'b'.repeat(40),checksumAgreement:true,embeddedIdentityVerified:true,updateEligible:false,apkInstallEligible:false,archivesExtracted:false,payloadSafetyVerified:false,signatureVerified:false,reuseRequiresReverification:true}});
test('strict download contract refuses authority and arbitrary host inputs',()=>{
 assert.equal(parseDownloadState(pending()).update_eligible,false);
 for(const q of [{action:'start',tag,path:'/arbitrary'},{action:'start',tag:'v1.0.0-preview'},{action:'start',tag:'v01.0.0'},{action:'cancel',operation_id:'bad'},{action:'status',python:'/arbitrary'}])assert.throws(()=>parseDownloadRequest(q));
 for(const extra of [{update_eligible:true},{source_sha:'b'.repeat(40)},{folder:'/private'},{private:'PRIVATE_SENTINEL'},{status:'complete'}])assert.throws(()=>parseDownloadState({...pending(),...extra}));
});
test('actual host admission, old cancellation identity and late committed receipt preserve ownership',async t=>{
 const parent=await realpath(await mkdtemp(path.join(tmpdir(),'download-lifecycle-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 let finish,calls=0;
 const host=new ManagerDownloads({parent,python:process.execPath,consumer:()=>{calls++;return new Promise(r=>finish=r);}});t.after(()=>host.dispose());
 const q={action:'start',tag};const start=host.request(q);await assert.rejects(host.request(q));const state=await start;
 assert.equal(calls,1);await host.request({action:'cancel',operation_id:id});assert.equal(host.active.controller.signal.aborted,false);
 const done=host.active.promise;await host.request({action:'cancel',operation_id:state.operation_id});assert.equal(host.state.status,'cancelling');
 finish(receipt());await done;assert.equal(parseDownloadState(host.state).status,'complete');
 const unavailable=new ManagerDownloads({parent:'/nonexistent',python:process.execPath,consumer:()=>{throw Error('Should not run');}});assert.equal((await unavailable.request(q)).status,'unconfigured');
});
test('host failure/private error sanitization and cancellation publish no verified success',async t=>{
 const parent=await realpath(await mkdtemp(path.join(tmpdir(),'download-refusal-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 const host=new ManagerDownloads({parent,python:process.execPath,consumer:async()=>{throw Error('PRIVATE_SENTINEL');}});await host.request({action:'start',tag});await host.active?.promise;assert.equal(host.state.status,'failed');assert.equal(JSON.stringify(host.state).includes('PRIVATE_SENTINEL'),false);
 let finish;const cancelled=new ManagerDownloads({parent,python:process.execPath,consumer:()=>new Promise(r=>finish=r)});const started=await cancelled.request({action:'start',tag});const done=cancelled.active.promise;await cancelled.request({action:'cancel',operation_id:started.operation_id});finish({ok:false,incompleteQuarantine:true});await done;assert.equal(parseDownloadState(cancelled.state).status,'cancelled');assert.equal(cancelled.state.incomplete,true);
});
test('shared controller suppresses malformed/changed and late disposed output',async()=>{
 const c=new DownloadController({request:async()=>pending()},()=>{});await c.request({action:'start',tag});assert.equal(c.state.tag,tag);c.dispose();
 const changed=new DownloadController({request:async()=>({...pending(),update_eligible:true})},()=>{});await changed.request({action:'status'});assert.equal(changed.unknown,true);assert.equal(changed.state.operation_id,null);changed.dispose();
 let finish;const late=new DownloadController({request:()=>new Promise(r=>finish=r)},()=>{throw Error('Late callback');});const p=late.request({action:'status'});late.dispose();finish(pending());await p;assert.equal(late.state.operation_id,null);
});
test('actual helper rejects origin/session/query/extra host fields before download dispatch',async t=>{
 let calls=0;const helper=await startHelper({root:path.resolve('dist/manager/browser'),observer:{cancel(){}},driveAuth:{dispose(){}},downloads:{request:async()=>{calls++;return downloadState('idle');},dispose(){}}});t.after(()=>helper.close());
 const initial=await fetch(helper.origin+'/preview/');const cookie=initial.headers.get('set-cookie').split(';')[0],headers={Origin:helper.origin,Cookie:cookie,'Content-Type':'application/json'};
 const send=(q,h=headers,url='/manager-download')=>fetch(helper.origin+url,{method:'POST',headers:h,body:JSON.stringify(q)});
 assert.equal((await send({action:'start',tag,path:'/private'})).status,400);assert.equal((await send({action:'status'},{...headers,Origin:'https://untrusted.invalid'})).status,403);assert.equal((await send({action:'status'},headers,'/manager-download?path=private')).status,403);assert.equal(calls,0);
 assert.equal((await send({action:'status'})).status,200);assert.equal(calls,1);
});

test('old completed identity cannot cancel a newly reserved setup attempt',async()=>{
 const host=new ManagerDownloads();host.state={...pending(),status:'complete',source_sha:'b'.repeat(40)};let ready;host.setup=()=>new Promise(r=>ready=r);
 const p=host.request({action:'start',tag});await host.request({action:'cancel',operation_id:id});assert.equal(host.active.controller.signal.aborted,false);host.dispose();ready();await p;assert.equal(host.active,null);
});

test('cancel during an in-flight status poll reaches the same operation, preserving a committed result',async t=>{
 for(const committed of [false,true]){
  let finish;const calls=[];
  const complete={...pending(),status:'complete',source_sha:'b'.repeat(40)};
  const c=new DownloadController({request:q=>{
   calls.push({...q});if(q.action==='start')return Promise.resolve(pending());
   if(q.action==='status')return new Promise(r=>finish=r);
   assert.equal(q.operation_id,id);return Promise.resolve(committed?complete:{...pending(),status:'cancelled',error:'cancelled'});
  }},()=>{});
  t.after(()=>c.dispose());await c.request({action:'start',tag});const poll=c.request({action:'status'});
  await c.request({action:'cancel',operation_id:'c'.repeat(64)});assert.equal(c.state.status,'downloading');
  await c.request({action:'cancel',operation_id:id});await c.request({action:'cancel',operation_id:'c'.repeat(64)});
  assert.deepEqual(calls.map(q=>q.action),['start','status']);assert.equal(c.state.status,'cancelling');
  finish(committed?complete:pending());await poll;
  assert.deepEqual(calls.map(q=>q.action),['start','status','cancel']);
  assert.equal(c.state.status,committed?'complete':'cancelled');assert.equal(c.state.operation_id,id);c.dispose();
 }
});
