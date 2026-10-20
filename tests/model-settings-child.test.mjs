import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WiredObserver } from '../host/observer.mjs';
import { ModelSettingsHost } from '../host/model-settings.mjs';
import { tablet,identity } from './fixtures/model-settings.mjs';
test('actual bounded child keeps exact private stdin, caps and identity refusal; timed apply retains original',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'manager-model-child-'));t.after(()=>rm(folder,{recursive:true,force:true}));const record=path.join(folder,'requests.jsonl'),script=path.join(folder,'model_settings_transport.py');
 const corpus=JSON.parse(await readFile(new URL('./fixtures/model-settings-c785afe-corpus.json',import.meta.url))),row=name=>corpus.records.find(x=>x.name===name),prepare=JSON.parse(Buffer.from(row('prepare-two-fields').stdin_base64,'base64'));
 const reports={inspect:row('inspect-original').stdout_utf8,prepare:row('prepare-two-fields').stdout_utf8,apply:row('apply-verified').stdout_utf8};
 async function fixture(mode){
  await writeFile(script,`const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{const q=JSON.parse(body);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(q)+'\\n');const mode=${JSON.stringify(mode)};if(mode==='timeout'&&q.selector==='apply'){setInterval(()=>{},1000);return;}if(mode==='exit'){process.stderr.write('PRIVATE_CHILD_CANARY');process.stdout.write('PRIVATE_CHILD_CANARY');process.exitCode=3;return;}const sample=${JSON.stringify(tablet)};if(mode==='identity')sample.boot_id='99999999-9999-4999-8999-999999999999';const reports=${JSON.stringify(reports)};const value={contract_version:1,status:'observed',observation:sample,model_raw:{status:'reported',stdout_base64:Buffer.from(reports[q.selector]).toString('base64')}};let output=JSON.stringify(value);if(mode==='exact'||mode==='over')output+=' '.repeat((mode==='exact'?24576:24577)-Buffer.byteLength(output));process.stdout.write(output);});`);
  const observer=new WiredObserver({config:path.join(folder,'synthetic-config'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:mode==='timeout'?2000:13000});observer.lastObservation=structuredClone(tablet);return {observer,model:new ModelSettingsHost({observer,uuid:()=>prepare.operation})};
 }
 for(const mode of ['exact','over','identity','exit']){const f=await fixture(mode),v=await f.model.request({action:'begin',...identity});assert.equal(v.model_settings.state,mode==='exact'?'ready':'unavailable',mode);assert.equal(JSON.stringify(v).includes('PRIVATE_CHILD_CANARY'),false);}
 await writeFile(record,'');const f=await fixture('timeout'),begun=await f.model.request({action:'begin',...identity}),reference=begun.model_settings.reference;const result=await f.model.request({action:'save',...identity,reference,changes:prepare.changes});assert.equal(result.model_settings.state,'unknown');assert.equal(result.model_settings.retained[0].reference,reference);
 const requests=(await readFile(record,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.deepEqual(requests.map(q=>q.selector),['inspect','prepare','apply']);assert.equal(requests[0].input_base64,null);assert.deepEqual(JSON.parse(Buffer.from(requests[2].input_base64,'base64')).intent,JSON.parse(row('prepare-two-fields').stdout_utf8).data.intent);
});
test('private child supervision inherits the remaining budget and refuses invalid budgets before launch',{timeout:5000},async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'manager-model-budget-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const record=path.join(folder,'launched'),script=path.join(folder,'model_settings_transport.py');
 await writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(record)},'launched');process.stdin.resume();setInterval(()=>{},1000);`);
 const observer=new WiredObserver({config:path.join(folder,'synthetic-config'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:13000});
 const request={selector:'inspect',input_base64:null,...identity};
 for(const budget_ms of [0,true,12001])assert.equal((await observer.run('model-settings',{...request,budget_ms})).status,'observation-unavailable');
 await assert.rejects(readFile(record),{code:'ENOENT'});
 const value=await observer.run('model-settings',{...request,budget_ms:500});assert.equal(value.model_raw.status,'unavailable');assert.equal(value.model_raw.stdout_base64,null);assert.equal(await readFile(record,'utf8'),'launched');
});
