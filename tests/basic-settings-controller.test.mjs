import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BasicSettingsController,basicRows } from '../src/basic-settings.ts';
import { basicFixture,identity,tablet,defer } from './fixtures/basic-settings.mjs';
const open=()=>{const f=basicFixture();return {...f,controller:new BasicSettingsController(()=>{}),adapter:{basicSettings:q=>f.basic.request(q)}};};
test('controller finite dirty keys/explicit null clear, one Save and no second pause',async()=>{
 const f=open();let pauses=0;await f.controller.begin(f.adapter,tablet,async()=>{pauses++;return true;});assert.equal(f.controller.state.view.state,'ready');f.controller.edit('log_level','');assert.deepEqual(f.controller.state.changes,{log_level:{action:'clear'}});f.controller.edit('debug_dump','false');assert.equal(basicRows(f.controller.state.view.current,f.controller.state.draft).length,3);await f.controller.save(f.adapter,tablet);assert.equal(f.controller.state.view.state,'verified');assert.equal(pauses,1);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);await f.controller.save(f.adapter,tablet);assert.equal(f.calls.filter(x=>x.selector==='apply').length,1);
});
test('same-ID clear/queued initial pause drops late read; failed save/status preserve original uncertainty',async()=>{
 const f=open(),pause=defer();const begin=f.controller.begin(f.adapter,tablet,()=>pause.promise);f.controller.clear();pause.resolve(true);await begin;assert.equal(f.calls.length,0);
 await f.controller.begin(f.adapter,tablet,async()=>true);f.controller.edit('debug_dump','true');f.state.onApply=()=>{throw Error('Synthetic report loss');};await f.controller.save(f.adapter,tablet);assert.equal(f.controller.state.uncertain,true);const original=f.controller.state.retained[0];assert.equal(f.calls.filter(x=>x.selector==='status').length,0);f.controller.clear();assert.equal(f.controller.state.retained[0].reference,original.reference);
 const refusal={basicSettings:async()=>{throw Error('Synthetic status refusal');}};await f.controller.status(refusal,original,tablet);assert.equal(f.controller.state.uncertain,true);assert.equal(f.controller.state.retained[0].reference,original.reference);await f.controller.status(f.adapter,original,{...tablet,boot_id:'99999999-9999-4999-8999-999999999999'});assert.equal(f.calls.filter(x=>x.selector==='status').length,0);
 await f.controller.status(f.adapter,original,tablet);assert.equal(f.controller.state.view.state,'desired-file-observed');assert.equal(f.controller.state.uncertain,false);assert.equal(f.controller.state.retained.length,0);
});
test('captured producer sequence crosses actual private coordinator/controller without producer replay',async()=>{
 const corpus=JSON.parse(await readFile(new URL('./fixtures/basic-settings-87bc8d4-corpus.json',import.meta.url))),row=name=>corpus.cases.find(x=>x.name===name),input=JSON.parse(Buffer.from(row('prepare-three-fields').stdin_base64,'base64'));
 const f=basicFixture({uuid:()=>input.operation});const reports={inspect:row('inspect-original'),prepare:row('prepare-three-fields'),apply:row('apply-verified')},packets=[];
 f.observer.run=async(action,q)=>{assert.equal(action,'basic-settings');packets.push(q);return {contract_version:1,status:'observed',observation:structuredClone(tablet),basic_raw:{status:'reported',stdout_base64:Buffer.from(reports[q.selector].stdout_utf8).toString('base64')}};};
 const controller=new BasicSettingsController(()=>{}),adapter={basicSettings:q=>f.basic.request(q)};await controller.begin(adapter,tablet,async()=>true);
 for(const [key,change] of Object.entries(input.changes))controller.edit(key,change.action==='clear'?'':String(change.value));await controller.save(adapter,tablet);assert.equal(controller.state.view.state,'verified');assert.deepEqual(controller.state.view.current,JSON.parse(row('apply-verified').stdout_utf8).data.current);assert.deepEqual(packets.map(x=>x.selector),['inspect','prepare','apply']);assert.deepEqual(JSON.parse(Buffer.from(packets[2].input_base64,'base64')).intent,JSON.parse(row('prepare-three-fields').stdout_utf8).data.intent);
 const text=JSON.stringify(controller.state);for(const key of ['base_sha256','target_sha256','config_path_sha256','intent'])assert.equal(text.includes(key),false);assert.equal(controller.state.view.report.disk_readback_verified,true);assert.equal(identity.connection_id,tablet.connection_id);
});

test('all38 original basic reports cross typed private coordinator/shared controller; seven general reports cross their existing controller',async()=>{
 const {parseBasicChanges}=await import('../host/basic-settings-protocol.mjs'),{parseSavedConfigurationReport}=await import('../host/saved-configuration.mjs'),{SavedConfigurationController}=await import('../src/saved-configuration.ts');
 const corpus=JSON.parse(await readFile(new URL('./fixtures/basic-settings-87bc8d4-corpus.json',import.meta.url))),json=row=>JSON.parse(row.stdout_utf8),input=row=>{try{return JSON.parse(Buffer.from(row.stdin_base64,'base64'));}catch{return null;}};
 const originals=corpus.cases,find=name=>originals.find(x=>x.name===name),defaultInspect=find('inspect-original'),defaultPrepare=find('prepare-three-fields'),inspections=new Map(),preparations=new Map();
 for(const row of originals){const r=json(row);if(!('snapshot'in r)&&r.status==='ok'&&r.operation==='inspect')inspections.set(r.data.base_sha256,row);if(r.operation==='prepare'&&r.outcome==='prepared')preparations.set(r.data.intent.operation,row);}
 let basic=0,general=0;
 for(const row of originals){
  const r=json(row);
  if('snapshot'in r){const view=parseSavedConfigurationReport(r),controller=new SavedConfigurationController(()=>{});await controller.inspect({inspectSavedConfiguration:async()=>({contract_version:1,status:'observed',observation:tablet,saved_configuration:{status:'reported',view}})},tablet,async()=>true);assert.deepEqual(controller.state.view,view,row.name);general++;continue;}
  const originalInput=input(row),prep=r.operation==='prepare'&&r.status==='ok'?row:preparations.get(originalInput?.intent?.operation)??defaultPrepare,prepReport=json(prep),prepInput=input(prep),inspect=r.operation==='inspect'?row:inspections.get(prepReport.data.intent?.base_sha256??prepInput?.base_sha256)??defaultInspect;
  const fixture=basicFixture({uuid:()=>prepReport.data.intent?.operation??prepInput.operation}),controller=new BasicSettingsController(()=>{}),packets=[];
  fixture.observer.run=async(action,q)=>{
   assert.equal(action,'basic-settings');packets.push(q);let selected;
   if(q.selector==='inspect')selected=inspect;
   else if(q.selector==='prepare')selected=r.operation==='prepare'?row:prep;
   else if(q.selector==='apply'){
    if(r.operation==='apply')selected=row;else throw Error('Synthetic surrounding-phase response loss - not an original producer execution');
   }else selected=row;
   return {contract_version:1,status:'observed',observation:structuredClone(tablet),basic_raw:{status:'reported',stdout_base64:Buffer.from(selected.stdout_utf8).toString('base64')}};
  };
  const adapter={basicSettings:q=>fixture.basic.request(q)};await controller.begin(adapter,tablet,async()=>true);
  if(r.operation!=='inspect'){
   const patch=r.operation==='prepare'&&r.status==='ok'?parseBasicChanges(originalInput.changes):parseBasicChanges(prepReport.data.intent?.changes??prepInput.changes);
   for(const [key,change]of Object.entries(patch))controller.edit(key,change.action==='clear'?'':String(change.value));
   // The normal UI filters redundant dirty keys. Inject the native no-op patch
   // only to cover its valid defensive response, without claiming a UI gesture.
   if(r.operation==='prepare'&&r.outcome==='no-change')controller.state={...controller.state,changes:patch};
   await controller.save(adapter,tablet);
   if(r.operation==='status'){assert.equal(controller.state.view?.state,'unknown',row.name+' surrounding synthetic loss');await controller.status(adapter,controller.state.retained[0],tablet);}
  }
  if(r.status!=='ok')assert.deepEqual(controller.state.view?.report,{operation:r.operation,status:r.status,outcome:r.outcome,disk_readback_verified:r.disk_readback_verified,runtime_activation:r.runtime_activation},row.name);
  else if(r.operation==='inspect')assert.equal(controller.state.view?.state,'ready',row.name);
  else if(r.outcome==='prepared'){assert.equal(controller.state.view?.state,'unknown',row.name);assert.deepEqual(JSON.parse(Buffer.from(packets.find(x=>x.selector==='apply').input_base64,'base64')).intent,r.data.intent);}
  else assert.equal(controller.state.view?.state,r.outcome==='verified'?'verified':r.outcome,row.name);
  const text=JSON.stringify(controller.state);for(const field of ['base_sha256','target_sha256','config_path_sha256','intent'])assert.equal(text.includes(field),false,row.name);basic++;
 }
 assert.deepEqual({basic,general},{basic:38,general:7});
});

test('old cancel reply cannot erase newer pending Save evidence after refresh',async()=>{
 const f=open(),oldPrepare=defer(),oldStarted=defer(),cancelReply=defer(),cancelStarted=defer(),newApply=defer(),newStarted=defer();let first,stop,second;
 const adapter={basicSettings:async q=>{const value=await f.basic.request(q);if(q.action==='cancel'){cancelStarted.resolve();await cancelReply.promise;}return value;}};
 try{
  await f.controller.begin(adapter,tablet,async()=>true);f.controller.edit('debug_dump','true');f.state.onPrepare=async r=>{oldStarted.resolve();await oldPrepare.promise;return r;};first=f.controller.save(adapter,tablet);await oldStarted.promise;stop=f.controller.stop(adapter,async()=>{});await cancelStarted.promise;
  f.controller.clear();f.state.onPrepare=null;await f.controller.begin(adapter,tablet,async()=>true);const reference=f.controller.state.reference;f.controller.edit('debug_dump','false');f.state.onApply=async r=>{newStarted.resolve();await newApply.promise;return r;};second=f.controller.save(adapter,tablet);await newStarted.promise;
  cancelReply.resolve();await stop;f.controller.clear();assert.equal(f.controller.state.uncertain,true);assert.equal(f.controller.state.retained.some(x=>x.reference===reference),true);
 }finally{oldPrepare.resolve();cancelReply.resolve();newApply.resolve();await Promise.allSettled([first,stop,second].filter(Boolean));}
});

test('stopping host-only retained diagnostics remains local and does not cancel remote work',async()=>{
 const controller=new BasicSettingsController(()=>{}),pending=defer();let cancels=0;const adapter={basicSettings:()=>pending.promise};const read=controller.retained(adapter);await controller.stop(adapter,async()=>{cancels++;});assert.equal(cancels,0);pending.resolve({contract_version:1,status:'unconfigured',observation:null,basic_settings:{state:'none',reference:null,current:null,report:null,retained:[]}});await read;
});
