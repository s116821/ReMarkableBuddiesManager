import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductSettingsController,productRows} from '../src/product-settings.ts';
import {productFixture,tablet,defer} from './fixtures/product-settings.mjs';
const open=()=>{const f=productFixture();let wipes=0;return {...f,controller:new ProductSettingsController(()=>{},()=>wipes++),adapter:{productSettings:q=>f.product.request(q)},wipes:()=>wipes};};
test('default true/Mem are visible defaults; explicit default is a dirty declaration, Clear restores default',async()=>{
 const f=open();await f.controller.begin(f.adapter,tablet,async()=>true);assert.deepEqual(f.controller.state.draft,{export_destination:'',reader_enabled:'',writer_enabled:''});assert.equal(productRows(f.controller.state.view.current,f.controller.state.draft).length,3);
 f.controller.edit('reader_enabled','true');assert.deepEqual(f.controller.state.changes,{reader_enabled:{action:'set',value:true}});await f.controller.save(f.adapter,tablet);assert.equal(f.controller.state.view.state,'verified');assert.equal(f.controller.state.view.current.reader_enabled.origin,'declared');
 await f.controller.begin(f.adapter,tablet,async()=>true);f.controller.edit('reader_enabled','');assert.deepEqual(f.controller.state.changes,{reader_enabled:{action:'clear'}});await f.controller.save(f.adapter,tablet);assert.equal(f.controller.state.view.current.reader_enabled.value,true);assert.equal(f.controller.state.view.current.reader_enabled.origin,'default');f.controller.clear();
});
test('Save clears drafts and DOM synchronously, lost apply retains original; status never auto-retries',async()=>{
 const f=open();await f.controller.begin(f.adapter,tablet,async()=>true);f.controller.edit('export_destination','disabled');const gate=defer();f.state.onPrepare=async r=>{await gate.promise;return r;};f.state.onApply=()=>{throw Error('lost');};const before=f.wipes(),pending=f.controller.save(f.adapter,tablet);
 assert.deepEqual(f.controller.state.draft,{export_destination:'',reader_enabled:'',writer_enabled:''});assert.deepEqual(f.controller.state.changes,{});assert.equal(f.controller.state.view,null);assert.equal(f.wipes(),before+1);gate.resolve();await pending;
 assert.equal(f.controller.state.uncertain,true);const original=f.controller.state.retained[0];assert.ok(original);assert.equal(f.calls.filter(x=>x.selector==='status').length,0);f.controller.clear();await f.controller.status(f.adapter,original,tablet);assert.equal(f.controller.state.view.state,'desired-file-observed');assert.equal(f.controller.state.retained.length,0);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);f.controller.clear();
});
test('queued pause and late replies cannot resurrect a cleared or stopped editor',async()=>{
 const f=open(),gate=defer();const pending=f.controller.begin(f.adapter,tablet,()=>gate.promise);f.controller.clear();gate.resolve(true);await pending;assert.equal(f.calls.length,0);
 await f.controller.begin(f.adapter,tablet,async()=>true);const original=f.controller.state.reference;f.controller.edit('writer_enabled','false');await f.controller.stop(f.adapter,async()=>{});assert.equal(f.controller.state.view,null);assert.deepEqual(f.controller.state.draft,{export_destination:'',reader_enabled:'',writer_enabled:''});const before=f.calls.length;await f.product.request({action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference:original,changes:{writer_enabled:{action:'set',value:false}}});assert.equal(f.calls.length,before);f.controller.clear();
});
test('failed status quiescence settles safely without remote dispatch',async()=>{
 const f=open();await f.controller.begin(f.adapter,tablet,async()=>true);f.controller.edit('writer_enabled','false');f.state.onApply=()=>{throw Error('lost');};await f.controller.save(f.adapter,tablet);const original=f.controller.state.retained[0],calls=f.calls.length;await f.controller.status(f.adapter,original,tablet,async()=>false);assert.equal(f.controller.state.busy,false);assert.equal(f.controller.state.uncertain,true);assert.equal(f.calls.length,calls);assert.equal(f.controller.state.retained[0].reference,original.reference);f.controller.clear();
});
