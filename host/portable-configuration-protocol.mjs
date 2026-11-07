// Closed file/bridge schema. No destination overlay or Config writer lives here.
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
export const PORTABLE_NAMES=['personalization','product_settings','research_policy'];
export const PORTABLE_CONFIG='/home/root/.config/remarkable-buddies/config.json';
export const PORTABLE_FILE='remarkable-buddies-preferences.json';
export const portableKeys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
export const portableBytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
export const portableRefuse=()=>{throw Error('Portable preferences refused');};
const fail=portableRefuse,keys=portableKeys,bytes=portableBytes;
export function portableJson(raw,limit){
 try{
 if(!(raw instanceof Uint8Array)||raw.length>limit)fail();
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(text.charCodeAt(0)===0xfeff)fail();
 // Protocol numbers are integers. Check lexemes before JS can normalize 1.0/1e0.
 const outside=text.replace(/"(?:[^"\\]|\\.)*"/gs,'""');
 if((outside.match(/-?\d[\d.eE+-]*/g)??[]).some(v=>!/^\d+$/.test(v)))fail();
 return strictJson(raw);
 }catch{fail();}
}

const text=v=>typeof v==='string'&&v.isWellFormed();
export function parsePortableArtifact(v){
 if(keys(v)!=='portable_configuration_version,settings'||v.portable_configuration_version!==1||!v.settings||typeof v.settings!=='object'||Array.isArray(v.settings)||Object.keys(v.settings).some(k=>!PORTABLE_NAMES.includes(k)))fail();
 for(const [name,value] of Object.entries(v.settings)){
  if(name==='research_policy'){if(![null,'required','disabled'].includes(value))fail();continue;}
  if(value===null){if(name!=='product_settings')fail();continue;}
  const allowed=name==='product_settings'?['schema_version','reader_enabled','writer_enabled','export_destination']:['schema_version','enabled','text'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail();
  for(const [key,x] of Object.entries(value)){
   if(key==='schema_version'){if(x!==1)fail();}
   else if(['reader_enabled','writer_enabled','enabled'].includes(key)){if(typeof x!=='boolean')fail();}
   else if(key==='export_destination'){if(!['mem','disabled'].includes(x))fail();}
   else if(!text(x)||x.includes('\0')||new TextEncoder().encode(x).length>16384)fail();
  }
 }
 if(bytes(v)>131072)fail();return v;
}
export function portableCanonical(v){
 if(v===null||typeof v!=='object')return JSON.stringify(v);
 if(Array.isArray(v))fail();return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+portableCanonical(v[k])).join(',')+'}';
}
export function portableBase64(v,limit=131072){
 if(typeof v!=='string'||v.length>Math.ceil(limit/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))fail();
 let decoded;try{decoded=atob(v);}catch{fail();}if(decoded.length>limit||btoa(decoded)!==v)fail();
 return Uint8Array.from(decoded,c=>c.charCodeAt(0));
}
export function portableArtifactBytes(raw){return parsePortableArtifact(portableJson(raw,131072));}
function portableRequest(v){
 if(!v||bytes(v)>196608)fail();
 if(v.action==='retained'){if(keys(v)!=='action')fail();}
 else if(v.action==='cancel'){if(keys(v)!=='action,reference'||!basicDigest(v.reference))fail();}
 else{
  if(!['export','prepare','confirm','status'].includes(v.action)||!basicDigest(v.connection_id)||!basicUuid(v.boot_id))fail();
  const wanted=v.action==='prepare'?'action,artifact_base64,boot_id,connection_id':v.action==='export'?'action,boot_id,connection_id':'action,boot_id,connection_id,reference';if(keys(v)!==wanted)fail();
  if(v.action==='prepare'){const raw=portableBase64(v.artifact_base64);try{portableArtifactBytes(raw);}finally{raw.fill(0);}}
  else if(v.action!=='export'&&!basicDigest(v.reference))fail();
 }return v;
}
export function parsePortableRequest(v){try{return portableRequest(v);}catch{fail();}}
export function portableContext(v){const {action,connection_id,boot_id,reference}=v;return {action,...connection_id?{connection_id,boot_id}:{},...reference?{reference}:{}};}
export function parsePortableOrigins(v){if(keys(v)!==PORTABLE_NAMES.join()||!Object.values(v).every(x=>['absent','declared','declared-null'].includes(x))||v.personalization==='declared-null')fail();return {...v};}
export function parsePortableNames(v,empty=false){if(!Array.isArray(v)||(!empty&&!v.length)||v.length>3||v.some(x=>!PORTABLE_NAMES.includes(x))||JSON.stringify(v)!==JSON.stringify([...new Set(v)].sort()))fail();return [...v];}
const statuses=['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'];
const outcomes=['read-only','prepared','no-change','verified','desired-file-observed','unresolved','not-dispatched','unknown'];
export function parsePortableSummary(v){
 if(v?.kind==='export'){if(keys(v)!=='declared_settings,kind,personalization_included'||!Number.isInteger(v.declared_settings)||v.declared_settings<0||v.declared_settings>3||typeof v.personalization_included!=='boolean'||(v.personalization_included&&v.declared_settings===0))fail();}
 else {if(keys(v)!=='after,before,changed_settings,kind'||v.kind!=='import')fail();parsePortableNames(v.changed_settings,true);if(v.changed_settings.length){parsePortableOrigins(v.before);parsePortableOrigins(v.after);}else if(v.before!==null||v.after!==null)fail();}return v;
}
const states={export:['exported','invalidated','unsupported','unavailable','busy'],prepare:['ready','no-change','invalidated','unsupported','unavailable','not-dispatched','busy','capacity'],confirm:['verified','not-dispatched','unknown','unavailable','busy'],status:['desired-file-observed','unresolved','unknown','unsupported','unavailable','busy'],cancel:['invalidated','not-dispatched','unknown','unresolved','unavailable'],retained:['none']};
function portableResult(v,q,validate){
 if(keys(v)!=='contract_version,observation,portable_configuration,status'||bytes(v)>(q.action==='export'?196608:8192))fail();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(v.observation.connection_id!==q.connection_id||v.observation.boot_id!==q.boot_id))fail();
 const p=v.portable_configuration;if(keys(p)!=='export_file,reference,report,retained,state,summary'||!states[q.action]?.includes(p.state)||p.reference!==null&&!basicDigest(p.reference))fail();
 if(q.reference&&p.reference!==null&&p.reference!==q.reference)fail();
 if(!Array.isArray(p.retained)||p.retained.length>8)fail();const refs=new Set();
 for(const r of p.retained){if(keys(r)!=='boot_id,connection_id,reference,state'||!basicUuid(r.boot_id)||!basicDigest(r.connection_id)||!basicDigest(r.reference)||!['unknown','unresolved'].includes(r.state)||refs.has(r.reference))fail();refs.add(r.reference);}
 if(['unknown','unresolved'].includes(p.state)&&(!p.reference||!refs.has(p.reference)))fail();
 if(['none','exported','no-change','invalidated','capacity'].includes(p.state)&&p.reference!==null)fail();
 if(p.summary!==null)parsePortableSummary(p.summary);
 if(p.report!==null){const r=p.report;if(!statuses.includes(r.status)||r.runtime_activation!=='unverified')fail();if(q.action==='export'){if(keys(r)!=='runtime_activation,status')fail();}else if(keys(r)!=='disk_readback_verified,outcome,runtime_activation,status'||!outcomes.includes(r.outcome)||typeof r.disk_readback_verified!=='boolean'||r.disk_readback_verified!==(r.outcome==='verified')||r.outcome==='verified'&&r.status!=='ok')fail();}
 const successful=['exported','ready','no-change','verified','desired-file-observed','unresolved'].includes(p.state);
 if(successful){if(v.status!=='observed'||p.report?.status!=='ok')fail();if(p.state==='exported'){if(p.summary?.kind!=='export'||keys(p.export_file)!=='bytes_base64,name'||p.export_file.name!==PORTABLE_FILE)fail();const raw=portableBase64(p.export_file.bytes_base64);try{const a=portableArtifactBytes(raw);if(p.summary.declared_settings!==Object.keys(a.settings).length||p.summary.personalization_included!==Object.hasOwn(a.settings,'personalization'))fail();}finally{raw.fill(0);}}
 else {if(p.export_file!==null||p.summary?.kind!=='import'||p.report.outcome!=={ready:'prepared','no-change':'no-change',verified:'verified','desired-file-observed':'desired-file-observed',unresolved:'unresolved'}[p.state])fail();if((p.state==='no-change')!==(p.summary.changed_settings.length===0))fail();if(p.state!=='no-change'&&!p.reference)fail();}}
 else if(p.summary!==null||p.export_file!==null||p.report?.status==='ok'||v.status!=='unconfigured')fail();
 if(p.state==='unknown'&&p.report!==null&&(p.report.status!=='failed'||p.report.outcome!=='unknown'))fail();
 if(p.state==='not-dispatched'&&p.report!==null&&p.report.outcome!=='not-dispatched')fail();
 if(['none','invalidated','busy','capacity'].includes(p.state)&&p.report!==null)fail();
 if(q.action==='retained'&&(v.status!=='unconfigured'||p.reference!==null))fail();return v;
}

export function parsePortableResult(v,q,validate){try{return portableResult(v,q,validate);}catch{fail();}}
