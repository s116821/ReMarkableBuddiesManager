import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelSettingsController,ModelDraft,displayModelText,spliceModelText,reconcileModelText} from '../src/model-settings.ts';
import {modelFixture,tablet,defer} from './fixtures/model-settings.mjs';
const open=()=>{const f=modelFixture(),controller=new ModelSettingsController(()=>{});return {...f,controller,adapter:{modelSettings:q=>f.model.request(q)}};};
const start=async f=>f.controller.begin(f.adapter,tablet,async()=>true);
const paste=(c,key,value)=>{c.action(key,'replace');c.paste(key,0,0,value);};
test('raw paste/textarea edit mapping preserves CRLF/lone CR/Unicode/trailing spans and safely bounds scalar drafts',()=>{
 const raw='\r\n😀model\rendpoint\r\n\t ';assert.equal(displayModelText(raw),'\n😀model\nendpoint\n\t ');assert.equal(spliceModelText(raw,1,3,'λ'),'\r\nλmodel\rendpoint\r\n\t ');
 assert.equal(reconcileModelText(raw,displayModelText(raw)+'!'),raw+'!');const d=new ModelDraft();assert.equal(d.paste('model',0,0,raw),true);const value=displayModelText(raw);d.beforeInput('model',value.length,value.length,'insertText','!');assert.equal(d.input('model',value+'!'),true);assert.equal(d.patch({model:'replace',base_url:'keep'}).model.value,raw+'!');
 d.clear();assert.equal(d.paste('model',0,0,'\uFEFF'),true);assert.equal(d.valid('model'),true);d.clear();d.paste('model',0,0,'\u0085');assert.equal(d.valid('model'),false);assert.equal(d.paste('model',0,1,'\ud800'),false);assert.equal(d.valid('model'),false);d.clear();assert.equal(d.paste('base_url',0,0,'x'.repeat(2049)),false);assert.equal(d.display('base_url'),'');
});
test('shared controller sends exact opaque text once, clears raw draft before await and never publishes it in safe state',async()=>{
 const f=open();await start(f);assert.equal(f.controller.state.view.state,'ready');const secret='https://user:PRIVATE@invalid.test/?token=PRIVATE\r\n\t ';paste(f.controller,'base_url',secret);f.controller.action('model','clear');assert.equal(f.controller.state.valid,true);assert.equal(JSON.stringify(f.controller.state).includes('PRIVATE'),false);
 const gate=defer();let sent;const adapter={modelSettings:async q=>{sent=structuredClone(q);await gate.promise;return f.model.request(q);}};const pending=f.controller.save(adapter,tablet);assert.equal(f.controller.text('base_url'),'');assert.deepEqual(f.controller.state.actions,{model:'keep',base_url:'keep'});assert.equal(sent.changes.base_url.value,secret);assert.equal(sent.changes.model.action,'clear');gate.resolve();await pending;assert.equal(f.controller.state.view.state,'verified');assert.equal(f.controller.state.valid,false);assert.equal(f.controller.text('base_url'),'');assert.equal(JSON.stringify(f.controller.state).includes('PRIVATE'),false);f.controller.clear();
});
test('draft invalidation/expiry and host-only retained-stop do not restore inputs or contact remote work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=open();await start(f);paste(f.controller,'model','PRIVATE');t.mock.timers.tick(120001);assert.equal(f.controller.text('model'),'');assert.equal(f.controller.state.view,null);
 await start(f);paste(f.controller,'model','PRIVATE');f.controller.clear();assert.equal(f.controller.text('model'),'');const gate=defer();let cancels=0;const pending=f.controller.retained({modelSettings:async()=>{await gate.promise;return f.model.request({action:'retained'});}});await f.controller.stop(f.adapter,async()=>{cancels++;});gate.resolve();await pending;assert.equal(cancels,0);assert.equal(f.controller.text('model'),'');
});
test('lost Save/status retains only original identity and stale old stop cannot settle newer Save or refill text',async()=>{
 const f=open();await start(f);paste(f.controller,'model','PRIVATE_FIRST');const oldPrepare=defer(),cancelReply=defer();f.modelState.onPrepare=async r=>{await oldPrepare.promise;return r;};const oldSave=f.controller.save(f.adapter,tablet);await new Promise(r=>setImmediate(r));const oldReference=f.controller.state.reference;
 const stop=f.controller.stop({modelSettings:async q=>{const result=await f.model.request(q);await cancelReply.promise;return result;}},async()=>{});await new Promise(r=>setImmediate(r));f.controller.clear();f.modelState.onPrepare=null;await start(f);paste(f.controller,'model','PRIVATE_NEW');const newApply=defer();f.modelState.onApply=async r=>{await newApply.promise;return r;};const newSave=f.controller.save(f.adapter,tablet);await new Promise(r=>setImmediate(r));const newReference=f.controller.state.reference;assert.notEqual(newReference,oldReference);cancelReply.resolve();await stop;f.controller.clear();assert.equal(f.controller.state.uncertain,true);assert.ok(f.controller.state.retained.some(x=>x.reference===newReference));assert.equal(f.controller.text('model'),'');
 oldPrepare.resolve();newApply.resolve();await Promise.all([oldSave,newSave]);assert.equal(f.controller.text('model'),'');assert.equal(f.controller.state.reference,newReference);
});

test('all32 original model reports cross actual typed private coordinator/shared controller without producer replay',async()=>{
 const {readFile}=await import('node:fs/promises'),{parseModelChanges}=await import('../host/model-settings-protocol.mjs');
 const corpus=JSON.parse(await readFile(new URL('./fixtures/model-settings-c785afe-corpus.json',import.meta.url))),rows=corpus.records,json=row=>JSON.parse(row.stdout_utf8),input=row=>{try{return JSON.parse(Buffer.from(row.stdin_base64,'base64'));}catch{return null;}};
 const find=name=>rows.find(x=>x.name===name),defaultInspect=find('inspect-original'),defaultPrepare=find('prepare-two-fields'),inspections=new Map(),preparations=new Map();
 for(const row of rows){const r=json(row);if(r.status==='ok'&&r.operation==='inspect')inspections.set(r.data.base_sha256+'|'+r.data.config_path_sha256,row);if(r.operation==='prepare'&&r.outcome==='prepared')preparations.set(r.data.intent.operation,row);}
 let count=0;
 for(const row of rows){
  const r=json(row),originalInput=input(row),prep=r.operation==='prepare'&&r.status==='ok'?row:preparations.get(originalInput?.intent?.operation)??defaultPrepare,prepReport=json(prep),prepInput=input(prep),inspect=r.operation==='inspect'?row:inspections.get((prepReport.data.intent?.base_sha256??prepInput.base_sha256)+'|'+(prepReport.data.intent?.config_path_sha256??prepInput.config_path_sha256))??defaultInspect;
  const fixture=modelFixture({uuid:()=>prepReport.data.intent?.operation??prepInput.operation}),controller=new ModelSettingsController(()=>{}),packets=[];
  fixture.observer.run=async(action,q)=>{assert.equal(action,'model-settings');packets.push({selector:q.selector,bytes:q.input_base64===null?null:Buffer.from(q.input_base64,'base64')});let selected;if(q.selector==='inspect')selected=inspect;else if(q.selector==='prepare')selected=r.operation==='prepare'?row:prep;else if(q.selector==='apply'){if(r.operation==='apply')selected=row;else throw Error('Synthetic surrounding-phase reply loss; not original producer execution');}else selected=row;return {contract_version:1,status:'observed',observation:structuredClone(tablet),model_raw:{status:'reported',stdout_base64:Buffer.from(selected.stdout_utf8).toString('base64')}};};
  const adapter={modelSettings:q=>fixture.model.request(q)};await controller.begin(adapter,tablet,async()=>true);
  if(r.operation!=='inspect'){
   const patch=parseModelChanges(r.operation==='prepare'&&r.status==='ok'?originalInput.changes:prepInput.changes);
   for(const [key,change] of Object.entries(patch)){controller.action(key,change.action==='clear'?'clear':'replace');if(change.action==='set')controller.paste(key,0,0,change.value);}
   assert.equal(controller.state.valid,true,row.name);await controller.save(adapter,tablet);
   if(r.operation==='status'){assert.equal(controller.state.view?.state,'unknown',row.name+' synthetic surrounding loss');await controller.status(adapter,controller.state.retained[0],tablet);}
  }
  if(r.status!=='ok')assert.deepEqual(controller.state.view?.report,{operation:r.operation,status:r.status,outcome:r.outcome,disk_readback_verified:r.disk_readback_verified,runtime_activation:r.runtime_activation},row.name);
  else if(r.operation==='inspect')assert.equal(controller.state.view?.state,'ready',row.name);
  else if(r.outcome==='prepared'){assert.equal(controller.state.view?.state,'unknown',row.name);const applied=JSON.parse(packets.find(x=>x.selector==='apply').bytes);assert.deepEqual(applied.intent,r.data.intent);assert.deepEqual(applied.changes,parseModelChanges(prepInput.changes));}
  else assert.equal(controller.state.view?.state,r.outcome,row.name);
  if(r.operation==='status'){assert.deepEqual(Object.keys(JSON.parse(packets.find(x=>x.selector==='status').bytes)),['intent']);if(r.outcome==='unresolved')assert.equal(controller.state.view.current,null);}
  const safe=JSON.stringify(controller.state);for(const field of ['base_sha256','target_sha256','changes_sha256','config_path_sha256','intent'])assert.equal(safe.includes(field),false,row.name);assert.equal(controller.text('model'),'');assert.equal(controller.text('base_url'),'');controller.clear();count++;
 }
 assert.equal(count,32);
});
