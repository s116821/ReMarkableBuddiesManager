import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHelper } from '../host/browser-helper.mjs';
import { WiredObserver } from '../host/observer.mjs';
import { reduceSavedConfigurationResult } from '../host/saved-configuration.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { report,privateReply,request,tablet,defer } from './fixtures/saved-configuration.mjs';
import { prepared,ack,rawReply,prepareRequest } from './fixtures/memory-forget.mjs';
const reduced=()=>reduceSavedConfigurationResult(privateReply(report()),request(),validateResult);
const get=(url,headers)=>new Promise((resolve,reject)=>{const req=httpRequest(url,{headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
const nav={'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
async function open(t,observer){const root=await mkdtemp(path.join(os.tmpdir(),'manager-config-helper-'));await writeFile(path.join(root,'index.html'),'<main>fixture</main>');t.after(()=>rm(root,{recursive:true,force:true}));const h=await startHelper({root,observer,driveAuth:{dispose(){}}});t.after(()=>h.close());const initial=await fetch(h.origin+'/preview/');const headers={Origin:h.origin,Cookie:initial.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};return {...h,headers,send:(q,hdr=headers,extra='')=>fetch(h.origin+'/manager-saved-configuration'+extra,{method:'POST',headers:hdr,body:typeof q==='string'?q:Buffer.isBuffer(q)?q:JSON.stringify(q)})};}

test('actual helper auth/exact request/reduced response guards preserve private boundary',async t=>{
 let calls=0,raw=false;const observer={generation:0,cancel(){this.generation++;},async inspectSavedConfiguration(){calls++;return raw?privateReply(report()):reduced();}};const h=await open(t,observer);
 for(const hdr of [{...h.headers,Origin:'https://untrusted.invalid'},{...h.headers,Cookie:''},{...h.headers,'Content-Type':'text/plain'}])assert.equal((await h.send(request(),hdr)).status,403);
 assert.equal((await h.send(request(),h.headers,'?path=/bad')).status,403);
 for(const q of [' '+JSON.stringify(request()),'{"boot_id":0,"boot_id":1}',{...request(),path:'/bad'},Buffer.from([255])])assert.equal((await h.send(q)).status,400);
 assert.equal((await h.send('x'.repeat(257))).status,413);assert.equal(calls,0);
 const response=await h.send(request());assert.equal(response.status,200);const value=await response.json();assert.equal(value.saved_configuration.view.status,'ok');assert.equal(JSON.stringify(value).includes('config_sha256'),false);
 raw=true;assert.equal((await h.send(request())).status,503);
});

test('main-document metadata is required even at same pathname; resources and subframes preserve ready reference and pending read',async t=>{
 const pending=defer(),owned=defer();let waiting=false,configs=0;
 const observer=new WiredObserver();observer.lastObservation=tablet;
 observer.run=async function(action,q){this.cancel();if(action==='saved-configuration'){configs++;owned.resolve();return waiting?pending.promise:reduced();}return rawReply(q.selector==='prepare-forget'?await prepared(JSON.parse(Buffer.from(q.input_base64,'base64')).operation):ack(q.selector));};
 const h=await open(t,observer);
 const forget=q=>fetch(h.origin+'/manager-memory-forget',{method:'POST',headers:h.headers,body:JSON.stringify(q)}).then(r=>r.json());
 const preparedView=await forget(prepareRequest());assert.equal(preparedView.forget.state,'prepared');const generation=observer.generation;
 for(const headers of [{},{'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'},{'Sec-Fetch-Mode':'no-cors','Sec-Fetch-Dest':'image'},{'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe'}]){
  assert.equal(await get(h.origin+'/preview/',headers),200);assert.equal(observer.generation,generation);assert.equal((await forget({action:'status'})).forget.state,'prepared');
 }
 await get(h.origin+'/preview/',nav);assert.equal((await forget({action:'status'})).forget.state,'invalidated');assert.ok(observer.generation>generation);
 waiting=true;const read=h.send(request());await owned.promise;assert.equal(configs,1);const before=observer.generation;
 await get(h.origin+'/preview/',{'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe'});await get(h.origin+'/preview/',{'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'});assert.equal(observer.generation,before);
 pending.resolve(reduced());assert.equal((await read).status,200);
});

test('document navigation/same-ID refresh rejects pending host result, and bridge checks generation after await',async t=>{
 const pending=defer(),owned=defer();const observer=new WiredObserver();observer.lastObservation=tablet;
 observer.run=async function(){this.cancel();owned.resolve();return pending.promise;};const h=await open(t,observer);
 const read=h.send(request());await owned.promise;await get(h.origin+'/preview/',nav);pending.resolve(reduced());assert.equal((await read).status,503);
 // Exercise the final public bridge independently of the lower observer's guards.
 observer.inspectSavedConfiguration=async function(){queueMicrotask(()=>this.cancel());return reduced();};assert.equal((await h.send(request())).status,503);
});
