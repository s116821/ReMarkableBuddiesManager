import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const fail=()=>{throw Error('Package transition refused');};
export const packageKeys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const operations=['disable','remove','replace'];
const states=['none','ready','busy','unavailable','unsupported','expired','invalidated','unknown','continuable','completed'];
const reasons=[null,'busy','unsupported','unavailable','invalid-response','cancelled','expired','session-changed','capacity','lifecycle-unqualified','candidate-unavailable','recovery-pending','continuation-required'];
const version=v=>v===null||typeof v==='string'&&v.length<=64&&/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-r(0|[1-9][0-9]*)$/.test(v);
export function parseResidentPackageRequest(v){
 if(!v||bytes(v)>512)fail();
 if(v.action==='retained'){if(packageKeys(v)!=='action')fail();}
 else if(v.action==='begin'){if(packageKeys(v)!=='action,boot_id,connection_id,operation'||!operations.includes(v.operation)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id))fail();}
 else if(v.action==='cancel'){if(packageKeys(v)!=='action,invocation,reference'||!basicDigest(v.reference)||v.invocation!==null&&!basicUuid(v.invocation))fail();}
 else if(!['confirm','refresh','resume'].includes(v.action)||packageKeys(v)!=='action,boot_id,connection_id,invocation,reference'||!basicDigest(v.reference)||!basicUuid(v.invocation)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id))fail();
 return {...v};
}
export function packageCurrent(v,operation){
 if(packageKeys(v)!=='candidate_version,data_preserved,installed_version,outcome,phase'||!['review','stop','recovery','disable','package'].includes(v.phase)||!['ready','pending','prepared','disabled','removed','replaced'].includes(v.outcome)||v.data_preserved!==true||!version(v.installed_version)||!version(v.candidate_version)||operation!=='replace'&&v.candidate_version!==null)fail();
 if(v.outcome==='ready'&&v.phase!=='review'||v.outcome==='prepared'&&v.phase!=='recovery'||v.outcome==='disabled'&&v.phase!=='disable')fail();
 if(v.outcome==='removed'&&(operation!=='remove'||v.phase!=='package')||v.outcome==='replaced'&&(operation!=='replace'||v.phase!=='package')||v.outcome==='disabled'&&!['disable','package'].includes(v.phase))fail();return v;
}
export function parseResidentPackageResult(v,q,validate){
 q=parseResidentPackageRequest(q);if(packageKeys(v)!=='contract_version,observation,resident_package,status'||bytes(v)>8192)fail();
 validate({contract_version:v.contract_version,status:v.status,observation:v.observation});const s=v.resident_package;
 if(packageKeys(s)!=='current,invocation,operation,reason,reference,retained,state'||!states.includes(s.state)||s.operation!==null&&!operations.includes(s.operation)||s.reference!==null&&!basicDigest(s.reference)||s.invocation!==null&&!basicUuid(s.invocation)||!reasons.includes(s.reason)||!Array.isArray(s.retained)||s.retained.length>8)fail();
 const seen=new Set();for(const r of s.retained){if(packageKeys(r)!=='boot_id,connection_id,operation,reason,reference,state'||!basicDigest(r.reference)||!basicDigest(r.connection_id)||!basicUuid(r.boot_id)||!operations.includes(r.operation)||!['unknown','continuable','completed'].includes(r.state)||!reasons.includes(r.reason)||r.state==='completed'&&r.reason!==null||r.state==='unknown'&&r.reason===null||r.state==='continuable'&&r.reason!=='continuation-required'||seen.has(r.reference))fail();seen.add(r.reference);}
 if(q.reference&&s.reference!==q.reference||q.action==='begin'&&s.operation!==q.operation||q.invocation!==undefined&&!(q.action==='resume'&&s.state==='ready')&&s.invocation!==q.invocation)fail();
 if(q.action==='retained'){if(s.state!=='none'||s.operation!==null||s.reference!==null||s.invocation!==null||s.current!==null||s.reason!==null)fail();}
 else if(s.operation===null)fail();
 if(s.state==='none'&&q.action!=='retained'||s.state==='ready'&&(!['begin','resume'].includes(q.action)||!s.reference||s.reason!==null))fail();
 if(s.state==='ready'&&(!s.current||q.action==='begin'&&s.current.outcome!=='ready'||q.action==='resume'&&!['prepared','disabled'].includes(s.current.outcome)))fail();
 const row=s.retained.find(r=>r.reference===s.reference);
 if(s.state==='ready'&&q.action==='resume'&&(!basicUuid(s.invocation)||s.invocation===q.invocation))fail();
 if(s.state==='ready'&&(q.action==='begin'&&row||q.action==='resume'&&(!row||row.state!=='continuable'||row.operation!==s.operation||row.connection_id!==q.connection_id||row.boot_id!==q.boot_id)))fail();
 if(['unknown','continuable','completed'].includes(s.state)&&(!row||row.state!==s.state||row.reason!==s.reason||row.operation!==s.operation||q.connection_id&&row.connection_id!==q.connection_id||q.boot_id&&row.boot_id!==q.boot_id))fail();
 if(s.current!==null){packageCurrent(s.current,s.operation);if(v.status!=='observed'||!['ready','continuable','completed','unknown'].includes(s.state))fail();}
 if(s.state==='completed'&&(s.reason!==null||!s.current||s.current.outcome!==({disable:'disabled',remove:'removed',replace:'replaced'})[s.operation]))fail();
 if(s.state==='continuable'&&(s.reason!=='continuation-required'||!s.current||!['prepared','disabled'].includes(s.current.outcome)))fail();
 if(v.status==='observed'){if(!s.current||q.connection_id&&v.observation.connection_id!==q.connection_id||q.boot_id&&v.observation.boot_id!==q.boot_id)fail();}else if(v.status!=='unconfigured'||v.observation!==null||s.current!==null)fail();
 return v;
}
