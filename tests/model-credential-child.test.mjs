import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WiredObserver } from '../host/observer.mjs';
import { ModelCredentialHost } from '../host/model-credential.mjs';
import { tablet,identity,modelCredentialFixture,secret } from './fixtures/model-credential.mjs';
test('actual bounded child keeps exact private stdin, caps and identity refusal; timed apply retains original',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'manager-memory-child-'));t.after(()=>rm(folder,{recursive:true,force:true}));const record=path.join(folder,'requests.jsonl'),script=path.join(folder,'model_credential_transport.py');
 // These reports are separately synthetic POSIX surroundings, never rewritten historical streams.
 const synthetic=modelCredentialFixture(),decode=v=>Buffer.from(v.model_credential_raw.stdout_base64,'base64').toString(),observed=decode(await synthetic.observer.run('model-credential',{selector:'inspect',input_base64:null,...identity})),base=JSON.parse(observed).data;
 const prepare={credential_version:1,operation:'77777777-7777-4777-8777-777777777777',base:base.binding,change:{action:'install',value:secret}};
 const prepared=decode(await synthetic.observer.run('model-credential',{selector:'prepare',input_base64:Buffer.from(JSON.stringify(prepare)).toString('base64'),...identity})),intent=JSON.parse(prepared).data.intent;
 const applied=decode(await synthetic.observer.run('model-credential',{selector:'apply',input_base64:Buffer.from(JSON.stringify({intent,change:prepare.change})).toString('base64'),...identity}));
 const reports={inspect:observed,prepare:prepared,apply:applied};
 async function fixture(mode){
  await writeFile(script,`const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{const q=JSON.parse(body);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(q)+'\\n');const mode=${JSON.stringify(mode)};if(mode==='timeout'&&q.selector==='apply'){setInterval(()=>{},1000);return;}if(mode==='exit'){process.stderr.write('PRIVATE_CHILD_CANARY');process.stdout.write('PRIVATE_CHILD_CANARY');process.exitCode=3;return;}const sample=${JSON.stringify(tablet)};if(mode==='identity')sample.boot_id='99999999-9999-4999-8999-999999999999';const reports=${JSON.stringify(reports)};const value={contract_version:1,status:'observed',observation:sample,model_credential_raw:{status:'reported',stdout_base64:Buffer.from(reports[q.selector]).toString('base64')}};let output=JSON.stringify(value);if(mode==='duplicate')output=output.replace('\"contract_version\":1','\"contract_version\":1,\"contract_version\":1');if(mode==='exact'||mode==='over')output+=' '.repeat((mode==='exact'?24576:24577)-Buffer.byteLength(output));process.stdout.write(output);});`);
  const observer=new WiredObserver({config:path.join(folder,'synthetic-config'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:mode==='timeout'?2000:13000});observer.lastObservation=structuredClone(tablet);return {observer,credential:new ModelCredentialHost({observer,uuid:()=>prepare.operation})};
 }
 for(const mode of ['exact','over','identity','exit','duplicate']){const f=await fixture(mode),v=await f.credential.request({action:'begin',...identity});assert.equal(v.model_credential.state,mode==='exact'?'ready':'unavailable',mode);assert.equal(JSON.stringify(v).includes('PRIVATE_CHILD_CANARY'),false);}
 await writeFile(record,'');const f=await fixture('timeout'),begun=await f.credential.request({action:'begin',...identity}),reference=begun.model_credential.reference;const result=await f.credential.request({action:'save',...identity,reference,change:prepare.change});assert.equal(result.model_credential.state,'unknown');assert.equal(result.model_credential.retained[0].reference,reference);
 const requests=(await readFile(record,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.deepEqual(requests.map(q=>q.selector),['inspect','prepare','apply']);assert.equal(requests[0].input_base64,null);assert.deepEqual(JSON.parse(Buffer.from(requests[2].input_base64,'base64')).intent,intent);
});
test('private child supervision inherits the remaining budget and refuses invalid budgets before launch',{timeout:5000},async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'manager-memory-budget-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const record=path.join(folder,'launched'),script=path.join(folder,'model_credential_transport.py');
 await writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(record)},'launched');process.stdin.resume();setInterval(()=>{},1000);`);
 const observer=new WiredObserver({config:path.join(folder,'synthetic-config'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:13000});
 const request={selector:'inspect',input_base64:null,...identity};
 for(const budget_ms of [0,true,12001])assert.equal((await observer.run('model-credential',{...request,budget_ms})).status,'observation-unavailable');
 await assert.rejects(readFile(record),{code:'ENOENT'});
 const value=await observer.run('model-credential',{...request,budget_ms:500});assert.equal(value.model_credential_raw.status,'unavailable');assert.equal(value.model_credential_raw.stdout_base64,null);assert.equal(await readFile(record,'utf8'),'launched');
});
