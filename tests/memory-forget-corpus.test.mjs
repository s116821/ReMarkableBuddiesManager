import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MemoryForgetHost } from '../host/memory-forget.mjs';
import { parseForgetReport,parseForgetRequest,parseForgetResult,canonicalEnvelope,sha256 } from '../host/memory-forget-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { MemoryForgetController } from '../src/memory-forget.ts';
import { tablet,reference } from './fixtures/memory-forget.mjs';
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const bytes=await readFile(new URL('./fixtures/prepared-forget-77e92306-corpus.json',import.meta.url));
const corpus=JSON.parse(bytes),manifest=JSON.parse(corpus.manifest_utf8);
const pairs=new Map(corpus.pairs.map(p=>[p.name,p]));
const rawReply=name=>({contract_version:1,status:'observed',observation:structuredClone(tablet),forget_raw:{status:'reported',stdout_base64:Buffer.from(pairs.get(name).stdout_utf8,'utf8').toString('base64')}});

test('all39 corrected actual producer pairs verify all78 original hashes, exact phase rows and nine Unicode previews',async()=>{
 assert.equal(digest(bytes),'c80dabef103ab0e6844abf5a3228c6e702a52bcfb92654b338a0db524fdf016b');
 assert.equal(digest(Buffer.from(corpus.manifest_utf8,'utf8')),corpus.manifest_sha256);
 assert.equal(corpus.manifest_sha256,'da10879b89803761e5a1fc693bc21f2b4aa1d81145aa20fbe75a3fddfc40269e');
 assert.equal(manifest.source_commit,'77e92306091d3d0bf10cd8443d9327198a8105b4');assert.equal(manifest.binary_sha256,null);assert.match(manifest.binary_digest_note,/not retained at capture time/);
 assert.equal(pairs.size,39);assert.equal(manifest.reports.length,39);let previews=0;
 for(const row of manifest.reports){
  const pair=pairs.get(row.name);assert.ok(pair);
  for(const field of ['request','stdout'])assert.equal(digest(Buffer.from(pair[field+'_utf8'],'utf8')),row[field+'_sha256'],row.name+' '+field);
  const input=JSON.parse(pair.request_utf8),raw=JSON.parse(pair.stdout_utf8);
  assert.equal(raw.operation,row.operation);assert.equal(raw.status,row.status);assert.equal(raw.incomplete,row.incomplete);assert.equal(raw.data?.outcome??null,row.outcome);
  const context={operation:input.intent?.operation??input.operation,key:input.key??input.intent?.key,...tablet};
  const result=await parseForgetReport(raw,row.operation,context);
  assert.equal(result.report.status,row.status);assert.equal(result.report.incomplete,row.incomplete);assert.equal(result.report.outcome,row.outcome);
  if(result.preview){
   previews++;assert.match(pair.stdout_utf8,/[αβ]/u);assert.deepEqual(result.preview.head.fact,raw.data.preview.payload);
   assert.equal(await sha256(canonicalEnvelope(raw.data.preview)),raw.data.intent.expected[0].sha256);
   const projected={contract_version:1,status:'observed',observation:tablet,forget:{state:'prepared',reference,preview:result.preview,acknowledgement:null,report:result.report}};
   await parseForgetResult(projected,validateResult);const text=JSON.stringify(projected);for(const privateField of ['config_sha256','store_generation','accepted_base_sha256','selection_sha256','pins'])assert.equal(text.includes(privateField),false);
  }
  if(row.name==='invalid-prepare')assert.throws(()=>parseForgetRequest({action:'prepare',connection_id:tablet.connection_id,boot_id:tablet.boot_id,key:input.key}));
 }
 assert.equal(previews,9);
 // Exact replay and later receipts identify the same original transaction, not current deletion.
 for(const domain of ['local','selected']){
  const original=JSON.parse(pairs.get(domain+'-confirm').stdout_utf8).data;
  assert.deepEqual(JSON.parse(pairs.get(domain+'-exact-replay').stdout_utf8).data,original);
  assert.deepEqual(JSON.parse(pairs.get(domain+'-later-receipt').stdout_utf8).data,original);
 }
});

test('actual local/selected reports cross coordinator/controller with original immutable bytes and receipt-only recovery',async()=>{
 for(const domain of ['local','selected']){
  const input=JSON.parse(pairs.get(domain+'-prepare').request_utf8),prepared=JSON.parse(pairs.get(domain+'-prepare').stdout_utf8);const calls=[];let receipt=domain+'-receipt-absent';
  const observer={lastObservation:structuredClone(tablet),cancel(){},async run(action,q){
   assert.equal(action,'memory-forget');const bytes=Buffer.from(q.input_base64,'base64');calls.push({selector:q.selector,bytes});
   if(q.selector==='prepare-forget'){assert.deepEqual(JSON.parse(bytes),input);return rawReply(domain+'-prepare');}
   assert.deepEqual(JSON.parse(bytes),{intent:prepared.data.intent});
   if(q.selector==='forget')throw Error('Synthetic lost reply after possible dispatch');
   assert.equal(q.selector,'forget-receipt');return rawReply(receipt);
  }};
  const host=new MemoryForgetHost({observer,reference:()=>reference,uuid:()=>input.operation}),c=new MemoryForgetController(()=>{}),adapter={memoryForget:q=>host.request(q)};
  await c.run(adapter,{action:'prepare',connection_id:tablet.connection_id,boot_id:tablet.boot_id,key:input.key});assert.equal(c.state.view.state,'prepared');
  await c.run(adapter,{action:'confirm',reference});assert.equal(c.state.uncertain,true);assert.equal(c.state.view.preview,null);
  host.invalidate();c.clear();await c.run(adapter,{action:'status'});assert.equal(c.state.uncertain,true);
  await c.run(adapter,{action:'receipt',reference});assert.equal(c.state.view.state,'unresolved');assert.equal(c.state.uncertain,true);
  receipt=domain+'-later-receipt';await c.run(adapter,{action:'receipt',reference});assert.equal(c.state.view.state,'acknowledged');assert.equal(c.state.uncertain,false);assert.match(c.state.status,/historically.*current data is unverified/);
  assert.equal(calls.filter(c=>c.selector==='forget').length,1);assert.equal(calls.filter(c=>c.selector==='forget-receipt').length,2);
  assert.deepEqual(calls[1].bytes,calls[2].bytes);assert.deepEqual(calls[1].bytes,calls[3].bytes);
 }
});
