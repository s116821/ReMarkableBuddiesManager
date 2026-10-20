// Fixed saved-basic-settings wire. Private hashes/intent never form a public view.
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const refuse=()=>{throw Error('Basic settings response refused');};
export const basicDigest=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
export const basicUuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
export const BASIC_KEYS=Object.freeze(['debug_dump','log_level','trigger_corner']);
const value=(k,v)=>k==='debug_dump'?typeof v==='boolean':(k==='log_level'?['off','error','warn','info','debug','trace']:['UR','UL','LR','LL']).includes(v);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function parseBasicFields(v){
 if(keys(v)!==BASIC_KEYS.join())refuse();
 const result={};for(const k of BASIC_KEYS){const f=v[k];if(keys(f)!=='origin,value'||!['default','declared','declared-null'].includes(f.origin)||(f.origin==='declared'?!value(k,f.value):f.value!==null))refuse();result[k]={origin:f.origin,value:f.value};}return result;
}
export function parseBasicChanges(v){
 const names=keys(v).split(',');if(!names.length||names.length>3||!names.every(k=>BASIC_KEYS.includes(k)))refuse();
 return Object.fromEntries(names.map(k=>{const c=v[k];if(c?.action==='clear'&&keys(c)==='action')return [k,{action:'clear'}];if(c?.action==='set'&&keys(c)==='action,value'&&value(k,c.value))return [k,{action:'set',value:c.value}];refuse();}));
}
export function changedBasicFields(before,patch){const v=parseBasicFields(before),changes=parseBasicChanges(patch);for(const k of Object.keys(changes))v[k]=changes[k].action==='clear'?{origin:'default',value:null}:{origin:'declared',value:changes[k].value};return v;}
export function parseBasicSettingsRequest(v){
 if(!v||bytes(v)>1024)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!basicDigest(v.reference))refuse();}
 else{
  if(!['begin','save','status'].includes(v.action)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id))refuse();
  const wanted=v.action==='begin'?'action,boot_id,connection_id':v.action==='save'?'action,boot_id,changes,connection_id,reference':'action,boot_id,connection_id,reference';if(keys(v)!==wanted||v.action!=='begin'&&!basicDigest(v.reference))refuse();if(v.action==='save')parseBasicChanges(v.changes);
 }return v;
}
const statuses=['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'];
const ops=['inspect','prepare','apply','status'];
export function parseBasicIntent(v){
 if(keys(v)!=='base_sha256,basic_version,changes,config_path_sha256,operation,target_sha256'||v.basic_version!==1||!basicUuid(v.operation)||![v.base_sha256,v.target_sha256,v.config_path_sha256].every(basicDigest)||v.base_sha256===v.target_sha256)refuse();
 return {basic_version:1,operation:v.operation,base_sha256:v.base_sha256,target_sha256:v.target_sha256,config_path_sha256:v.config_path_sha256,changes:parseBasicChanges(v.changes)};
}
function reducedReport(v){return {operation:v.operation,status:v.status,outcome:v.outcome,disk_readback_verified:v.disk_readback_verified,runtime_activation:v.runtime_activation};}
export function parseBasicSettingsReport(v,operation,context={}){
 if(keys(v)!=='data,disk_readback_verified,operation,outcome,report_version,runtime_activation,status'||v.report_version!==1||!ops.includes(operation)||v.operation!==operation||!statuses.includes(v.status)||bytes(v)+1>16384)refuse();
 const report=reducedReport(v),out={report,current:null,before:null,after:null,intent:null,base_sha256:null,config_path_sha256:null};
 if(v.status!=='ok'){
  const allowed=['inspect','status'].includes(operation)?['read-only']:operation==='prepare'?['not-dispatched']:v.status==='failed'?['not-dispatched','unknown']:['not-dispatched'];
  if(v.data!==null||v.disk_readback_verified!==false||v.runtime_activation!=='unverified'||!allowed.includes(v.outcome))refuse();return out;
 }
 const d=v.data;
 if(operation==='inspect'){
  if(keys(d)!=='base_sha256,config_path_sha256,current,schema_version'||d.schema_version!==1||![d.base_sha256,d.config_path_sha256].every(basicDigest)||v.outcome!=='read-only')refuse();
  out.current=parseBasicFields(d.current);out.base_sha256=d.base_sha256;out.config_path_sha256=d.config_path_sha256;
 }else if(operation==='prepare'){
  const before=parseBasicFields(context.current),changes=parseBasicChanges(context.changes);
  if(v.outcome==='no-change'){
   if(keys(d)!=='base_sha256,current'||!basicDigest(d.base_sha256)||d.base_sha256!==context.base_sha256||!equal(parseBasicFields(d.current),before)||!equal(changedBasicFields(before,changes),before))refuse();out.current=before;
  }else{
   if(v.outcome!=='prepared'||keys(d)!=='after,before,intent'||!equal(parseBasicFields(d.before),before))refuse();
   const intent=parseBasicIntent(d.intent);if(intent.operation!==context.operation||intent.base_sha256!==context.base_sha256||intent.config_path_sha256!==context.config_path_sha256||!equal(intent.changes,changes))refuse();
   out.before=before;out.after=parseBasicFields(d.after);if(!equal(out.after,changedBasicFields(before,changes)))refuse();out.intent=intent;
  }
 }else{
  const intent=parseBasicIntent(context.intent);if(keys(d)!==(operation==='apply'?'current,target_sha256':'current,observed_sha256'))refuse();out.current=parseBasicFields(d.current);
  if(operation==='apply'){
   if(v.outcome!=='verified'||d.target_sha256!==intent.target_sha256||v.disk_readback_verified!==true||v.runtime_activation!=='restart-required'||!equal(out.current,parseBasicFields(context.after)))refuse();return out;
  }
  if(!basicDigest(d.observed_sha256)||!['desired-file-observed','unresolved'].includes(v.outcome)||(v.outcome==='desired-file-observed')!==(d.observed_sha256===intent.target_sha256)||v.outcome==='desired-file-observed'&&!equal(out.current,parseBasicFields(context.after)))refuse();
 }
 if(v.disk_readback_verified!==false||v.runtime_activation!=='unverified')refuse();return out;
}
const states=['none','ready','invalidated','unsupported','unavailable','busy','capacity','not-dispatched','no-change','verified','unknown','unresolved','desired-file-observed'];
function publicReport(r){
 if(r===null)return null;if(keys(r)!=='disk_readback_verified,operation,outcome,runtime_activation,status'||!ops.includes(r.operation)||!statuses.includes(r.status))refuse();
 if(r.status!=='ok'){const q=parseBasicSettingsReport({report_version:1,...r,data:null},r.operation);return q.report;}
 const outcomes={inspect:['read-only'],prepare:['prepared','no-change'],apply:['verified'],status:['desired-file-observed','unresolved']};if(!outcomes[r.operation].includes(r.outcome)||r.disk_readback_verified!==(r.operation==='apply')||r.runtime_activation!==(r.operation==='apply'?'restart-required':'unverified'))refuse();return {...r};
}
export function parseBasicSettingsResult(v,request,validate){
 if(keys(v)!=='basic_settings,contract_version,observation,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!request?.connection_id||v.observation.connection_id!==request.connection_id||v.observation.boot_id!==request.boot_id))refuse();
 const q=v.basic_settings;if(keys(q)!=='current,reference,report,retained,state'||!states.includes(q.state)||q.reference!==null&&!basicDigest(q.reference))refuse();
 const report=publicReport(q.report),current=q.current===null?null:parseBasicFields(q.current);
 if(!Array.isArray(q.retained)||q.retained.length>8)refuse();const refs=new Set();for(const x of q.retained){if(keys(x)!=='boot_id,connection_id,reference,state'||!basicUuid(x.boot_id)||![x.reference,x.connection_id].every(basicDigest)||!['unknown','unresolved'].includes(x.state)||refs.has(x.reference))refuse();refs.add(x.reference);}
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
 return v;
}
