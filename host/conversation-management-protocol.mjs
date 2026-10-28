import {strictJson} from './strict-json.mjs';
// Public safe DTOs only; producer originals and receipts remain host-private.
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const exact=(v,k)=>keys(v)===k.split(' ').sort().join();
const refuse=()=>{throw Error('Conversation management response refused');};
const size=v=>{try{return new TextEncoder().encode(JSON.stringify(v)).length;}catch{return refuse();}};
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export function parseManagementRequest(v){
 if(size(v)>384)refuse();
 if(v?.action==='retained'){if(!exact(v,'action'))refuse();}
 else if(v?.action==='cancel'){if(!exact(v,'action reference invocation')||!basicDigest(v.reference)||!basicUuid(v.invocation))refuse();}
 else{
  if(!['inspect','prepare','confirm','status'].includes(v?.action)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||!basicUuid(v.invocation))refuse();
  if(v.action==='inspect'){if(!exact(v,'action connection_id boot_id invocation conversation')||!basicUuid(v.conversation))refuse();}
  else if(!exact(v,'action connection_id boot_id invocation reference')||!basicDigest(v.reference))refuse();
 }return {...v};
}
export function parseManagementResult(v,request,validate){
 const q=parseManagementRequest(request);if(size(v)>8192||!exact(v,'contract_version status observation conversation_management'))refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 const c=v.conversation_management;if(!exact(c,'state reference preview report retained')||!Array.isArray(c.retained)||c.retained.length>8)refuse();
 const refs=new Set();for(const row of c.retained){if(!exact(row,'reference connection_id boot_id conversation state status_available')||!basicDigest(row.reference)||refs.has(row.reference)||!basicDigest(row.connection_id)||!basicUuid(row.boot_id)||!basicUuid(row.conversation)||!['unknown','unchanged','unresolved'].includes(row.state)||typeof row.status_available!=='boolean')refuse();refs.add(row.reference);}
 if(c.reference!==null&&!basicDigest(c.reference))refuse();
 if(q.action==='retained'){if(c.state!=='none'||c.reference!==null||c.preview!==null||c.report!==null)refuse();}
 else if(q.action==='inspect'){if(c.state==='inspected'?!basicDigest(c.reference):c.reference!==null)refuse();}
 else if(c.reference!==q.reference)refuse();
 const allowed={retained:['none'],inspect:['inspected','invalidated','capacity','busy','unsupported','unavailable'],prepare:['ready','invalidated','capacity','busy','unsupported','unavailable'],confirm:['acknowledged','unknown','unresolved','not-dispatched','capacity','busy'],status:['acknowledged','unknown','unchanged','unresolved','capacity','busy','unsupported','unavailable'],cancel:['invalidated','not-dispatched','unknown','unchanged','unresolved','unavailable']};
 if(!allowed[q.action].includes(c.state))refuse();
 const selected=c.retained.find(row=>row.reference===c.reference);
 if(selected&&'connection_id' in q&&!same(selected,q))refuse();
 if(['inspected','ready','acknowledged'].includes(c.state)&&selected)refuse();
 const r=c.report;
 if(r===null){if(v.status!=='unconfigured'||v.observation!==null)refuse();}
 else{
  if(!exact(r,'operation status runtime_unverified local_only physical_reclamation service_observation possible_effect current_state')||r.operation!==({inspect:'inspect',prepare:'prepare',confirm:'apply',status:'status'})[q.action]||r.runtime_unverified!==true||r.local_only!==true||r.physical_reclamation!==false||!['inactive','unverified'].includes(r.service_observation)||typeof r.possible_effect!=='boolean'||r.current_state!==null&&!['live-original','desired-tombstones','changed'].includes(r.current_state)||v.status!=='observed'||!same(q,v.observation))refuse();
 }
 const match=(statuses,effect)=>r!==null&&(Array.isArray(statuses)?statuses.includes(r.status):r.status===statuses)&&r.possible_effect===effect;
 switch(c.state){
 case 'inspected':case 'ready':
  if(!match(c.state==='inspected'?'ready':'prepared',false)||r.service_observation!=='inactive'||r.current_state!=='live-original'||!exact(c.preview,'conversation turns source_records export_associations')||!basicUuid(c.preview.conversation)||q.action==='inspect'&&q.conversation!==c.preview.conversation||!['turns','source_records','export_associations'].every(k=>Number.isSafeInteger(c.preview[k])&&c.preview[k]>=0&&c.preview[k]<=4096))refuse();break;
 case 'acknowledged':if(!match('acknowledged',true)||r.service_observation!=='inactive'||r.current_state===null)refuse();break;
 case 'unknown':case 'unchanged':case 'unresolved':{
  const row=c.retained.find(x=>x.reference===c.reference);if(!row||row.state!==c.state)refuse();
  if(c.state==='unknown'){if(r!==null&&(!match(['unknown','conflict'],true)||r.status==='conflict'&&(r.service_observation!=='inactive'||r.current_state!==null)||r.status==='unknown'&&!(r.service_observation==='unverified'&&r.current_state===null||q.action==='confirm'&&r.service_observation==='inactive'&&r.current_state==='live-original')))refuse();}
  else if(!(q.action==='cancel'&&r===null)&&(r===null||r.status!==c.state||r.service_observation!=='inactive'||c.state==='unchanged'&&(r.possible_effect||r.current_state!=='live-original')||c.state==='unresolved'&&(r.current_state===null||q.action==='confirm'&&!r.possible_effect)))refuse();break;
 }
 case 'not-dispatched':if(r!==null&&(!match(['invalid-input','unavailable','unsupported','busy','conflict'],false)||r.current_state!==null))refuse();break;
 case 'busy':case 'unsupported':case 'unavailable':
  if(r!==null&&(!match(c.state==='unavailable'?['invalid-input','unavailable','conflict']:c.state,false)||r.current_state!==null||q.action==='confirm'))refuse();break;
 default:if(r!==null)refuse();
 }
 if(!['inspected','ready'].includes(c.state)&&c.preview!==null||q.action==='cancel'&&r!==null)refuse();return v;
}

export function parseManagementJson(raw){try{if(raw.byteLength>8192||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw).charCodeAt(0)===0xfeff)refuse();return strictJson(raw);}catch{return refuse();}}
