// Public safe DTOs only. No producer intent, content digest or transport selector.
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const refuse=()=>{throw Error('Cache cleanup response refused');};
const size=v=>{try{const s=JSON.stringify(v);if(typeof s!=='string')refuse();return new TextEncoder().encode(s).length;}catch{return refuse();}};
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export function parseCleanupRequest(v){
 if(size(v)>384)refuse();
 if(v?.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v?.action==='cancel'){if(keys(v)!=='action,invocation,reference'||!basicDigest(v.reference)||!basicUuid(v.invocation))refuse();}
 else{
  if(!['prepare','confirm','status'].includes(v?.action)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||!basicUuid(v.invocation))refuse();
  if(v.action==='prepare'){if(keys(v)!=='action,boot_id,connection_id,document,invocation'||!basicUuid(v.document))refuse();}
  else if(keys(v)!=='action,boot_id,connection_id,invocation,reference'||!basicDigest(v.reference))refuse();
 }return {...v};
}
const refusal=['unsupported','busy','unavailable','invalid-input'];
export function parseCleanupResult(v,request,validate){
 const q=parseCleanupRequest(request);if(keys(v)!=='contract_version,observation,source_cache_cleanup,status'||size(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 const c=v.source_cache_cleanup;if(keys(c)!=='preview,reference,report,retained,state'||!Array.isArray(c.retained)||c.retained.length>8)refuse();
 const refs=new Set();for(const row of c.retained){if(keys(row)!=='boot_id,connection_id,document,reference,state,status_available'||!basicDigest(row.reference)||refs.has(row.reference)||!basicDigest(row.connection_id)||!basicUuid(row.boot_id)||!basicUuid(row.document)||!['unknown','unchanged','conflict'].includes(row.state)||typeof row.status_available!=='boolean')refuse();refs.add(row.reference);}
 if(c.reference!==null&&!basicDigest(c.reference))refuse();
 if(q.action==='retained'){if(c.state!=='none'||c.reference!==null||c.preview!==null||c.report!==null)refuse();}
 else if(q.action==='prepare'){if(c.state==='ready'?!basicDigest(c.reference):c.reference!==null)refuse();}
 else if(c.reference!==q.reference)refuse();
 const r=c.report;
 if(r===null){if(v.status!=='unconfigured'||v.observation!==null)refuse();}
 else{
  if(keys(r)!=='operation,possible_effect,runtime_unverified,status'||r.runtime_unverified!==true||r.operation!==({prepare:'prepare',confirm:'apply',status:'status'})[q.action]||typeof r.possible_effect!=='boolean'||v.status!=='observed'||!same(q,v.observation))refuse();
 }
 const match=(operation,status,effect)=>r!==null&&r.operation===operation&&(Array.isArray(status)?status.includes(r.status):r.status===status)&&r.possible_effect===effect;
 const nullReport=r===null;
 switch(c.state){
 case 'none':if(q.action!=='retained')refuse();break;
 case 'ready':if(q.action!=='prepare'||!match('prepare','prepared',false)||keys(c.preview)!=='document,entry_bytes'||c.preview.document!==q.document||!Number.isSafeInteger(c.preview.entry_bytes)||c.preview.entry_bytes<1||c.preview.entry_bytes>33554432)refuse();break;
 case 'applied':if(q.action!=='confirm'||!match('apply','applied',true))refuse();break;
 case 'absent':if(!['prepare','confirm'].includes(q.action)||!match(q.action==='prepare'?'prepare':'apply','absent',false))refuse();break;
 case 'absent-observed':if(q.action!=='status'||!match('status','absent',false))refuse();break;
 case 'unknown':case 'unchanged':case 'conflict':{
  const row=c.retained.find(x=>x.reference===c.reference);if(!row||row.state!==c.state||!['confirm','status','cancel'].includes(q.action))refuse();
  if(c.state==='unknown'){if(!['confirm','cancel'].includes(q.action)||!nullReport&&!match('apply','unknown',true))refuse();}
  else if(!(q.action==='cancel'&&nullReport)&&!match('status',c.state,false))refuse();break;
 }
 case 'not-dispatched':if(!['confirm','cancel'].includes(q.action)||!nullReport&&!match('apply',[...refusal,'conflict'],false))refuse();break;
 case 'invalidated':if(!['prepare','cancel'].includes(q.action)||!nullReport)refuse();break;
 case 'capacity':if(!['prepare','confirm','status'].includes(q.action)||!nullReport)refuse();break;
 case 'busy':case 'unsupported':case 'unavailable':
  if(c.state==='busy'&&!['prepare','confirm','status'].includes(q.action)||c.state==='unsupported'&&!['prepare','status'].includes(q.action))refuse();
  if(q.action==='retained'||!nullReport&&(!['prepare','status'].includes(q.action)||!match(q.action,c.state==='unavailable'?['conflict','unavailable','invalid-input']:c.state,false)))refuse();break;
 default:refuse();
 }
 if(c.state!=='ready'&&c.preview!==null)refuse();if(q.action==='cancel'&&r!==null)refuse();return v;
}
