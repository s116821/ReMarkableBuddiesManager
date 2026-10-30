import { strictJson } from './strict-json.mjs';
// Fixed saved-product-settings wire. Private hashes/intent never form a public view.
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const refuse=()=>{throw Error('Product settings response refused');};
export const productDigest=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
export const productUuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
export const PRODUCT_KEYS=Object.freeze(['export_destination','reader_enabled','writer_enabled']);
const defaults={export_destination:'mem',reader_enabled:true,writer_enabled:true};
const value=(k,v)=>k==='export_destination'?['mem','disabled'].includes(v):typeof v==='boolean';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function parseProductFields(v){
 if(keys(v)!==PRODUCT_KEYS.join())refuse();
 const result={};for(const k of PRODUCT_KEYS){const f=v[k];if(keys(f)!=='origin,value'||!['default','declared'].includes(f.origin)||!value(k,f.value)||(f.origin==='default'&&f.value!==defaults[k]))refuse();result[k]={origin:f.origin,value:f.value};}return result;
}
export function parseProductChanges(v){
 const names=keys(v).split(',');if(!names.length||names.length>3||!names.every(k=>PRODUCT_KEYS.includes(k)))refuse();
 return Object.fromEntries(names.map(k=>{const c=v[k];if(c?.action==='clear'&&keys(c)==='action')return [k,{action:'clear'}];if(c?.action==='set'&&keys(c)==='action,value'&&value(k,c.value))return [k,{action:'set',value:c.value}];refuse();}));
}
export function changedProductFields(before,patch){const v=parseProductFields(before),changes=parseProductChanges(patch);for(const k of Object.keys(changes))v[k]=changes[k].action==='clear'?{origin:'default',value:defaults[k]}:{origin:'declared',value:changes[k].value};return v;}
export function parseProductSettingsRequest(v){
 if(!v||bytes(v)>1024)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!productDigest(v.reference))refuse();}
 else{
  if(!['begin','save','status'].includes(v.action)||!productDigest(v.connection_id)||!productUuid(v.boot_id))refuse();
  const wanted=v.action==='begin'?'action,boot_id,connection_id':v.action==='save'?'action,boot_id,changes,connection_id,reference':'action,boot_id,connection_id,reference';if(keys(v)!==wanted||v.action!=='begin'&&!productDigest(v.reference))refuse();if(v.action==='save')parseProductChanges(v.changes);
 }return v;
}
const statuses=['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'];
const ops=['inspect','prepare','apply','status'];
export function parseProductIntent(v){
 if(keys(v)!=='base_sha256,changes,config_path_sha256,operation,product_settings_version,target_sha256'||v.product_settings_version!==1||!productUuid(v.operation)||![v.base_sha256,v.target_sha256,v.config_path_sha256].every(productDigest)||v.base_sha256===v.target_sha256)refuse();
 return {product_settings_version:1,operation:v.operation,base_sha256:v.base_sha256,target_sha256:v.target_sha256,config_path_sha256:v.config_path_sha256,changes:parseProductChanges(v.changes)};
}
function reducedReport(v){return {operation:v.operation,status:v.status,outcome:v.outcome,disk_readback_verified:v.disk_readback_verified,runtime_activation:v.runtime_activation};}
export function parseProductSettingsReport(v,operation,context={}){
 if(keys(v)!=='data,disk_readback_verified,operation,outcome,report_version,runtime_activation,status'||v.report_version!==1||!ops.includes(operation)||v.operation!==operation||!statuses.includes(v.status)||bytes(v)+1>16384)refuse();
 const report=reducedReport(v),out={report,current:null,before:null,after:null,intent:null,base_sha256:null,config_path_sha256:null};
 if(v.status!=='ok'){
  const allowed=['inspect','status'].includes(operation)?['read-only']:operation==='prepare'?['not-dispatched']:v.status==='failed'?['not-dispatched','unknown']:['not-dispatched'];
  if(v.data!==null||v.disk_readback_verified!==false||v.runtime_activation!=='unverified'||!allowed.includes(v.outcome))refuse();return out;
 }
 const d=v.data;
 if(operation==='inspect'){
  if(keys(d)!=='base_sha256,config_path_sha256,current,schema_version'||d.schema_version!==1||![d.base_sha256,d.config_path_sha256].every(productDigest)||v.outcome!=='read-only')refuse();
  out.current=parseProductFields(d.current);out.base_sha256=d.base_sha256;out.config_path_sha256=d.config_path_sha256;
 }else if(operation==='prepare'){
  const before=parseProductFields(context.current),changes=parseProductChanges(context.changes);
  if(v.outcome==='no-change'){
   if(keys(d)!=='base_sha256,current'||!productDigest(d.base_sha256)||d.base_sha256!==context.base_sha256||!equal(parseProductFields(d.current),before)||!equal(changedProductFields(before,changes),before))refuse();out.current=before;
  }else{
   if(v.outcome!=='prepared'||keys(d)!=='after,before,intent'||!equal(parseProductFields(d.before),before))refuse();
   const intent=parseProductIntent(d.intent);if(intent.operation!==context.operation||intent.base_sha256!==context.base_sha256||intent.config_path_sha256!==context.config_path_sha256||!equal(intent.changes,changes))refuse();
   out.before=before;out.after=parseProductFields(d.after);if(!equal(out.after,changedProductFields(before,changes)))refuse();out.intent=intent;
  }
 }else{
  const intent=parseProductIntent(context.intent);if(keys(d)!==(operation==='apply'?'current,target_sha256':'current,observed_sha256'))refuse();out.current=parseProductFields(d.current);
  if(operation==='apply'){
   if(v.outcome!=='verified'||d.target_sha256!==intent.target_sha256||v.disk_readback_verified!==true||v.runtime_activation!=='restart-required'||!equal(out.current,parseProductFields(context.after)))refuse();return out;
  }
  if(!productDigest(d.observed_sha256)||!['desired-file-observed','unresolved'].includes(v.outcome)||(v.outcome==='desired-file-observed')!==(d.observed_sha256===intent.target_sha256)||v.outcome==='desired-file-observed'&&!equal(out.current,parseProductFields(context.after)))refuse();
 }
 if(v.disk_readback_verified!==false||v.runtime_activation!=='unverified')refuse();return out;
}
const states=['none','ready','invalidated','unsupported','unavailable','busy','capacity','not-dispatched','no-change','verified','unknown','unresolved','desired-file-observed'];
function publicReport(r){
 if(r===null)return null;if(keys(r)!=='disk_readback_verified,operation,outcome,runtime_activation,status'||!ops.includes(r.operation)||!statuses.includes(r.status))refuse();
 if(r.status!=='ok'){const q=parseProductSettingsReport({report_version:1,...r,data:null},r.operation);return q.report;}
 const outcomes={inspect:['read-only'],prepare:['prepared','no-change'],apply:['verified'],status:['desired-file-observed','unresolved']};if(!outcomes[r.operation].includes(r.outcome)||r.disk_readback_verified!==(r.operation==='apply')||r.runtime_activation!==(r.operation==='apply'?'restart-required':'unverified'))refuse();return {...r};
}
export function parseProductSettingsResult(v,request,validate){
 if(keys(v)!=='contract_version,observation,product_settings,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!request?.connection_id||v.observation.connection_id!==request.connection_id||v.observation.boot_id!==request.boot_id))refuse();
 const q=v.product_settings;if(keys(q)!=='current,reference,report,retained,state'||!states.includes(q.state)||q.reference!==null&&!productDigest(q.reference))refuse();
 const report=publicReport(q.report),current=q.current===null?null:parseProductFields(q.current);
 if(!Array.isArray(q.retained)||q.retained.length>8)refuse();const refs=new Set();for(const x of q.retained){if(keys(x)!=='boot_id,connection_id,reference,state'||!productUuid(x.boot_id)||![x.reference,x.connection_id].every(productDigest)||!['unknown','unresolved'].includes(x.state)||refs.has(x.reference))refuse();refs.add(x.reference);}
 if(['ready','no-change','verified','desired-file-observed'].includes(q.state)){
  const expected={ready:'inspect|read-only', 'no-change':'prepare|no-change',verified:'apply|verified','desired-file-observed':'status|desired-file-observed'}[q.state];if(!current||!q.reference||v.status!=='observed'||report?.status!=='ok'||[report.operation,report.outcome].join('|')!==expected)refuse();
 }
 if(report?.status==='ok'){const expected={'read-only':'ready','no-change':'no-change',verified:'verified','desired-file-observed':'desired-file-observed',unresolved:'unresolved'}[report.outcome];if(!expected||q.state!==expected)refuse();}
 if(current!==null&&v.status!=='observed'||q.state==='not-dispatched'&&report?.outcome==='unknown')refuse();
 if(['unknown','unresolved'].includes(q.state)&&(!q.reference||!refs.has(q.reference)))refuse();if(q.state==='unknown'&&current!==null)refuse();
 if(q.state==='unresolved'&&current&&(!report||report.operation!=='status'||report.status!=='ok'||report.outcome!=='unresolved'))refuse();
 if(['none','invalidated','unsupported','unavailable','busy','capacity','not-dispatched'].includes(q.state)&&current!==null)refuse();
 if(request?.reference&&q.reference!==null&&q.reference!==request.reference)refuse();
 if(request?.action==='retained'&&(q.state!=='none'||q.reference!==null||current!==null||report!==null||v.status!=='unconfigured'))refuse();
 const allowed={retained:['none'],begin:['ready','invalidated','unsupported','unavailable','busy'],save:['verified','no-change','not-dispatched','unknown','capacity','unavailable','busy'],status:['desired-file-observed','unresolved','unknown','unavailable','busy'],cancel:['not-dispatched','unknown','unresolved','invalidated','unavailable']};
 if(!allowed[request?.action]?.includes(q.state))refuse();
 return v;
}

// Preserve BOM for explicit refusal; JSON.parse alone loses duplicate members and
// numeric token spelling. Versions in this closed wire use plain integer tokens.
export function parseProductRawFrame(raw){
 if(!(raw instanceof Uint8Array)||raw.length>16384)refuse();
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
 if(text.charCodeAt(0)===0xfeff||!text.endsWith('\n')||text.split('\n').length!==2)refuse();
 const unquoted=text.replace(/"(?:[^"\\]|\\.)*"/g,'""');
 if(/-?(?:0|[1-9]\d*)(?:\.\d+|[eE][+-]?\d+)/.test(unquoted))refuse();
 return strictJson(raw);
}
