import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WiredObserver } from '../host/observer.mjs';
import { MemoryForgetHost } from '../host/memory-forget.mjs';
import { tablet,prepared,ack,operation,reference,prepareRequest } from './fixtures/memory-forget.mjs';

// Actual Node child supervision/coordinator, with a synthetic executable replacing
// only the Python/SSH transport. No device, account or remote process is contacted.
test('actual bounded child preserves original input and possible-dispatch uncertainty across framing/exit/cancel faults',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'manager-forget-child-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=path.join(root,'synthetic-config');const report=await prepared();
 const expected={
  'prepare-forget':JSON.stringify({prepared_version:1,operation,key:report.data.intent.key}),
  forget:JSON.stringify({intent:report.data.intent}),
  'forget-receipt':JSON.stringify({intent:report.data.intent}),
 };
 const script=`const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{
  if(process.argv.length!==2||!process.argv[1].endsWith('memory_forget_transport.py'))throw Error('argv');
  const q=JSON.parse(raw),inputs=${JSON.stringify(expected)};
  if(Object.keys(q).sort().join()!=='boot_id,connection_id,input_base64,selector'||q.connection_id!==${JSON.stringify(tablet.connection_id)}||q.boot_id!==${JSON.stringify(tablet.boot_id)}||Buffer.from(q.input_base64,'base64').toString()!==inputs[q.selector])throw Error('input');
  const mode=fs.readFileSync(process.env.MANAGER_WIRED_CONFIG,'utf8');
  if(mode==='wait'){setTimeout(()=>{},30000);return;}
  if(mode==='oversize'){process.stdout.write('x'.repeat(360449));return;}
  if(mode==='utf8'){process.stdout.write(Buffer.from([255]));return;}
  if(mode==='exit'){process.stderr.write('PRIVATE_DIAGNOSTIC_CANARY');process.exit(1);}
  const report=q.selector==='prepare-forget'?${JSON.stringify(report)}:${JSON.stringify(ack())};
  report.operation=q.selector;
  if(mode==='wrong-operation')report.data.operation=${JSON.stringify(tablet.boot_id)};
  let bytes=Buffer.from(JSON.stringify(report)+'\\n');
  if(mode==='raw-bound')bytes=Buffer.from(JSON.stringify(report)+' '.repeat(262144-bytes.length)+'\\n');
  if(mode==='raw-oversize')bytes=Buffer.from('x'.repeat(262145));
  if(mode==='raw-partial')bytes=bytes.subarray(0,bytes.length-1);
  if(mode==='raw-utf8')bytes=Buffer.from([255,10]);
  const v={contract_version:1,status:'observed',observation:${JSON.stringify(tablet)},forget_raw:{status:'reported',stdout_base64:bytes.toString('base64')}};
  if(mode==='foreign')v.observation.boot_id=${JSON.stringify(operation)};
  if(mode==='unsupported')v.forget_raw={status:'unsupported',stdout_base64:null};
  if(mode==='bad-base64')v.forget_raw.stdout_base64='!!!!';
  let text=JSON.stringify(v);
  if(mode==='partial')text=text.slice(0,-1);
  if(mode==='private-bound')text+=' '.repeat(360448-text.length);
  process.stdout.write(text);
 });`;
 await writeFile(path.join(root,'memory_forget_transport.py'),script);
 const observer=new WiredObserver({config,python:process.execPath,script:path.join(root,'wired_observer.py')});observer.lastObservation=tablet;
 const open=()=>new MemoryForgetHost({observer,reference:()=>reference,uuid:()=>operation});
 for(const mode of ['normal','private-bound','raw-bound']){
  await writeFile(config,mode);const host=open();assert.equal((await host.request(prepareRequest())).forget.state,'prepared',mode);
  assert.equal((await host.request({action:'confirm',reference})).forget.state,'acknowledged',mode);
 }
 for(const mode of ['oversize','utf8','exit','partial','foreign','wrong-operation','raw-oversize','raw-partial','raw-utf8','unsupported','bad-base64','wait']){
  await writeFile(config,'normal');observer.timeoutMs=13000;const host=open();assert.equal((await host.request(prepareRequest())).forget.state,'prepared');
  await writeFile(config,mode);if(mode==='wait')observer.timeoutMs=200;
  const v=await host.request({action:'confirm',reference});assert.equal(v.forget.state,'unknown',mode);assert.equal(v.forget.preview,null);assert.equal(v.forget.report,null);assert.equal(JSON.stringify(v).includes('PRIVATE_'),false);
  await writeFile(config,'normal');observer.timeoutMs=13000;
  assert.equal((await host.request({action:'confirm',reference})).forget.state,'unavailable');
  assert.equal((await host.request({action:'receipt',reference})).forget.state,'acknowledged');
 }
 await writeFile(config,'normal');const host=open();await host.request(prepareRequest());await writeFile(config,'wait');
 const pending=host.request({action:'confirm',reference});host.wrap().cancel();assert.equal((await pending).forget.state,'unknown');
 assert.equal((await host.request({action:'status'})).forget.state,'unknown');
});
