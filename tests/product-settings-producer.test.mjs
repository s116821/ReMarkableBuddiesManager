import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseProductRawFrame,parseProductSettingsReport} from '../host/product-settings-protocol.mjs';
import {ProductSettingsController} from '../src/product-settings.ts';
import {productFixture,tablet} from './fixtures/product-settings.mjs';
const bytes=await readFile(new URL('./fixtures/product-settings-producer-060d012.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'1b46e345fa493c2d2dac516cf63a050aa995157ecb001d9e650a095329cd8ae8');
// Public wrapper omits only fixture_root from the original cf691e07 capture.
// All16 captured record objects (15 product frames + separate bootstrap),
// exact raw frame strings and synthetic private request bytes are unchanged.
const capture=JSON.parse(bytes);assert.equal('fixture_root'in capture,false);const rows=capture.records.filter(x=>x.argv[0]==='--product-settings-operation');
assert.equal(capture.source_head,'060d012ab60438d8bec933ff296afb3ff5fa05d8');assert.equal(capture.source_clean,true);assert.equal(rows.length,15);
const inspections=new Map(),prepared=new Map();
for(const row of rows){const r=parseProductRawFrame(Buffer.from(row.raw_utf8));if(r.operation==='inspect'&&r.status==='ok')inspections.set(r.data.base_sha256,r.data.current);if(r.operation==='prepare'&&r.outcome==='prepared')prepared.set(r.data.intent.target_sha256,r.data);}
for(const row of rows)test('actual060d012 CLI captured frame '+row.name,()=>{
 assert.equal(row.exit_code,0);assert.equal(row.stderr_utf8,'');const operation=row.argv[1],r=parseProductRawFrame(Buffer.from(row.raw_utf8));let context={};
 if(r.status==='ok'&&operation==='prepare'){const request=JSON.parse(row.request_utf8);assert.ok(inspections.has(request.base_sha256));context={...request,current:inspections.get(request.base_sha256)};}
 if(r.status==='ok'&&['apply','status'].includes(operation)){const request=JSON.parse(row.request_utf8);assert.ok(prepared.has(request.intent.target_sha256));context={intent:request.intent,after:prepared.get(request.intent.target_sha256).after};}
 const p=parseProductSettingsReport(r,operation,context);assert.equal(p.report.outcome,r.outcome);for(const key of ['sha256','intent','C:\\'])assert.equal(JSON.stringify(p.report).includes(key),false);
});
test('bootstrap is separately attributed legacy refusal, not a16th product frame or device execution',()=>{
 const other=capture.records.filter(x=>x.argv[0]!=='--product-settings-operation');assert.equal(other.length,1);assert.equal(other[0].name,'local-store-bootstrap');assert.deepEqual(other[0].argv,['--writer-note']);assert.equal(capture.bootstrap_is_local_missing_draft_refusal,true);assert.equal(capture.binary_version,'remarkable-reader-buddy dev.unknown');assert.match(capture.platform,/Windows host CLI/);
});
test('actual original and multi-field captured reports cross private host/shared controller with exact original intent',async()=>{
 for(const names of [['inspect-defaults','prepare-reader-false','apply-verified'],['inspect-reader-disabled','prepare-multifield','apply-multifield']]){
  const specimens=Object.fromEntries(names.map(name=>{const row=rows.find(x=>x.name===name);return [row.argv[1],row];})),input=JSON.parse(specimens.prepare.request_utf8),f=productFixture({uuid:()=>input.operation}),packets=[];
  f.observer.run=async(action,q)=>{assert.equal(action,'product-settings');packets.push(q);return {contract_version:1,status:'observed',observation:structuredClone(tablet),product_settings_raw:{status:'reported',stdout_base64:Buffer.from(specimens[q.selector].raw_utf8).toString('base64')}};};
  const controller=new ProductSettingsController(()=>{}),adapter={productSettings:q=>f.product.request(q)};await controller.begin(adapter,tablet,async()=>true);
  for(const [key,change]of Object.entries(input.changes))controller.edit(key,change.action==='clear'?'':String(change.value));await controller.save(adapter,tablet);
  assert.equal(controller.state.view.state,'verified');assert.deepEqual(controller.state.view.current,JSON.parse(specimens.apply.raw_utf8).data.current);assert.deepEqual(packets.map(x=>x.selector),['inspect','prepare','apply']);assert.deepEqual(JSON.parse(Buffer.from(packets[2].input_base64,'base64')),JSON.parse(specimens.apply.request_utf8));
  const publicText=JSON.stringify(controller.state);for(const privateField of ['base_sha256','target_sha256','config_path_sha256','intent','C:\\Users'])assert.equal(publicText.includes(privateField),false);controller.clear();
 }
});
