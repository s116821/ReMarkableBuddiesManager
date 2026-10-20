import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WiredObserver } from '../host/observer.mjs';
import { BasicSettingsHost } from '../host/basic-settings.mjs';
import { tablet,identity } from './fixtures/basic-settings.mjs';
test('actual bounded child keeps exact private stdin, caps and identity refusal; timed apply retains original',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'manager-basic-child-'));t.after(()=>rm(folder,{recursive:true,force:true}));const record=path.join(folder,'requests.jsonl'),script=path.join(folder,'basic_settings_transport.py');
 const corpus=JSON.parse(await readFile(new URL('./fixtures/basic-settings-87bc8d4-corpus.json',import.meta.url))),row=name=>corpus.cases.find(x=>x.name===name),prepare=JSON.parse(Buffer.from(row('prepare-three-fields').stdin_base64,'base64'));
 const reports={inspect:row('inspect-original').stdout_utf8,prepare:row('prepare-three-fields').stdout_utf8,apply:row('apply-verified').stdout_utf8};
 async function fixture(mode){
  await writeFile(script,`const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{const q=JSON.parse(body);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(q)+'\\n');const mode=${JSON.stringify(mode)};if(mode==='timeout'&&q.selector==='apply'){setInterval(()=>{},1000);return;}if(mode==='exit'){process.stderr.write('PRIVATE_CHILD_CANARY');process.stdout.write('PRIVATE_CHILD_CANARY');process.exitCode=3;return;}const sample=${JSON.stringify(tablet)};if(mode==='identity')sample.boot_id='99999999-9999-4999-8999-999999999999';const reports=${JSON.stringify(reports)};const value={contract_version:1,status:'observed',observation:sample,basic_raw:{status:'reported',stdout_base64:Buffer.from(reports[q.selector]).toString('base64')}};let output=JSON.stringify(value);if(mode==='exact'||mode==='over')output+=' '.repeat((mode==='exact'?24576:24577)-Buffer.byteLength(output));process.stdout.write(output);});`);
  const observer=new WiredObserver({config:path.join(folder,'synthetic-config'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:mode==='timeout'?2000:13000});observer.lastObservation=structuredClone(tablet);return {observer,basic:new BasicSettingsHost({observer,uuid:()=>prepare.operation})};
 }
 for(const mode of ['exact','over','identity','exit']){const f=await fixture(mode),v=await f.basic.request({action:'begin',...identity});assert.equal(v.basic_settings.state,mode==='exact'?'ready':'unavailable',mode);assert.equal(JSON.stringify(v).includes('PRIVATE_CHILD_CANARY'),false);}
 await writeFile(record,'');const f=await fixture('timeout'),begun=await f.basic.request({action:'begin',...identity}),reference=begun.basic_settings.reference;const result=await f.basic.request({action:'save',...identity,reference,changes:prepare.changes});assert.equal(result.basic_settings.state,'unknown');assert.equal(result.basic_settings.retained[0].reference,reference);
 const requests=(await readFile(record,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.deepEqual(requests.map(q=>q.selector),['inspect','prepare','apply']);assert.equal(requests[0].input_base64,null);assert.deepEqual(JSON.parse(Buffer.from(requests[2].input_base64,'base64')).intent,JSON.parse(row('prepare-three-fields').stdout_utf8).data.intent);
});
