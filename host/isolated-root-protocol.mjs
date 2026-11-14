import {parseSavedModeView} from './saved-mode.mjs';
import {localModeDigest,localModeUuid} from './local-mode-choice-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const refuse=()=>{throw Error('Isolated backup preparation response refused');};
const states=['none','ready','invalidated','unsupported','unavailable','busy','capacity','storage-unavailable','unknown','verified'];
const outcomes={
 'root-verified':['ok',false], 'outcome-unknown':['unavailable',true],
 'authorization-required':['unavailable',true], 'retry-later':['unavailable',true],
 'recovery-required':['failed',true], 'provider-binding-unqualified':['unsupported',false]
};
export function parseIsolatedRootRequest(v){
 if(!v||bytes(v)>512)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference,wait_id'||!localModeDigest(v.reference)||!localModeUuid(v.wait_id))refuse();}
 else if(!['begin','prepare','retry'].includes(v.action)||!localModeDigest(v.connection_id)||!localModeUuid(v.boot_id)||
  !localModeUuid(v.wait_id)||keys(v)!==(v.action==='begin'?'action,boot_id,connection_id,wait_id':'action,boot_id,connection_id,reference,wait_id')||
  v.action!=='begin'&&!localModeDigest(v.reference))refuse();
 return v;
}
function saved(value){
 parseSavedModeView({status:'ok',incomplete:false,snapshot:value});return value;
}
export function parseIsolatedRootResult(v,q,validate){
 if(keys(v)!=='contract_version,isolated_root_preparation,observation,status'||bytes(v)>8192)refuse();
 validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!q?.connection_id||v.observation.connection_id!==q.connection_id||v.observation.boot_id!==q.boot_id))refuse();
 const s=v.isolated_root_preparation;
 if(keys(s)!=='preview,reference,report,retained,state'||!states.includes(s.state)||s.reference!==null&&!localModeDigest(s.reference)||
  !Array.isArray(s.retained)||s.retained.length>8)refuse();
 const refs=new Set();
 for(const r of s.retained){
  if(keys(r)!=='backup,boot_id,connection_id,device,epoch,reference,state'||![r.reference,r.connection_id].every(localModeDigest)||
   ![r.boot_id,r.device,r.backup,r.epoch].every(localModeUuid)||!['unknown','verified'].includes(r.state)||refs.has(r.reference))refuse();
  refs.add(r.reference);
 }
 const retained=s.retained.find(r=>r.reference===s.reference);
 if(['none','invalidated','capacity','storage-unavailable'].includes(s.state)&&s.reference!==null)refuse();
 if(['unknown','verified'].includes(s.state)&&(!retained||retained.state!==s.state))refuse();
 if(s.state==='ready'){
  if(!s.reference||s.preview===null||saved(s.preview).kind!=='isolated-backup'||s.report!==null||v.status!=='observed'||retained)refuse();
 }else if(s.preview!==null)refuse();
 if(s.report!==null){
  const r=s.report;
  if(!retained||!['prepare','retry'].includes(q?.action)||v.status!=='observed'||
   retained.connection_id!==q.connection_id||retained.boot_id!==q.boot_id||
   !['unknown','verified'].includes(s.state)||keys(r)!=='current,incomplete,result,status'||
   !['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'].includes(r.status)||typeof r.incomplete!=='boolean')refuse();
  if(r.current!==null)saved(r.current);
  if(r.result===null){if(r.status==='ok'||s.state!=='unknown')refuse();}
  else{
   const t=r.result;
   if(keys(t)!=='backup,currency,device,epoch,outcome'||![t.device,t.backup,t.epoch].every(localModeUuid)||
    typeof t.outcome!=='string'||!Object.hasOwn(outcomes,t.outcome)||!['current','historical'].includes(t.currency)||
    t.device!==retained.device||t.backup!==retained.backup||t.epoch!==retained.epoch||r.current===null||r.current.device!==t.device||
    r.current.kind==='unconfigured'||t.currency!==(r.current.epoch===t.epoch?'current':'historical')||
    t.currency==='current'&&(r.current.kind!=='isolated-backup'||r.current.backup!==t.backup))refuse();
   const [status,incomplete]=outcomes[t.outcome];
   if(r.status!==status||r.incomplete!==incomplete||s.state!==(t.outcome==='root-verified'?'verified':'unknown'))refuse();
  }
 }
 if(q?.reference&&s.reference!==null&&q.reference!==s.reference)refuse();
 if(q?.action==='retained'&&(!['none','storage-unavailable'].includes(s.state)||s.reference!==null||s.report!==null||v.status!=='unconfigured'))refuse();
 return v;
}
