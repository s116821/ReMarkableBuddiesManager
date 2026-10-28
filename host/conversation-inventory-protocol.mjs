// Public identity-only request and reduced read-only conversation discovery view.
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const refuse=()=>{throw Error('Conversation inventory response refused');};
const bytes=v=>{try{const s=JSON.stringify(v);if(typeof s!=='string')return refuse();return new TextEncoder().encode(s).length;}catch{return refuse();}};
export function parseConversationRequest(v){if(keys(v)!=='boot_id,connection_id'||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||bytes(v)>256)refuse();return {connection_id:v.connection_id,boot_id:v.boot_id};}
export function parseConversationView(v){
 if(keys(v)!=='candidate_count,candidates,complete,eligibility_evaluated,local_only,mutation_authority,native_authority,physical_reclamation,runtime_unverified,service_observation,status'||!['complete','too-large','unsupported','busy','unavailable','conflict'].includes(v.status)||v.eligibility_evaluated!==false||v.mutation_authority!==false||v.native_authority!==false||v.runtime_unverified!==true||v.physical_reclamation!==false||v.local_only!==true)refuse();
 if(v.status==='complete'){
  if(v.complete!==true||v.service_observation!=='inactive'||!Array.isArray(v.candidates)||v.candidates.length>16||!Number.isSafeInteger(v.candidate_count)||v.candidate_count!==v.candidates.length)refuse();let previous=null;
  for(const id of v.candidates){if(!basicUuid(id)||previous!==null&&previous>=id)refuse();previous=id;}
 }else if(v.complete!==false||v.candidates!==null||v.candidate_count!==null||v.service_observation!=='unverified')refuse();
 return {status:v.status,complete:v.complete,candidates:v.candidates===null?null:[...v.candidates],candidate_count:v.candidate_count,eligibility_evaluated:false,mutation_authority:false,native_authority:false,runtime_unverified:true,physical_reclamation:false,local_only:true,service_observation:v.service_observation};
}
export function parseConversationResult(v,request,validate){
 const q=parseConversationRequest(request);if(keys(v)!=='contract_version,conversation_inventory,observation,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});const c=v.conversation_inventory;
 if(keys(c)!=='status,view'||!['reported','unsupported','unavailable','busy'].includes(c.status))refuse();
 if(c.status==='reported'){if(v.status!=='observed'||v.observation.connection_id!==q.connection_id||v.observation.boot_id!==q.boot_id)refuse();parseConversationView(c.view);}
 else if(c.view!==null||v.status!=='unconfigured'||v.observation!==null)refuse();return v;
}
