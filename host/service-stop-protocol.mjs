import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const fail=()=>{throw Error('Service stop refused');};
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const reasons=[null,'busy','unsupported','unavailable','invalid-response','cancelled','expired','session-changed','capacity','lifecycle-unqualified'];
const kinds=['inactive','active','transitioning','failed'];
export function parseServiceStopRequest(v){
 if(!v||bytes(v)>512)fail();
 if(v.action==='retained'){if(keys(v)!=='action')fail();}
 else if(v.action==='cancel'){if(keys(v)!=='action,invocation,reference'||!basicDigest(v.reference)||v.invocation!==null&&!basicUuid(v.invocation))fail();}
 else if(v.action==='begin'){if(keys(v)!=='action,boot_id,connection_id'||!basicDigest(v.connection_id)||!basicUuid(v.boot_id))fail();}
 else if(!['confirm','refresh'].includes(v.action)||keys(v)!=='action,boot_id,connection_id,invocation,reference'||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||!basicDigest(v.reference)||!basicUuid(v.invocation))fail();
 return {...v};
}
export function parseServiceStopResult(v,request,validate){
 const q=parseServiceStopRequest(request),action=q.action;if(keys(v)!=='contract_version,observation,service_stop,status'||bytes(v)>8192)fail();
 validate({contract_version:v.contract_version,status:v.status,observation:v.observation});const s=v.service_stop;
 if(keys(s)!=='current,invocation,reason,reference,retained,state'||!['none','ready','invalidated','expired','busy','unavailable','unsupported','capacity','request-accepted','unknown'].includes(s.state)||s.reference!==null&&!basicDigest(s.reference)||s.invocation!==null&&!basicUuid(s.invocation)||!reasons.includes(s.reason))fail();
 if(s.state==='none'&&action!=='retained')fail();
 if(q.reference&&s.reference!==q.reference||q.invocation!==undefined&&s.invocation!==q.invocation)fail();
 if(!Array.isArray(s.retained)||s.retained.length>8)fail();const seen=new Set();
 for(const r of s.retained){if(keys(r)!=='boot_id,connection_id,outcome,reason,reference'||!basicDigest(r.reference)||!basicDigest(r.connection_id)||!basicUuid(r.boot_id)||!['request-accepted','unknown'].includes(r.outcome)||!reasons.includes(r.reason)||r.outcome==='request-accepted'&&r.reason!==null||r.outcome==='unknown'&&r.reason===null||seen.has(r.reference))fail();seen.add(r.reference);}
 const original=s.retained.find(r=>r.reference===s.reference),history=['request-accepted','unknown'].includes(s.state),use=action==='confirm'||action==='refresh',current=s.current!==null;
 if(history&&(original?.outcome!==s.state||action==='begin'&&(s.state==='request-accepted'||original.connection_id!==q.connection_id)||use&&(original.connection_id!==q.connection_id||original.boot_id!==q.boot_id)))fail();
 if(current&&(!use||!history||action==='confirm'&&s.state!=='request-accepted'||keys(s.current)!=='state'||!kinds.includes(s.current.state)))fail();
 if(s.state==='ready'&&(action!=='begin'||!s.reference||s.invocation!==null||current||s.reason!==null||v.status!=='observed'||s.retained.some(r=>r.outcome==='unknown'&&r.connection_id===q.connection_id)))fail();
 if(v.status==='observed'){
  if(!v.observation||q.connection_id&&v.observation.connection_id!==q.connection_id||q.boot_id&&v.observation.boot_id!==q.boot_id||s.state!=='ready'&&!current)fail();
 }else if(v.status!=='unconfigured'||v.observation!==null||current)fail();
 if(action==='begin'&&s.invocation!==null)fail();
 if(action==='retained'&&(s.state!=='none'||s.reference!==null||s.invocation!==null||current||s.reason!==null||v.status!=='unconfigured'))fail();
 return v;
}
