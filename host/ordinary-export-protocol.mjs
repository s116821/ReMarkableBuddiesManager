// Exact private producer wire and reduced safe companion projection.
import { basicDigest,basicUuid } from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const refuse=()=>{throw Error('Ordinary export refused');};
export const exportDigest=basicDigest,exportUuid=basicUuid;
export const EXPORT_CONFIG='/home/root/.config/remarkable-buddies/config.json';
export function exportPath(v){return typeof v==='string'&&v.isWellFormed()&&v.startsWith('/')&&v!=='/'&&!v.includes('\0')&&new TextEncoder().encode(v).length<=4096;}
export function parseExportRequest(v){
 if(!v||bytes(v)>16384)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!exportUuid(v.reference))refuse();}
 else {if(!['prepare','confirm','status'].includes(v.action)||!exportDigest(v.connection_id)||!exportUuid(v.boot_id))refuse();
 if(v.action==='prepare'){if(keys(v)!=='action,boot_id,connection_id,destination'||!exportPath(v.destination))refuse();}
 else if(keys(v)!=='action,boot_id,connection_id,reference'||!exportUuid(v.reference))refuse();}return v;
}
export function exportResponseContext(v){const {action,reference,connection_id,boot_id}=v;return {action,...reference?{reference}:{},...connection_id?{connection_id,boot_id}:{}};}
export function parseExportSummary(v){if(keys(v)!=='complete_media,configuration_included,format,manifests,objects'||v.format!==1||![v.manifests,v.objects].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=4096)||typeof v.complete_media!=='boolean'||typeof v.configuration_included!=='boolean')refuse();return {format:1,manifests:v.manifests,objects:v.objects,complete_media:v.complete_media,configuration_included:v.configuration_included};}
export function parseExportIntent(v){
 if(keys(v)!=='actor,archive_sha256,base_generation,base_history_sha256,complete_media,config_path_sha256,config_sha256,configuration_snapshot_sha256,destination_path_sha256,export_version,mode_sha256,operation'||v.export_version!==1||![v.operation,v.actor,v.base_generation].every(exportUuid)||![v.archive_sha256,v.base_history_sha256,v.config_path_sha256,v.config_sha256,v.destination_path_sha256,v.mode_sha256].every(exportDigest)||v.configuration_snapshot_sha256!==null&&!exportDigest(v.configuration_snapshot_sha256)||typeof v.complete_media!=='boolean')refuse();return {...v};
}
const statuses=['ok','invalid-input','unavailable','unsupported','busy','conflict','failed'];
const operations=['prepare','apply','status'];
const reduced=v=>({operation:v.operation,status:v.status,outcome:v.outcome,disk_readback_verified:v.disk_readback_verified,runtime_activation:v.runtime_activation});
function reportHeader(v,op){if(keys(v)!=='data,disk_readback_verified,operation,outcome,report_version,runtime_activation,status'||v.report_version!==1||!operations.includes(op)||v.operation!==op||!statuses.includes(v.status)||v.runtime_activation!=='unverified'||typeof v.disk_readback_verified!=='boolean'||bytes(v)+1>16384)refuse();}
export function parseExportReport(v,op,context){
 reportHeader(v,op);const out={report:reduced(v),summary:null,intent:null};
 if(v.status!=='ok'){const outcomes=op==='status'?['read-only']:op==='apply'&&v.status==='failed'?['not-dispatched','not-published','unknown']:['not-dispatched'];if(v.data!==null||v.disk_readback_verified!==false||!outcomes.includes(v.outcome))refuse();return out;}
 if(v.disk_readback_verified!==(op==='apply'))refuse();
 const d=v.data;
 if(op==='prepare'){
  if(v.outcome!=='prepared'||keys(d)!=='intent,source')refuse();out.summary=parseExportSummary(d.source);out.intent=parseExportIntent(d.intent);
  if(out.intent.complete_media!==out.summary.complete_media)refuse();
  if(context&&(out.intent.operation!==context.operation||out.intent.destination_path_sha256!==context.destination_path_sha256||out.intent.config_path_sha256!==context.config_path_sha256))refuse();
 }else if(op==='status'&&v.outcome==='unresolved'){if(d!==null)refuse();}
 else{
  if(v.outcome!==(op==='apply'?'verified':'desired-archive-observed')||keys(d)!=='archive_sha256,inspection'||!exportDigest(d.archive_sha256))refuse();out.summary=parseExportSummary(d.inspection);
  if(context){const intent=parseExportIntent(context.intent);if(d.archive_sha256!==intent.archive_sha256||JSON.stringify(out.summary)!==JSON.stringify(parseExportSummary(context.summary)))refuse();}
 }return out;
}
function publicReport(v){
 if(v===null)return null;if(keys(v)!=='disk_readback_verified,operation,outcome,runtime_activation,status')refuse();
 if(v.status!=='ok')return parseExportReport({report_version:1,...v,data:null},v.operation).report;
 if(!operations.includes(v.operation)||v.runtime_activation!=='unverified'||v.disk_readback_verified!==(v.operation==='apply')||!{prepare:['prepared'],apply:['verified'],status:['unresolved','desired-archive-observed']}[v.operation].includes(v.outcome))refuse();return {...v};
}
const allowed={prepare:['ready','invalidated','unsupported','unavailable','busy','capacity'],confirm:['verified','not-published','not-dispatched','unknown','unavailable','busy'],status:['desired-archive-observed','unresolved','unknown','unsupported','unavailable','busy'],cancel:['not-dispatched','unknown','unresolved','invalidated','unavailable'],retained:['none']};
export function parseExportResult(v,request,validate){
 if(keys(v)!=='contract_version,observation,ordinary_export,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!request.connection_id||v.observation.connection_id!==request.connection_id||v.observation.boot_id!==request.boot_id))refuse();
 const q=v.ordinary_export;if(keys(q)!=='reference,report,retained,state,summary'||!allowed[request.action]?.includes(q.state)||q.reference!==null&&!exportUuid(q.reference))refuse();
 const r=publicReport(q.report),summary=q.summary===null?null:parseExportSummary(q.summary);
 if(!Array.isArray(q.retained)||q.retained.length>8)refuse();const refs=new Set();for(const x of q.retained){if(keys(x)!=='boot_id,connection_id,reference,state'||!exportUuid(x.boot_id)||!exportUuid(x.reference)||!exportDigest(x.connection_id)||!['unknown','unresolved'].includes(x.state)||refs.has(x.reference))refuse();refs.add(x.reference);}
 if(['ready','verified','desired-archive-observed'].includes(q.state)){
  const pair={ready:'prepare|prepared',verified:'apply|verified','desired-archive-observed':'status|desired-archive-observed'}[q.state];if(!summary||!q.reference||v.status!=='observed'||r?.status!=='ok'||[r.operation,r.outcome].join('|')!==pair)refuse();
 }else if(summary!==null)refuse();
 if(r?.status==='ok'&&{prepared:'ready',verified:'verified','desired-archive-observed':'desired-archive-observed',unresolved:'unresolved'}[r.outcome]!==q.state)refuse();
 if(q.state==='unresolved'&&(r?.operation!=='status'||r?.outcome!=='unresolved'||r?.status!=='ok'))refuse();
 if(q.state==='not-published'&&(r?.operation!=='apply'||r?.status!=='failed'||r?.outcome!=='not-published'))refuse();
 if(q.state==='unknown'&&r!==null&&(r.operation!=='apply'||r.status!=='failed'||r.outcome!=='unknown'))refuse();
 if(q.state==='not-dispatched'&&r!==null&&(r.operation!=='apply'||r.outcome!=='not-dispatched'))refuse();
 if(['unknown','unresolved'].includes(q.state)&&(!q.reference||!refs.has(q.reference)))refuse();
 if(['none','invalidated','busy','capacity'].includes(q.state)&&r!==null)refuse();
 if(request.reference&&q.reference!==null&&q.reference!==request.reference)refuse();
 if(request.action==='retained'&&(q.reference!==null||q.summary!==null||r!==null||v.status!=='unconfigured'))refuse();return v;
}
