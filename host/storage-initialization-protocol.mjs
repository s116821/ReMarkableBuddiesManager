import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const fail=()=>{throw Error('Storage preparation refused');};
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const reasons=[null,'busy','unsupported','unavailable','invalid-response','cancelled','expired','session-changed','capacity'];
const kinds=['unconfigured','local-only','isolated-backup','shared-group'];
export function parseStorageInitializationRequest(v){
 if(!v||bytes(v)>512)fail();
 if(v.action==='retained'){if(keys(v)!=='action')fail();}
 else if(v.action==='cancel'){if(keys(v)!=='action,invocation,reference'||!basicDigest(v.reference)||v.invocation!==null&&!basicUuid(v.invocation))fail();}
 else if(v.action==='begin'){if(keys(v)!=='action,boot_id,connection_id'||!basicDigest(v.connection_id)||!basicUuid(v.boot_id))fail();}
 else if(!['confirm','refresh'].includes(v.action)||keys(v)!=='action,boot_id,connection_id,invocation,reference'||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||!basicDigest(v.reference)||!basicUuid(v.invocation))fail();
 return {...v};
}
export function parseStorageInitializationResult(v,request,validate){
 const q=parseStorageInitializationRequest(request);if(keys(v)!=='contract_version,observation,status,storage_initialization'||bytes(v)>8192)fail();
 validate({contract_version:v.contract_version,status:v.status,observation:v.observation});const s=v.storage_initialization;
 if(keys(s)!=='current,invocation,reason,reference,retained,state'||!['none','ready','invalidated','expired','busy','unavailable','unsupported','capacity','prepared','unknown'].includes(s.state)||s.reference!==null&&!basicDigest(s.reference)||s.invocation!==null&&!basicUuid(s.invocation)||!reasons.includes(s.reason))fail();
 if(q.reference&&s.reference!==q.reference||q.invocation!==undefined&&s.invocation!==q.invocation)fail();
 if(!Array.isArray(s.retained)||s.retained.length>8)fail();const seen=new Set();
 for(const r of s.retained){if(keys(r)!=='boot_id,connection_id,outcome,reason,reference'||!basicDigest(r.reference)||!basicDigest(r.connection_id)||!basicUuid(r.boot_id)||!['prepared','unknown'].includes(r.outcome)||!reasons.includes(r.reason)||r.outcome==='prepared'&&r.reason!==null||r.outcome==='unknown'&&r.reason===null||seen.has(r.reference))fail();seen.add(r.reference);}
 const original=s.retained.find(r=>r.reference===s.reference);
 if(['prepared','unknown'].includes(s.state)&&original?.outcome!==s.state)fail();
 if(s.state==='ready'&&q.action!=='begin'||q.action==='begin'&&s.state==='prepared'||s.current!==null&&!['confirm','refresh'].includes(q.action))fail();
 if(q.action==='begin'&&s.state==='unknown'&&original?.connection_id!==q.connection_id)fail();
 if(s.current!==null&&(keys(s.current)!=='kind'||!kinds.includes(s.current.kind)||!['prepared','unknown'].includes(s.state)||v.status!=='observed'))fail();
 if(s.current!==null&&(original?.connection_id!==v.observation?.connection_id||original?.boot_id!==v.observation?.boot_id))fail();
 if(s.state==='ready'&&(!s.reference||s.invocation!==null||s.current!==null||s.reason!==null||v.status!=='observed'||s.retained.some(r=>r.outcome==='unknown'&&r.connection_id===q.connection_id)))fail();
 if(v.status==='observed'){
  if(!v.observation||q.connection_id&&v.observation.connection_id!==q.connection_id||q.boot_id&&v.observation.boot_id!==q.boot_id||s.state!=='ready'&&s.current===null)fail();
 }else if(v.status!=='unconfigured'||v.observation!==null||s.current!==null)fail();
 if(q.action==='begin'&&s.invocation!==null)fail();
 if(q.action==='retained'&&(s.state!=='none'||s.reference!==null||s.invocation!==null||s.current!==null||s.reason!==null||v.status!=='unconfigured'))fail();
 return v;
}
