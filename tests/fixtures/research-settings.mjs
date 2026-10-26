// Synthetic POSIX reports, not backend/runtime/device qualification.
import {createHash} from 'node:crypto';
import {ResearchSettingsHost} from '../../host/research-settings.mjs';
import {RESEARCH_CONFIG} from '../../host/research-settings-protocol.mjs';
import {modelFixture,tablet,defer} from './model-settings.mjs';
import {exportFixture} from './ordinary-export.mjs';
export {tablet,defer};
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const report=(operation,outcome,data=null,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:'unverified',data});
export const rawReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),research_settings_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}});
export const patchHash=v=>hash('urn:remarkable-buddies:research-settings-patch:v1:'+JSON.stringify({research_policy:v.research_policy.action==='clear'?{action:'clear'}:{action:'set',value:v.research_policy.value}}));
export function researchFixture(options={}){
 const f=modelFixture(),rawRun=f.observer.run,e=exportFixture({observer:f.observer,io:f.io});let sequence=0;
 const state={document:{research_policy:null,reader:'SYNTHETIC_READER_DRAFT',writer:'SYNTHETIC_WRITER_DRAFT'},hash:'9'.repeat(64),path:hash('urn:remarkable-buddies:research-settings-path:v1:'+RESEARCH_CONFIG),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null,hooks:0};
 const fields=raw=>({research_policy:{origin:!Object.hasOwn(raw,'research_policy')?'default':raw.research_policy===null?'declared-null':'declared',value:raw.research_policy??'required'}});
 f.observer.run=async function(action,q){
  if(action==='ordinary-export')return e.observer.run.call(this,action,q);
  if(action!=='research-settings')return rawRun.call(this,action,q);
  this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);f.calls.push({action,selector:q.selector,bytes,body,budget_ms:q.budget_ms});let r;
  if(q.selector==='inspect')r=report('inspect','read-only',{schema_version:1,base_sha256:state.hash,config_path_sha256:state.path,current:fields(state.document)});
  else if(q.selector==='prepare'){
   const next=structuredClone(state.document),c=body.changes.research_policy;if(c.action==='clear')delete next.research_policy;else next.research_policy=c.value;
   if(JSON.stringify(next)===JSON.stringify(state.document))r=report('prepare','no-change',{current:fields(state.document),base_sha256:state.hash,changes_sha256:patchHash(body.changes)});
   else{const intent={research_settings_version:1,operation:body.operation,base_sha256:state.hash,target_sha256:hash(JSON.stringify(next)),config_path_sha256:state.path,changes_sha256:patchHash(body.changes)};state.prepared.set(intent.operation,{intent,next});r=report('prepare','prepared',{before:fields(state.document),after:fields(next),intent});}
  }else if(q.selector==='apply'){
   const p=state.prepared.get(body.intent.operation);if(!p||patchHash(body.changes)!==p.intent.changes_sha256)r=report('apply','not-dispatched',null,'conflict');else{state.document=structuredClone(p.next);state.hash=p.intent.target_sha256;r=report('apply','verified',{target_sha256:state.hash,current:fields(state.document)});}
  }else r=state.hash===body.intent.target_sha256?report('status','desired-file-observed',{observed_sha256:state.hash,current:fields(state.document)}):report('status','unresolved');
  const hook={inspect:state.onInspect,prepare:state.onPrepare,apply:state.onApply,status:state.onStatus}[q.selector];if(hook)r=await hook(r,body);return rawReply(r);
 };
 const research=new ResearchSettingsHost({observer:f.observer,io:f.io,reference:()=>String(++sequence).padStart(64,'d'),...options}),lanes={model:f.model,basic:f.basic,forget:f.forget,export:e.host,research};
 for(const [name,host] of Object.entries(lanes))host.beforeIO=()=>{state.hooks++;for(const [other,h] of Object.entries(lanes))if(other!==name)h.invalidate();};
 return {...f,research,researchState:state,archive:e.host,exportState:e.state,lanes};
}
export const begin=async f=>(await f.research.request({action:'begin',...identity})).research_settings.reference;
export const save=(f,reference,value='disabled')=>f.research.request({action:'save',...identity,reference,changes:{research_policy:value==='clear'?{action:'clear'}:{action:'set',value}}});
