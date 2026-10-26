// Confidential submissions and safe responses only. No private report/intent decoder.
import {basicDigest as digest,basicUuid as uuid} from './basic-settings-protocol.mjs';
export const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
export const refuse=()=>{throw Error('Model credential response refused');};
export const bytes=v=>{try{const s=JSON.stringify(v);if(typeof s!=='string')return refuse();return new TextEncoder().encode(s).length;}catch{return refuse();}};
export const modelCredentialText=v=>typeof v==='string'&&![...v].some(c=>c.codePointAt(0)>=0xd800&&c.codePointAt(0)<=0xdfff)&&new TextEncoder().encode(v).length<=8192&&/[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(v);
export function parseModelCredentialChange(v){if(v?.action==='remove'&&keys(v)==='action')return {action:'remove'};if(['install','replace'].includes(v?.action)&&keys(v)==='action,value'&&modelCredentialText(v.value))return {action:v.action,value:v.value};return refuse();}
export function parseModelCredentialRequest(v){
 if(!v||bytes(v)>16384)refuse();
 if(v.action==='retained'){if(keys(v)!=='action')refuse();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!digest(v.reference))refuse();}
 else{if(!['begin','save','status'].includes(v.action)||!digest(v.connection_id)||!uuid(v.boot_id))refuse();const wanted=v.action==='begin'?'action,boot_id,connection_id':v.action==='save'?'action,boot_id,change,connection_id,reference':'action,boot_id,connection_id,reference';if(keys(v)!==wanted||v.action!=='begin'&&!digest(v.reference))refuse();if(v.action==='save')parseModelCredentialChange(v.change);}return v;
}
export function modelCredentialContext(v){const {action,reference,connection_id,boot_id}=v;return {action,...reference?{reference}:{},...connection_id?{connection_id,boot_id}:{}};}
export function parseModelCredentialCurrent(v){if(keys(v)!=='present'||typeof v.present!=='boolean')refuse();return {present:v.present};}
export function modelCredentialReport(r){
 if(r===null)return null;
 if(keys(r)!=='disk_readback_verified,operation,outcome,runtime_activation,status'||!['inspect','prepare','apply','status'].includes(r.operation)||!['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'].includes(r.status)||r.runtime_activation!=='unverified')refuse();
 const outcomes=r.status==='ok'?{inspect:['read-only'],prepare:['prepared','no-change'],apply:['verified'],status:['desired-file-observed','unresolved']}[r.operation]:['inspect','status'].includes(r.operation)?['read-only']:r.operation==='apply'&&r.status==='failed'?['not-dispatched','unknown']:['not-dispatched'];
 if(!outcomes.includes(r.outcome)||r.disk_readback_verified!==(r.status==='ok'&&r.operation==='apply'))refuse();return {...r};
}
const states=['none','ready','invalidated','unsupported','unavailable','busy','capacity','not-dispatched','no-change','verified','unknown','unresolved','desired-file-observed'];
export function parseModelCredentialResult(v,request,validate){
 if(keys(v)!=='contract_version,model_credential,observation,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(!request?.connection_id||v.observation.connection_id!==request.connection_id||v.observation.boot_id!==request.boot_id))refuse();
 const q=v.model_credential;if(keys(q)!=='current,reference,report,retained,state'||!states.includes(q.state)||q.reference!==null&&!digest(q.reference))refuse();const report=modelCredentialReport(q.report),current=q.current===null?null:parseModelCredentialCurrent(q.current);
 const allowed={begin:['ready','invalidated','unsupported','unavailable','busy','capacity'],save:['verified','no-change','not-dispatched','unknown','capacity','unavailable','busy'],status:['desired-file-observed','unresolved','unknown','unavailable','busy'],cancel:['not-dispatched','unknown','unresolved','invalidated','unavailable'],retained:['none']};if(!allowed[request?.action]?.includes(q.state))refuse();
 if(!Array.isArray(q.retained)||q.retained.length>8)refuse();const refs=new Set();for(const x of q.retained){if(keys(x)!=='boot_id,connection_id,reference,state,status_available'||!uuid(x.boot_id)||![x.reference,x.connection_id].every(digest)||!['unknown','unresolved'].includes(x.state)||typeof x.status_available!=='boolean'||refs.has(x.reference))refuse();refs.add(x.reference);}
 if(['ready','no-change','verified','desired-file-observed'].includes(q.state)){
  const expected={ready:'inspect|read-only','no-change':'prepare|no-change',verified:'apply|verified','desired-file-observed':'status|desired-file-observed'}[q.state];if(!current||!q.reference||v.status!=='observed'||report?.status!=='ok'||[report.operation,report.outcome].join('|')!==expected)refuse();
 }
 if(report?.status==='ok'){const expected={'read-only':'ready','no-change':'no-change',verified:'verified','desired-file-observed':'desired-file-observed',unresolved:'unresolved'}[report.outcome];if(!expected||q.state!==expected)refuse();}
 if(current!==null&&v.status!=='observed'||q.state==='not-dispatched'&&report?.outcome==='unknown')refuse();
 if(report?.status!=='ok'&&report?.operation==='apply'&&report?.outcome==='not-dispatched'&&q.state==='unknown')refuse();
 if(['unknown','unresolved'].includes(q.state)&&(!q.reference||!refs.has(q.reference)||request?.connection_id&&q.retained.some(x=>x.reference===q.reference&&(x.connection_id!==request.connection_id||x.boot_id!==request.boot_id))))refuse();
 if(q.state==='unknown'&&report!==null&&(report.operation!=='apply'||report.status!=='failed'||report.outcome!=='unknown'))refuse();
 if(q.state==='unresolved'&&(report?.operation!=='status'||report.status!=='ok'||report.outcome!=='unresolved'))refuse();
 if(['none','invalidated','unsupported','unavailable','busy','capacity','not-dispatched','unknown','unresolved'].includes(q.state)&&current!==null)refuse();
 if(request?.reference&&q.reference!==null&&q.reference!==request.reference)refuse();
 if(request?.action==='retained'&&(q.state!=='none'||q.reference!==null||current!==null||report!==null||v.status!=='unconfigured'))refuse();return v;
}
