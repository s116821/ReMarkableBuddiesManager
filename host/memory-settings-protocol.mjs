// Saved-memory declarations only; replacement profile text remains private.
import { basicDigest,basicUuid } from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const refuse=()=>{throw Error('Memory settings response refused');};
export const memoryDigest=basicDigest,memoryUuid=basicUuid;
export const MEMORY_KEYS=Object.freeze(['enabled','profile']);
export const MEMORY_CONFIG='/home/root/.config/remarkable-buddies/config.json';
export function memoryText(key,v){return key==='profile'&&typeof v==='string'&&v.isWellFormed()&&new TextEncoder().encode(v).length<=4096;}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function parseMemoryFields(v){
 if(keys(v)!=='enabled,profile')refuse();const e=v.enabled,p=v.profile;
 if(keys(e)!=='origin,value'||!['default','declared'].includes(e.origin)||typeof e.value!=='boolean'||e.origin==='default'&&e.value)refuse();
 if(keys(p)!=='origin,present'||!['default','declared','declared-null'].includes(p.origin)||typeof p.present!=='boolean'||p.present!==(p.origin==='declared'))refuse();
 return {enabled:{origin:e.origin,value:e.value},profile:{origin:p.origin,present:p.present}};
}
export function parseMemoryChanges(v){
 const names=keys(v).split(',');if(!names.length||names.length>2||!names.every(k=>MEMORY_KEYS.includes(k)))refuse();
 return Object.fromEntries(names.map(k=>{const c=v[k];if(c?.action==='clear'&&keys(c)==='action')return [k,{action:'clear'}];if(c?.action==='set'&&keys(c)==='action,value'&&(k==='enabled'?typeof c.value==='boolean':memoryText(k,c.value)))return [k,{action:'set',value:c.value}];refuse();}));
}
export const memoryPatchJson=v=>JSON.stringify(parseMemoryChanges(v));
export function changedMemoryFields(before,patch){const v=parseMemoryFields(before),changes=parseMemoryChanges(patch);for(const k of Object.keys(changes))v[k]=k==='enabled'?{origin:changes[k].action==='clear'?'default':'declared',value:changes[k].action==='clear'?false:changes[k].value}:changes[k].action==='clear'?{origin:'default',present:false}:{origin:'declared',present:true};return v;}
export function parseMemorySettingsRequest(v){
 if(!v||bytes(v)>16384)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!memoryDigest(v.reference))refuse();}
 else{
  if(!['begin','save','status'].includes(v.action)||!memoryDigest(v.connection_id)||!memoryUuid(v.boot_id))refuse();
  const wanted=v.action==='begin'?'action,boot_id,connection_id':v.action==='save'?'action,boot_id,changes,connection_id,reference':'action,boot_id,connection_id,reference';if(keys(v)!==wanted||v.action!=='begin'&&!memoryDigest(v.reference))refuse();if(v.action==='save')parseMemoryChanges(v.changes);
 }return v;
}
// A response needs no raw patch: use this after dispatch in renderer/HTTP/IPC.
export function memoryResponseContext(v){const {action,reference,connection_id,boot_id}=v;return {action,...reference?{reference}:{},...connection_id?{connection_id,boot_id}:{}};}
const statuses=['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'];
const ops=['inspect','prepare','apply','status'];
export function parseMemoryIntent(v){
 if(keys(v)!=='base_sha256,changes_sha256,config_path_sha256,memory_settings_version,operation,target_sha256'||v.memory_settings_version!==1||!memoryUuid(v.operation)||![v.base_sha256,v.target_sha256,v.config_path_sha256,v.changes_sha256].every(memoryDigest)||v.base_sha256===v.target_sha256)refuse();return {...v};
}
const reduced=v=>({operation:v.operation,status:v.status,outcome:v.outcome,disk_readback_verified:v.disk_readback_verified,runtime_activation:v.runtime_activation});
export function parseMemorySettingsReport(v,operation,context={}){
 if(keys(v)!=='data,disk_readback_verified,operation,outcome,report_version,runtime_activation,status'||v.report_version!==1||!ops.includes(operation)||v.operation!==operation||!statuses.includes(v.status)||bytes(v)+1>16384)refuse();
 const report=reduced(v),out={report,current:null,before:null,after:null,intent:null,base_sha256:null,config_path_sha256:null};
 if(v.status!=='ok'){
  const allowed=['inspect','status'].includes(operation)?['read-only']:operation==='prepare'?['not-dispatched']:v.status==='failed'?['not-dispatched','unknown']:['not-dispatched'];
  if(v.data!==null||v.disk_readback_verified!==false||v.runtime_activation!=='unverified'||!allowed.includes(v.outcome))refuse();return out;
 }
 const d=v.data;
 if(operation==='inspect'){
  if(keys(d)!=='base_sha256,config_path_sha256,current,schema_version'||d.schema_version!==1||![d.base_sha256,d.config_path_sha256].every(memoryDigest)||v.outcome!=='read-only')refuse();out.current=parseMemoryFields(d.current);out.base_sha256=d.base_sha256;out.config_path_sha256=d.config_path_sha256;
 }else if(operation==='prepare'){
  const before=parseMemoryFields(context.current),changes=parseMemoryChanges(context.changes);if(!memoryDigest(context.changes_sha256))refuse();
  if(v.outcome==='no-change'){
   if(keys(d)!=='base_sha256,changes_sha256,current'||d.base_sha256!==context.base_sha256||d.changes_sha256!==context.changes_sha256||!equal(parseMemoryFields(d.current),before)||!equal(changedMemoryFields(before,changes),before))refuse();out.current=before;
  }else{
   if(v.outcome!=='prepared'||keys(d)!=='after,before,intent'||!equal(parseMemoryFields(d.before),before))refuse();const intent=parseMemoryIntent(d.intent);
   if(intent.operation!==context.operation||intent.base_sha256!==context.base_sha256||intent.config_path_sha256!==context.config_path_sha256||intent.changes_sha256!==context.changes_sha256)refuse();out.before=before;out.after=parseMemoryFields(d.after);if(!equal(out.after,changedMemoryFields(before,changes)))refuse();out.intent=intent;
  }
 }else{
  const intent=parseMemoryIntent(context.intent);
  if(operation==='status'&&v.outcome==='unresolved'){if(d!==null)refuse();}
  else{
   if(keys(d)!==(operation==='apply'?'current,target_sha256':'current,observed_sha256'))refuse();out.current=parseMemoryFields(d.current);
   if(operation==='apply'){
    if(v.outcome!=='verified'||d.target_sha256!==intent.target_sha256||v.disk_readback_verified!==true||v.runtime_activation!=='unverified'||!equal(out.current,parseMemoryFields(context.after)))refuse();return out;
   }
   if(v.outcome!=='desired-file-observed'||d.observed_sha256!==intent.target_sha256||!equal(out.current,parseMemoryFields(context.after)))refuse();
  }
 }
 if(v.disk_readback_verified!==false||v.runtime_activation!=='unverified')refuse();return out;
}
const states=['none','ready','invalidated','unsupported','unavailable','busy','capacity','not-dispatched','no-change','verified','unknown','unresolved','desired-file-observed'];
function publicReport(r){
 if(r===null)return null;if(keys(r)!=='disk_readback_verified,operation,outcome,runtime_activation,status'||!ops.includes(r.operation)||!statuses.includes(r.status))refuse();
 if(r.status!=='ok')return parseMemorySettingsReport({report_version:1,...r,data:null},r.operation).report;
 const outcomes={inspect:['read-only'],prepare:['prepared','no-change'],apply:['verified'],status:['desired-file-observed','unresolved']};if(!outcomes[r.operation].includes(r.outcome)||r.disk_readback_verified!==(r.operation==='apply')||r.runtime_activation!==(r.operation==='apply'?'unverified':'unverified'))refuse();return {...r};
}
export function parseMemorySettingsResult(v,request,validate){
 if(keys(v)!=='contract_version,memory_settings,observation,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!request?.connection_id||v.observation.connection_id!==request.connection_id||v.observation.boot_id!==request.boot_id))refuse();
 const q=v.memory_settings;if(keys(q)!=='current,reference,report,retained,state'||!states.includes(q.state)||q.reference!==null&&!memoryDigest(q.reference))refuse();const report=publicReport(q.report),current=q.current===null?null:parseMemoryFields(q.current);
 const allowed={begin:['ready','invalidated','unsupported','unavailable','busy'],save:['verified','no-change','not-dispatched','unknown','capacity','unavailable','busy'],status:['desired-file-observed','unresolved','unknown','unavailable','busy'],cancel:['not-dispatched','unknown','unresolved','invalidated','unavailable'],retained:['none']};if(!allowed[request?.action]?.includes(q.state))refuse();
 if(!Array.isArray(q.retained)||q.retained.length>8)refuse();const refs=new Set();for(const x of q.retained){if(keys(x)!=='boot_id,connection_id,reference,state'||!memoryUuid(x.boot_id)||![x.reference,x.connection_id].every(memoryDigest)||!['unknown','unresolved'].includes(x.state)||refs.has(x.reference))refuse();refs.add(x.reference);}
 if(['ready','no-change','verified','desired-file-observed'].includes(q.state)){
  const expected={ready:'inspect|read-only','no-change':'prepare|no-change',verified:'apply|verified','desired-file-observed':'status|desired-file-observed'}[q.state];if(!current||!q.reference||v.status!=='observed'||report?.status!=='ok'||[report.operation,report.outcome].join('|')!==expected)refuse();
 }
 if(report?.status==='ok'){const expected={'read-only':'ready','no-change':'no-change',verified:'verified','desired-file-observed':'desired-file-observed',unresolved:'unresolved'}[report.outcome];if(!expected||q.state!==expected)refuse();}
 if(current!==null&&v.status!=='observed'||q.state==='not-dispatched'&&report?.outcome==='unknown')refuse();
 if(report?.status!=='ok'&&report?.operation==='apply'&&report?.outcome==='not-dispatched'&&q.state==='unknown')refuse();
 if(['unknown','unresolved'].includes(q.state)&&(!q.reference||!refs.has(q.reference)||request?.connection_id&&q.retained.some(x=>x.reference===q.reference&&(x.connection_id!==request.connection_id||x.boot_id!==request.boot_id))))refuse();
 if(q.state==='unknown'&&report!==null&&(report.operation!=='apply'||report.status!=='failed'||report.outcome!=='unknown'))refuse();
 if(q.state==='unresolved'&&(report?.operation!=='status'||report.status!=='ok'||report.outcome!=='unresolved'))refuse();
 if(['none','invalidated','unsupported','unavailable','busy','capacity','not-dispatched','unknown','unresolved'].includes(q.state)&&current!==null)refuse();
 if(request?.reference&&q.reference!==null&&q.reference!==request.reference)refuse();
 if(request?.action==='retained'&&(q.state!=='none'||q.reference!==null||current!==null||report!==null||v.status!=='unconfigured'))refuse();return v;
}
