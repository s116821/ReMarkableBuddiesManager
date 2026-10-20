import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FIELDS,FIELD_KEYS,parseSavedConfigurationRequest,parseSavedConfigurationReport,parseSavedConfigurationView,parseSavedConfigurationResult,reduceSavedConfigurationResult } from '../host/saved-configuration.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { WiredObserver } from '../host/observer.mjs';
import { MemoryForgetHost } from '../host/memory-forget.mjs';
import { SavedConfigurationController,savedConfigurationRows } from '../src/saved-configuration.ts';
import { ConnectionController } from '../src/observation.ts';
import { corpus,request,report,privateReply,tablet,defer } from './fixtures/saved-configuration.mjs';
import { prepared,rawReply,ack,reference,operation,prepareRequest } from './fixtures/memory-forget.mjs';
const reduced=(r=report())=>reduceSavedConfigurationResult(privateReply(r),request(),validateResult);
const hash=b=>createHash('sha256').update(b).digest('hex');

test('35 actual CLI cases verify all70 original byte hashes and strict reports/reduced controller views',async()=>{
 const bytes=await readFile(new URL('./fixtures/saved-configuration-4bc7eb0-corpus.json',import.meta.url));
 assert.equal(hash(bytes),'a8c227a996c0028ee69d9d072803921c0d6b12e4902fddc2bcc785e07e792407');assert.equal(corpus.cases.length,35);
 assert.equal(corpus.source_commit,'4bc7eb0c6bf55af8392ee36a8eb3a7ca400a5389');assert.equal(corpus.capture_executable_sha256,'281fb6ea67c4028fae95a9c657e7058a0a1037c2d726bf2c4ced31bdba77d211');
 for(const row of corpus.cases){
  const input=row.input;let bytes;
  if('utf8'in input)bytes=Buffer.from(input.utf8,'utf8');
  else if('base64'in input)bytes=Buffer.from(input.base64,'base64');
  else{const prefix=Buffer.from(input.prefix_utf8,'utf8');bytes=Buffer.concat([prefix,Buffer.alloc(input.total_bytes-prefix.length,input.padding_byte)]);}
  assert.equal(hash(bytes),row.input_sha256,row.name+' input');assert.equal(hash(Buffer.from(row.stdout_utf8,'utf8')),row.stdout_sha256,row.name+' stdout');assert.equal(row.exit_code,0);assert.equal(row.stderr_utf8,'');
  const raw=JSON.parse(row.stdout_utf8),view=parseSavedConfigurationReport(raw),value=reduced(raw);parseSavedConfigurationView(view);parseSavedConfigurationResult(value,request(),validateResult);
  const c=new SavedConfigurationController(()=>{});await c.inspect({inspectSavedConfiguration:async()=>value},tablet,async()=>true);assert.deepEqual(c.state.view,view);assert.equal(c.state.busy,false);
  const text=JSON.stringify(c.state);
  if(row.name==='private-sentinels'){const source=JSON.parse(row.input.utf8);for(const secret of [source.model,source.base_url,source.model_credential,...Object.values(source.paths),source.memory.profile,...Object.values(source.memory.selection),source.sync.collection,source.personalization.text])assert.equal(text.includes(secret),false);}assert.equal(text.includes('config_sha256'),false);assert.equal(text.includes(raw.snapshot?.config_sha256??'PRIVATE_SENTINEL'),false);
  if(raw.status==='ok'){assert.equal(FIELD_KEYS.length,25);assert.equal(savedConfigurationRows(view).length,25);assert.deepEqual(view.snapshot.fields,raw.snapshot.fields);assert.equal(view.snapshot.declared_roots_validated,false);}
  else assert.equal(view.snapshot,null);
 }
 assert.equal(report('declared-safe-scalars').snapshot.fields['sync.max_media_bytes'].value,268435456);
 assert.deepEqual(report('default').snapshot.fields,Object.fromEntries(FIELD_KEYS.map(k=>[k,{origin:'default',value:DEFAULT_FIELDS[k]}])));
});

test('strict origins/defaults/types/private data/cross-field reductions refuse whole malformed views',()=>{
 const mutations=[r=>{r.config_sha256='a'.repeat(64);},r=>{r.snapshot.private='PRIVATE';},r=>{r.snapshot.fields.model.value='https://private.invalid/?token=PRIVATE';},r=>{r.snapshot.fields.model.origin='declared';},r=>{r.snapshot.fields.debug_dump={origin:'declared',value:null};},r=>{r.snapshot.fields['paths.data'].origin='declared';},r=>{r.snapshot.fields['paths.data'].value=false;},r=>{r.snapshot.fields['memory.enabled']={origin:'declared',value:true};},r=>{r.snapshot.fields['sync.create_new']={origin:'declared',value:true};},r=>{r.snapshot.fields['personalization.text']={origin:'declared',value:true};},r=>{r.snapshot.fields['personalization.text_bytes']={origin:'declared',value:0};},r=>{r.snapshot.fields['sync.max_media_bytes']={origin:'declared',value:268435457};},r=>{r.snapshot.fields['sync.poll_seconds']={origin:'declared',value:1.5};},r=>{r.snapshot.fields['sync.namespaces']={origin:'declared',value:['source','conversation']};},r=>{r.snapshot.fields['sync.namespaces']={origin:'declared',value:['source','source']};},r=>{r.snapshot.unsupported=[];},r=>{r.snapshot.fields.paths={data:true};},r=>{r.runtime_activation='active';},r=>{r.status='partial';},r=>{r.snapshot.config_sha256='0'.repeat(64)+'\n';}];
 for(const mutate of mutations){const r=report();mutate(r);assert.throws(()=>parseSavedConfigurationReport(r));}
 for(const name of FIELD_KEYS){const r=report();r.snapshot.fields[name].origin='declared-null';if(!['model','base_url','model_credential','trigger_corner','log_level','debug_dump','memory.profile','memory.selection','sync.collection'].includes(name))assert.throws(()=>parseSavedConfigurationReport(r));}
 const raw=report();const view=parseSavedConfigurationReport(raw);assert.equal(Object.hasOwn(raw.snapshot,'config_sha256'),true);assert.equal(Object.hasOwn(view.snapshot,'config_sha256'),false);
 const bad=structuredClone(view);bad.snapshot.config_sha256=raw.snapshot.config_sha256;assert.throws(()=>parseSavedConfigurationView(bad));
 for(const q of [{...request(),path:'/private'},{...request(),config_sha256:'a'.repeat(64)},{...request(),boot_id:tablet.boot_id+'\n'},{...request(),connection_id:'a'.repeat(63)}])assert.throws(()=>parseSavedConfigurationRequest(q));
 const future=report();future.report_version=2;assert.equal(reduced(future).saved_configuration.status,'unsupported');assert.equal(reduced(future).saved_configuration.view,null);
 const privateValue=privateReply(report());assert.throws(()=>parseSavedConfigurationResult(privateValue,request(),validateResult));
});

test('controller generation covers queued prepare and cancelled late same-ID results without automatic dispatch',async()=>{
 const c=new SavedConfigurationController(()=>{}),pause=defer(),reply=defer();let calls=0;
 const adapter={inspectSavedConfiguration:async()=>{calls++;return reply.promise;}};
 const old=c.inspect(adapter,tablet,()=>pause.promise);c.clear();pause.resolve(true);await old;assert.equal(calls,0);
 const read=c.inspect(adapter,tablet,async()=>true);await new Promise(r=>setImmediate(r));assert.equal(calls,1);c.clear();reply.resolve(reduced());await read;assert.equal(c.state.view,null);
 const cancel=defer();const stopped=c.cancel(()=>cancel.promise);assert.equal(c.state.busy,true);await c.inspect(adapter,tablet,async()=>true);assert.equal(calls,1);cancel.resolve();await stopped;assert.equal(c.state.busy,false);assert.equal(c.state.view,null);
});

test('shared ConnectionController queue completes old cancel before new observation and settings launch',async()=>{
 const cancel=defer(),events=[];let gates=false;
 const connection=new ConnectionController({cancel:async()=>{events.push('cancel-start');if(gates)await cancel.promise;events.push('cancel-end');return {contract_version:1,status:'cancelled',observation:null};},observe:async()=>{events.push('observe');return {contract_version:1,status:'observed',observation:tablet};}},()=>{},60000);
 const c=new SavedConfigurationController(()=>{});
 try{
  await connection.connect();gates=true;const stopping=c.cancel(()=>connection.pause());const reading=connection.connect();await new Promise(r=>setImmediate(r));assert.equal(events.at(-1),'cancel-start');cancel.resolve();await stopping;await reading;assert.equal(events.at(-1),'observe');
  await c.inspect({inspectSavedConfiguration:async()=>{events.push('settings');return reduced();}},tablet,async()=>{await connection.pause();return true;});assert.equal(events.at(-1),'settings');assert.equal(c.state.view.status,'ok');
 }finally{connection.dispose();}
});

test('new inspection invalidates ready forget before I/O and preserves original unknown intent receipt bytes',async()=>{
 for(const uncertain of [false,true]){
  const calls=[];let manager;
  const observer=new WiredObserver();observer.lastObservation=tablet;
  observer.run=async function(action,q){this.cancel();if(action==='saved-configuration'){assert.equal((await manager.request({action:'confirm',reference})).forget.state,'unavailable');return reduced();}
   const body=Buffer.from(q.input_base64,'base64');calls.push({selector:q.selector,body});if(q.selector==='prepare-forget')return rawReply(await prepared(JSON.parse(body).operation));if(q.selector==='forget')throw Error('Synthetic lost reply');return rawReply(ack('forget-receipt',operation));};
  manager=new MemoryForgetHost({observer,reference:()=>reference,uuid:()=>operation});await manager.request(prepareRequest());if(uncertain)await manager.request({action:'confirm',reference});
  const value=await manager.wrap().inspectSavedConfiguration(request());assert.equal(value.saved_configuration.view.status,'ok');
  assert.equal((await manager.request({action:'status'})).forget.state,uncertain?'unknown':'invalidated');
  if(uncertain){assert.equal((await manager.request({action:'receipt',reference})).forget.state,'acknowledged');assert.deepEqual(calls[1].body,calls[2].body);}
  assert.equal(calls.filter(c=>c.selector==='forget').length,uncertain?1:0);
 }
});

test('actual Node child fixed selection enforces caps/identity/framing/exit/generation without private output',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'manager-config-child-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=path.join(root,'config');
 await writeFile(path.join(root,'saved_configuration_transport.py'),`const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{if(process.argv.length!==2||raw!==${JSON.stringify(JSON.stringify(request()))})throw Error('input');const mode=fs.readFileSync(process.env.MANAGER_WIRED_CONFIG,'utf8');if(mode==='wait'){setTimeout(()=>{},30000);return}if(mode==='oversize'){process.stdout.write('x'.repeat(139265));return}if(mode==='utf8'){process.stdout.write(Buffer.from([255]));return}if(mode==='exit'){process.stderr.write('PRIVATE_CANARY');process.exit(1)}const v=${JSON.stringify(privateReply(report()))};if(mode==='foreign')v.observation.boot_id=${JSON.stringify(operation)};if(mode==='raw')v.private='PRIVATE_CANARY';if(mode==='partial'){process.stdout.write(JSON.stringify(v).slice(0,-1));return}const text=JSON.stringify(v);process.stdout.write(text+(mode==='bound'?' '.repeat(139264-text.length):''));});`);
 const observer=new WiredObserver({config,python:process.execPath,script:path.join(root,'wired_observer.py')});observer.lastObservation=tablet;
 for(const mode of ['normal','bound']){await writeFile(config,mode);assert.equal((await observer.inspectSavedConfiguration(request())).saved_configuration.view.status,'ok');}
 for(const mode of ['oversize','utf8','exit','foreign','raw','partial','wait']){await writeFile(config,mode);observer.timeoutMs=mode==='wait'?200:13000;const v=await observer.inspectSavedConfiguration(request());assert.equal(v.saved_configuration.view,null);assert.equal(JSON.stringify(v).includes('PRIVATE_'),false);}
 const pending=observer.inspectSavedConfiguration(request());observer.cancel();assert.equal((await pending).status,'cancelled');
});
