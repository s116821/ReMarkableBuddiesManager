// Synthetic POSIX transport reports; never producer/device qualification.
import {createHash} from 'node:crypto';
import {MemorySettingsHost} from '../../host/memory-settings.mjs';
import {MEMORY_CONFIG} from '../../host/memory-settings-protocol.mjs';
import {tablet,defer} from './model-settings.mjs';
export {tablet,defer};
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const profile='123E4567-E89B-12D3-A456-426614174000';
export const report=(operation,outcome,data=null,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:'unverified',data});
export const rawReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),memory_settings_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}});
const canonical=v=>v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const patchHash=v=>hash('urn:remarkable-buddies:memory-settings-patch:v1:'+JSON.stringify(canonical(v)));
export function addMemoryFixture(f,options={}){
 const rawRun=f.observer.run;let sequence=0,revision=0;
 const state={document:{memory:{enabled:false,profile:'123e4567-e89b-12d3-a456-426614174000',selection:null},reader:'SYNTHETIC_READER_DRAFT',writer:'SYNTHETIC_WRITER_DRAFT'},hash:'9'.repeat(64),path:hash('urn:remarkable-buddies:memory-settings-path:v1:'+MEMORY_CONFIG),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null,hooks:0,refusePrepare:false};
 const fields=raw=>({enabled:{origin:Object.hasOwn(raw.memory??{},'enabled')?'declared':'default',value:raw.memory?.enabled??false},profile:{origin:!Object.hasOwn(raw.memory??{},'profile')?'default':raw.memory.profile===null?'declared-null':'declared',present:typeof raw.memory?.profile==='string'}});
 f.observer.run=async function(action,q){
  if(action!=='memory-settings')return rawRun.call(this,action,q);
  this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);f.calls.push({action,selector:q.selector,bytes,body,budget_ms:q.budget_ms});let r;
  if(q.selector==='inspect')r=report('inspect','read-only',{schema_version:1,base_sha256:state.hash,config_path_sha256:state.path,current:fields(state.document)});
  else if(q.selector==='prepare'){
   const next=structuredClone(state.document),changes=body.changes;
   if(!next.memory&&Object.values(changes).some(c=>c.action==='set'))next.memory={};
   if(next.memory)for(const [key,c] of Object.entries(changes)){if(c.action==='clear')delete next.memory[key];else next.memory[key]=c.value;}
   if(state.refusePrepare||next.memory?.enabled&&!next.memory?.profile)r=report('prepare','not-dispatched',null,'invalid-input');
   else if(JSON.stringify(next)===JSON.stringify(state.document))r=report('prepare','no-change',{current:fields(state.document),base_sha256:state.hash,changes_sha256:patchHash(changes)});
   else{const intent={memory_settings_version:1,operation:body.operation,base_sha256:state.hash,target_sha256:hash(JSON.stringify(next)+String(++revision)),config_path_sha256:state.path,changes_sha256:patchHash(changes)};state.prepared.set(intent.operation,{intent,next});r=report('prepare','prepared',{before:fields(state.document),after:fields(next),intent});}
  }else if(q.selector==='apply'){
   const p=state.prepared.get(body.intent.operation);if(!p||patchHash(body.changes)!==p.intent.changes_sha256)r=report('apply','not-dispatched',null,'conflict');else{state.document=structuredClone(p.next);state.hash=p.intent.target_sha256;r=report('apply','verified',{target_sha256:state.hash,current:fields(state.document)});}
  }else r=state.hash===body.intent.target_sha256?report('status','desired-file-observed',{observed_sha256:state.hash,current:fields(state.document)}):report('status','unresolved');
  const hook={inspect:state.onInspect,prepare:state.onPrepare,apply:state.onApply,status:state.onStatus}[q.selector];if(hook)r=await hook(r,body);return rawReply(r);
 };
 const memory=new MemorySettingsHost({observer:f.observer,io:f.io,reference:()=>String(++sequence).padStart(64,'d'),...options}),lanes={...f.lanes,memory};
 for(const [name,host] of Object.entries(lanes))host.beforeIO=()=>{state.hooks++;f.researchState.hooks++;for(const [other,h] of Object.entries(lanes))if(other!==name)h.invalidate();};
 return {...f,memory,memoryState:state,lanes};
}
export const begin=async f=>(await f.memory.request({action:'begin',...identity})).memory_settings.reference;
export const save=(f,reference,changes={profile:{action:'set',value:profile}})=>f.memory.request({action:'save',...identity,reference,changes});
