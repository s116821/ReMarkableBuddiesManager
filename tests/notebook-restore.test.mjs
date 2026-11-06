import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {OrdinaryRestoreHost} from '../host/ordinary-restore.mjs';
import {OrdinaryRestoreController} from '../src/ordinary-restore.ts';
import {parseRestoreRaw,parseNotebookRestoreRaw,parseNotebookRestoreIntent} from '../host/ordinary-restore-private.mjs';
import {parseRestoreResult,parseNotebookRestoreResult} from '../host/ordinary-restore-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {restoreFixture,restoreReport} from './fixtures/ordinary-restore.mjs';
import {notebookFixture,notebookReport,notebookIntent,notebookPreview,source,tablet,identity,defer} from './fixtures/notebook-restore.mjs';
const raw=r=>Buffer.from(JSON.stringify(r)+'\n');
const context={source,operation:notebookIntent.operation,intent:notebookIntent,preview:notebookPreview};
const prepared=()=>notebookReport('prepare-notebook',{restore_version:2,operation:context.operation,source});
const request=action=>({action,...identity,invocation:randomUUID(),source});

test('notebook private admission keeps explicit versions, selectors and actual v1 path domains',()=>{
 const r=prepared();assert.deepEqual(parseNotebookRestoreRaw(raw(r),'prepare',context).intent,notebookIntent);
 assert.throws(()=>parseRestoreRaw(raw(r),'prepare',context));
 for(const mutate of [v=>{v.report_version=1;},v=>{v.operation='prepare';},v=>{v.data.intent.restore_version=1;},v=>{v.data.intent.source_path_sha256=createHash('sha256').update('urn:remarkable-buddies:ordinary-restore-source-path:v2:'+source).digest('hex');}]){
  const v=structuredClone(r);mutate(v);assert.throws(()=>parseNotebookRestoreRaw(raw(v),'prepare',context));
 }
 assert.throws(()=>new OrdinaryRestoreHost({family:'auto'}));
});

test('notebook completeness is mandatory at every positive boundary; legacy incomplete target stays valid',()=>{
 for(const place of ['source','target','intent']){
  const r=prepared();if(place==='intent')r.data.intent.complete_media=false;else r.data.preview[place].complete_media=false;
  assert.throws(()=>parseNotebookRestoreRaw(raw(r),'prepare',context));
 }
 const r=prepared();r.data.preview.source.complete_media=false;r.data.preview.target.complete_media=false;r.data.intent.complete_media=false;
 assert.throws(()=>parseNotebookRestoreRaw(raw(r),'prepare',context));
 assert.throws(()=>parseNotebookRestoreIntent(r.data.intent,context));
 const legacy=restoreReport('prepare',{operation:context.operation,source},{apply:'restored',status:'unresolved'});
 assert.equal(parseRestoreRaw(raw(legacy),'prepare',context).preview.target.complete_media,false);
 for(const [selector,outcome,readback] of [['apply','restored',true],['status','desired-generation-observed',false]]){
  const v=notebookReport(selector+'-notebook',{intent:notebookIntent},{apply:outcome,status:outcome});
  assert.equal(parseNotebookRestoreRaw(raw(v),selector,context).report.disk_readback_verified,readback);
  v.disk_readback_verified=!readback;assert.throws(()=>parseNotebookRestoreRaw(raw(v),selector,context));v.disk_readback_verified=readback;
  v.data.inspection.complete_media=false;assert.throws(()=>parseNotebookRestoreRaw(raw(v),selector,context));
 }
});

test('notebook host binds original exact packet, never falls back, and preserves uncertain Apply history',async t=>{
 for(const original of ['unknown','not-activated']){
  const f=notebookFixture();t.after(()=>f.host.dispose());f.state.apply=original;
  const q=request('prepare'),ready=await f.host.request(q),ref=ready.ordinary_restore.reference;
  parseNotebookRestoreResult(ready,q,validateResult);assert.throws(()=>parseRestoreResult(ready,q,validateResult));
  assert.equal(f.calls[0].selector,'prepare-notebook');assert.equal(f.calls[0].body.restore_version,2);
  const result=await f.use('confirm',ref);assert.equal(result.ordinary_restore.apply_outcome,original);
  await f.use('confirm',ref);assert.equal(f.calls.filter(c=>c.selector==='apply-notebook').length,1);
  f.state.status='desired-generation-observed';const observed=await f.use('status',ref);
  assert.equal(observed.ordinary_restore.apply_outcome,original);assert.equal(observed.ordinary_restore.report.disk_readback_verified,false);
  assert.equal(f.calls.at(-1).input,f.calls[1].input);assert.deepEqual(f.calls[1].body.intent,{...notebookIntent,operation:f.calls[0].body.operation});
  assert.equal(observed.ordinary_restore.retained.length,0);assert.equal(JSON.stringify(observed).includes(source),false);
 }
});

test('public notebook DTO refuses complete-media and operation substitutions',async t=>{
 const f=notebookFixture();t.after(()=>f.host.dispose());const q=request('prepare'),v=await f.host.request(q);
 for(const change of [r=>{r.ordinary_restore.preview.source.complete_media=false;},r=>{r.ordinary_restore.preview.target.complete_media=false;},r=>{r.ordinary_restore.report.operation='prepare';}]){
  const bad=structuredClone(v);change(bad);assert.throws(()=>parseNotebookRestoreResult(bad,q,validateResult));
 }
});

test('notebook and legacy reference inventories are separate and share one I/O owner',async t=>{
 const legacy=restoreFixture(),f=notebookFixture({io:legacy.io});t.after(()=>{f.host.dispose();legacy.host.dispose();});
 const ready=await f.prepare(),ref=ready.ordinary_restore.reference;
 assert.equal((await legacy.use('confirm',ref)).ordinary_restore.state,'not-dispatched');assert.equal(legacy.calls.length,0);
 const token=legacy.io.acquire('ordinary-restore','other','prepare'),before=f.state.hooks;
 assert.equal((await f.use('confirm',ref)).ordinary_restore.state,'busy');assert.equal(f.state.hooks,before);assert.equal(f.calls.length,1);legacy.io.release(token);
 f.state.onRaw=r=>({...r,report_version:1,operation:'apply'});assert.equal((await f.use('confirm',ref)).ordinary_restore.state,'unknown');
 assert.deepEqual(f.calls.map(c=>c.selector),['prepare-notebook','apply-notebook']);
});

test('notebook custody expiry never renews and disposal fences late replies',async t=>{
 let now=0;const f=notebookFixture({now:()=>now});t.after(()=>f.host.dispose());const ref=(await f.prepare()).ordinary_restore.reference;
 await f.use('confirm',ref);now=1700000;await f.use('status',ref);now=1800001;
 assert.equal((await f.host.request({action:'retained'})).ordinary_restore.retained[0].status_available,false);
 const before=f.calls.length;await f.use('status',ref);assert.equal(f.calls.length,before);
 const active=notebookFixture(),entered=defer(),gate=defer();t.after(()=>active.host.dispose());
 active.state.onRaw=async r=>{entered.resolve();await gate.promise;return r;};const pending=active.prepare();await entered.promise;
 active.host.dispose();assert.equal(active.observer.cancels,1);gate.resolve();await assert.rejects(pending);
 await assert.rejects(active.host.request({action:'retained'}));
});

test('fixed notebook controller cannot invoke legacy capability and cancellation fences queued prepare',async t=>{
 const f=notebookFixture();t.after(()=>f.host.dispose());let legacyCalls=0;
 const c=new OrdinaryRestoreController(()=>{},()=>{},undefined,undefined,'notebook');t.after(()=>c.dispose());
 c.setDraft(source);await c.prepare({ordinaryRestore:()=>{legacyCalls++;throw Error('must not run');}},tablet,async()=>true);
 assert.equal(legacyCalls,0);assert.equal(f.calls.length,0);
 const adapter={notebookRestore:q=>f.host.request(q)},gate=defer();c.setDraft(source);const queued=c.prepare(adapter,tablet,()=>gate.promise);
 await c.stop(adapter);gate.resolve(true);await queued;assert.equal(f.calls.length,0);
 c.setDraft(source);await c.prepare(adapter,tablet,async()=>true);assert.equal(c.state.view.state,'ready');
 await c.confirm(adapter,tablet,async()=>true);assert.equal(c.state.view.state,'unknown');
 f.state.status='desired-generation-observed';await c.status(adapter,tablet,c.state.retained[0],async()=>true);
 assert.equal(c.state.view.apply_outcome,'unknown');assert.equal(c.state.retained.length,0);assert.equal(c.state.draft,'');
});
