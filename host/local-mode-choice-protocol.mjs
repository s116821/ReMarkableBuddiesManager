import {parseSavedModeReport,parseSavedModeView} from './saved-mode.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
export const localModeDigest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const localModeUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
const refuse=()=>{throw Error('Local-only choice response refused');};
const statuses=['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'];
const states=['none','ready','invalidated','unsupported','unavailable','busy','capacity','refused','acknowledged','unknown'];
export function parseLocalModeRequest(v){
 if(!v||bytes(v)>512)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!localModeDigest(v.reference))refuse();}
 else{
  if(!['begin','choose','refresh'].includes(v.action)||!localModeDigest(v.connection_id)||!localModeUuid(v.boot_id)||keys(v)!==(v.action==='begin'?'action,boot_id,connection_id':'action,boot_id,connection_id,reference')||v.action!=='begin'&&!localModeDigest(v.reference))refuse();
 }return v;
}
export function parseLocalModeOriginal(v){
 if(keys(v)!=='choice,expected,operation'||!localModeUuid(v.operation)||keys(v.expected)!=='actor,sha256'||!localModeUuid(v.expected.actor)||!localModeDigest(v.expected.sha256)||keys(v.choice)!=='kind'||v.choice.kind!=='local-only')refuse();
 return {operation:v.operation,expected:{actor:v.expected.actor,sha256:v.expected.sha256},choice:{kind:'local-only'}};
}
function snapshot(v){
 const report={report_version:1,operation:'inspect',status:'ok',incomplete:false,activation_performed:false,data:{current_snapshot:v,receipt:null,receipt_status:null}};
 return parseSavedModeReport(report).snapshot;
}
export function parseLocalModeReport(v,operation,context=null){
 if(keys(v)!=='activation_performed,data,incomplete,operation,report_version,status'||v.report_version!==1||!['inspect','choose'].includes(operation)||v.operation!==operation||!statuses.includes(v.status)||typeof v.incomplete!=='boolean'||v.activation_performed!==false||bytes(v)+1>16384)refuse();
 const out={status:v.status,incomplete:v.incomplete,current:null,token:null,receipt:null};
 if(v.data===null){if(v.status==='ok')refuse();return out;}
 const d=v.data;if(keys(d)!=='current_snapshot,receipt,receipt_status')refuse();out.current=snapshot(d.current_snapshot);out.token={...d.current_snapshot.token};
 if(v.status==='ok'&&v.incomplete)refuse();
 if(operation==='inspect'||v.status!=='ok'){
  if(d.receipt!==null||d.receipt_status!==null)refuse();return out;
 }
 const original=parseLocalModeOriginal(context?.original),r=d.receipt;
 if(keys(r)!=='epoch,expected,mode,operation,request_sha256'||!localModeUuid(r.epoch)||r.operation!==original.operation||r.expected!==original.expected.sha256||!localModeDigest(r.request_sha256)||r.request_sha256!==context.request_sha256||keys(r.mode)!=='kind'||r.mode.kind!=='local-only'||out.token.actor!==original.expected.actor)refuse();
 const current=out.current.kind==='local-only'&&out.current.epoch===r.epoch;
 if(d.receipt_status!==(current?'current':'historical'))refuse();
 out.receipt={kind:'local-only',epoch:r.epoch,historical:!current};return out;
}
function currentView(v){if(v===null)return null;parseSavedModeView({status:'ok',incomplete:false,snapshot:v});return v;}
export function parseLocalModeResult(v,q,validate){
 if(keys(v)!=='contract_version,local_mode_choice,observation,status'||bytes(v)>8192)refuse();
 validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!q?.connection_id||v.observation.connection_id!==q.connection_id||v.observation.boot_id!==q.boot_id))refuse();
 const s=v.local_mode_choice;if(keys(s)!=='current,receipt,reference,retained,state'||!states.includes(s.state)||s.reference!==null&&!localModeDigest(s.reference))refuse();
 currentView(s.current);if(s.current!==null&&v.status!=='observed')refuse();
 if(s.receipt!==null&&(keys(s.receipt)!=='epoch,historical,kind'||s.receipt.kind!=='local-only'||!localModeUuid(s.receipt.epoch)||typeof s.receipt.historical!=='boolean'||s.state!=='acknowledged'))refuse();
 if(s.receipt&&s.current&&s.receipt.historical!==(s.current.kind!=='local-only'||s.current.epoch!==s.receipt.epoch))refuse();
 if(!Array.isArray(s.retained)||s.retained.length>8)refuse();const refs=new Set();for(const r of s.retained){if(keys(r)!=='boot_id,connection_id,reference,state'||![r.reference,r.connection_id].every(localModeDigest)||!localModeUuid(r.boot_id)||!['unknown','acknowledged','refused'].includes(r.state)||refs.has(r.reference))refuse();refs.add(r.reference);}
 if(s.state==='ready'&&(!s.reference||!s.current||s.receipt!==null||v.status!=='observed'))refuse();
 if(s.state==='acknowledged'&&(!s.reference||!s.receipt||!s.retained.some(r=>r.reference===s.reference&&r.state==='acknowledged')))refuse();
 if(s.state==='unknown'&&(!s.reference||s.receipt!==null||!s.retained.some(r=>r.reference===s.reference&&r.state==='unknown')))refuse();
 if(s.state!=='acknowledged'&&s.receipt!==null)refuse();
 if(['none','invalidated','capacity'].includes(s.state)&&s.reference!==null)refuse();
 if(s.state==='ready'&&s.retained.some(r=>r.state==='unknown'&&r.connection_id===v.observation.connection_id))refuse();
 if(!['ready','acknowledged','unknown'].includes(s.state)&&s.current!==null)refuse();
 if(q?.reference&&s.reference!==null&&q.reference!==s.reference)refuse();
 if(q?.action==='retained'&&(s.state!=='none'||s.reference!==null||s.current!==null||s.receipt!==null||v.status!=='unconfigured'))refuse();return v;
}
