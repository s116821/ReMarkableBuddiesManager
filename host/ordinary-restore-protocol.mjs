// Safe public DTOs only. Original paths and producer conditions stay host-private.
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const exact=(v,k)=>keys(v)===k.split(' ').sort().join();
const refuse=()=>{throw Error('Ordinary restore refused');};
const size=v=>{try{return new TextEncoder().encode(JSON.stringify(v)).length;}catch{return refuse();}};
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=4096;
export function restorePath(v){return typeof v==='string'&&v.isWellFormed()&&v.startsWith('/')&&v!=='/'&&!v.endsWith('/')&&!v.includes('\0')&&!v.split('/').some(p=>p==='.'||p==='..')&&new TextEncoder().encode(v).length<=4096;}
export function restoreSummary(v){if(!exact(v,'manifests objects complete_media configuration_included')||!count(v.manifests)||!count(v.objects)||typeof v.complete_media!=='boolean'||typeof v.configuration_included!=='boolean')refuse();return {manifests:v.manifests,objects:v.objects,complete_media:v.complete_media,configuration_included:v.configuration_included};}
export function restorePreview(v){if(!exact(v,'source target additional_manifests additive configuration_applied')||!count(v.additional_manifests)||v.additive!==true||v.configuration_applied!==false)refuse();const source=restoreSummary(v.source),target=restoreSummary(v.target);if(v.additional_manifests>source.manifests||v.additional_manifests>target.manifests||source.configuration_included!==target.configuration_included)refuse();return {source,target,additional_manifests:v.additional_manifests,additive:true,configuration_applied:false};}
export function parseRestoreRequest(v){
 if(v?.action==='retained'){if(!exact(v,'action'))refuse();}
 else{
  if(!['prepare','confirm','status','cancel'].includes(v?.action)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||!basicUuid(v.invocation))refuse();
  if(v.action==='prepare'){if(size(v)>16384||!exact(v,'action connection_id boot_id invocation source')||!restorePath(v.source))refuse();}
  else if(size(v)>512||!exact(v,'action connection_id boot_id invocation reference')||!basicDigest(v.reference))refuse();
 }return {...v};
}
export function restoreResponseContext(v){const {action,connection_id,boot_id,invocation,reference}=v;return {action,...connection_id?{connection_id,boot_id,invocation}:{},...reference?{reference}:{}};}
const outcomes={prepare:['prepared'],apply:['restored'],status:['desired-generation-observed','unresolved']};
const refusal=['invalid-input','unavailable','unsupported','busy','conflict','failed'];
export function restorePublicReport(r,selector){
 if(!exact(r,'operation status outcome disk_readback_verified runtime_activation')||r.operation!==selector||r.runtime_activation!=='unverified'||typeof r.disk_readback_verified!=='boolean')refuse();
 if(r.status==='ok'){if(!outcomes[selector]?.includes(r.outcome)||r.disk_readback_verified!==(selector==='apply'))refuse();}
 else if(!refusal.includes(r.status)||r.disk_readback_verified||!(r.outcome==='not-dispatched'||selector==='apply'&&r.status==='failed'&&['not-activated','unknown'].includes(r.outcome)))refuse();return {...r};
}
export function parseRestoreResult(v,request,validate){
 let q;if(request?.action==='prepare'&&!('source' in request)){if(!exact(request,'action connection_id boot_id invocation')||!basicDigest(request.connection_id)||!basicUuid(request.boot_id)||!basicUuid(request.invocation))refuse();q={...request};}else q=parseRestoreRequest(request);if(size(v)>8192||!exact(v,'contract_version status observation ordinary_restore'))refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 const c=v.ordinary_restore;if(!exact(c,'state reference preview inspection report apply_outcome retained')||!Array.isArray(c.retained)||c.retained.length>8)refuse();
 const refs=new Set();for(const row of c.retained){if(!exact(row,'reference connection_id boot_id state apply_outcome status_available')||!basicDigest(row.reference)||refs.has(row.reference)||!basicDigest(row.connection_id)||!basicUuid(row.boot_id)||!['unknown','not-activated','unresolved'].includes(row.state)||!['unknown','not-activated'].includes(row.apply_outcome)||row.state==='not-activated'&&row.apply_outcome!=='not-activated'||typeof row.status_available!=='boolean')refuse();refs.add(row.reference);}
 const allowed={retained:['none'],prepare:['ready','invalidated','capacity','busy','unsupported','unavailable'],confirm:['restored','not-dispatched','not-activated','unknown','capacity','busy','unavailable'],status:['desired-generation-observed','unresolved','capacity','busy','unsupported','unavailable'],cancel:['invalidated','not-dispatched','not-activated','unknown','unresolved','unavailable']};
 if(!allowed[q.action].includes(c.state)||c.reference!==null&&!basicDigest(c.reference)||c.apply_outcome!==null&&!['not-dispatched','not-activated','unknown','restored'].includes(c.apply_outcome))refuse();
 if(q.action==='retained'){if(c.reference!==null||c.preview!==null||c.inspection!==null||c.report!==null||c.apply_outcome!==null)refuse();}
 else if(q.action==='prepare'){if(c.state==='ready'?!basicDigest(c.reference):c.reference!==null)refuse();if(c.apply_outcome!==null)refuse();}
 else if(c.reference!==q.reference)refuse();
 const row=c.retained.find(r=>r.reference===c.reference);if(row&&(!same(row,q)||c.apply_outcome!==row.apply_outcome))refuse();
 if(['ready','restored','desired-generation-observed'].includes(c.state)&&row)refuse();
 const r=c.report;
 if(r===null){if(v.status!=='unconfigured'||v.observation!==null)refuse();}
 else{restorePublicReport(r,{prepare:'prepare',confirm:'apply',status:'status'}[q.action]);if(v.status!=='observed'||!same(q,v.observation))refuse();}
 if(c.preview!==null){if(c.state!=='ready')refuse();restorePreview(c.preview);}
 if(c.inspection!==null){if(!['restored','desired-generation-observed'].includes(c.state))refuse();restoreSummary(c.inspection);}
 const is=(status,outcome)=>r?.status===status&&r?.outcome===outcome;
 switch(c.state){
 case 'ready':if(!is('ok','prepared')||c.preview===null||c.inspection!==null)refuse();break;
 case 'restored':if(!is('ok','restored')||c.inspection===null||c.apply_outcome!=='restored')refuse();break;
 case 'desired-generation-observed':if(!is('ok',c.state)||c.inspection===null||!['unknown','not-activated'].includes(c.apply_outcome))refuse();break;
 case 'unresolved':if(!row||row.state!=='unresolved'||!(q.action==='cancel'&&r===null)&&!is('ok','unresolved'))refuse();break;
 case 'not-activated':if(!row||row.state!=='not-activated'||c.apply_outcome!=='not-activated'||!(q.action==='cancel'&&r===null)&&!is('failed','not-activated'))refuse();break;
 case 'unknown':if(!row||row.state!=='unknown'||c.apply_outcome!=='unknown'||r!==null&&!is('failed','unknown'))refuse();break;
 case 'not-dispatched':if(r!==null&&(r.outcome!=='not-dispatched'||r.status==='ok')||c.apply_outcome!==null&&c.apply_outcome!=='not-dispatched')refuse();break;
 case 'busy':case 'unsupported':case 'unavailable':if(r!==null&&(r.outcome!=='not-dispatched'||r.status==='ok'||c.state==='busy'&&r.status!=='busy'||c.state==='unsupported'&&r.status!=='unsupported'||q.action==='confirm'))refuse();break;
 default:if(r!==null||c.apply_outcome!==null&&!row)refuse();
 }
 if(q.action==='cancel'&&r!==null)refuse();return v;
}
export function parseRestoreJson(raw){try{if(raw.byteLength>8192||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw).charCodeAt(0)===0xfeff)refuse();return strictJson(raw);}catch{return refuse();}}
