import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {portableKeys as keys,portableRefuse as fail,portableJson,parsePortableArtifact,portableCanonical,parsePortableOrigins,parsePortableNames,PORTABLE_CONFIG} from './portable-configuration-protocol.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
export const portableHash=v=>createHash('sha256').update(v).digest('hex');
export const portablePathHash=portableHash('remarkable-buddies-portable-import-path-v1\0'+PORTABLE_CONFIG);
const same=isDeepStrictEqual;
export function parsePortableIntent(v,expectedPath=portablePathHash){
 if(keys(v)!=='artifact_sha256,base_sha256,config_path_sha256,operation,portable_import_version,target_sha256'||v.portable_import_version!==1||!basicUuid(v.operation)||!['artifact_sha256','base_sha256','target_sha256','config_path_sha256'].every(k=>basicDigest(v[k]))||v.base_sha256===v.target_sha256||v.config_path_sha256!==expectedPath)fail();return {...v};
}
export function parsePortableReport(raw,op,c={}){
 const exportMode=op==='export',limit=exportMode?131072:16384;if(!raw.length||raw.at(-1)!==10||raw.filter(x=>x===10).length!==1)fail();
 const v=portableJson(raw,limit),report=exportMode?{status:v.status,runtime_activation:v.runtime_activation}:{status:v.status,outcome:v.outcome,disk_readback_verified:v.disk_readback_verified,runtime_activation:v.runtime_activation};
 if(v.report_version!==1||v.operation!==op||v.runtime_activation!=='unverified'||!['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'].includes(v.status))fail();
 if(keys(v)!==(exportMode?'artifact,operation,report_version,runtime_activation,status,summary':'data,disk_readback_verified,operation,outcome,report_version,runtime_activation,status'))fail();
 const out={report,intent:null,summary:null};
 if(exportMode){
  if(v.status!=='ok'){if(v.artifact!==null||v.summary!==null||!['invalid-input','unsupported','unavailable'].includes(v.status))fail();return out;}
  const a=parsePortableArtifact(v.artifact),s=v.summary;
  if(keys(s)!=='artifact_sha256,declared_settings,personalization_included'||s.artifact_sha256!==portableHash(portableCanonical(a))||s.declared_settings!==Object.keys(a.settings).length||s.personalization_included!==Object.hasOwn(a.settings,'personalization'))fail();
  const file=Buffer.from(portableCanonical(a)+'\n');if(file.length>131072)fail();out.file=file;out.summary={kind:'export',declared_settings:s.declared_settings,personalization_included:s.personalization_included};return out;
 }
 if(typeof v.disk_readback_verified!=='boolean')fail();
 if(v.status!=='ok'){
  const allowed=['inspect','status'].includes(op)?['read-only']:op==='apply'&&v.status==='failed'?['not-dispatched','unknown']:['not-dispatched'];
  if(v.data!==null||v.disk_readback_verified||!allowed.includes(v.outcome))fail();return out;
 }
 const d=v.data;if(v.disk_readback_verified!==(op==='apply'))fail();
 if(op==='inspect'){
  if(v.outcome!=='read-only'||keys(d)!=='base_sha256,config_path_sha256,current'||!basicDigest(d.base_sha256)||d.config_path_sha256!==(c.config_path_sha256??portablePathHash))fail();out.current=parsePortableOrigins(d.current);out.base_sha256=d.base_sha256;out.config_path_sha256=d.config_path_sha256;
 }else if(op==='prepare'){
  if(v.outcome==='no-change'){
   if(keys(d)!=='artifact_sha256,base_sha256,changed_settings'||d.base_sha256!==c.base_sha256||d.artifact_sha256!==c.artifact_sha256||!Array.isArray(d.changed_settings)||d.changed_settings.length)fail();out.summary={kind:'import',changed_settings:[],before:null,after:null};
  }else{
   if(v.outcome!=='prepared'||keys(d)!=='after,before,changed_settings,intent')fail();const intent=parsePortableIntent(d.intent,c.config_path_sha256??portablePathHash),before=parsePortableOrigins(d.before),after=parsePortableOrigins(d.after),names=parsePortableNames(d.changed_settings);
   if(intent.operation!==c.operation||intent.base_sha256!==c.base_sha256||intent.artifact_sha256!==c.artifact_sha256||!same(before,c.current)||names.some(k=>!Object.hasOwn(c.artifact.settings,k)))fail();
   for(const name of Object.keys(before))if(names.includes(name)){if(after[name]!== (c.artifact.settings[name]===null?'declared-null':'declared'))fail();}else if(before[name]!==after[name])fail();
   out.intent=intent;out.summary={kind:'import',changed_settings:names,before,after};
  }
 }else if(op==='apply'){
  if(v.outcome!=='verified'||keys(d)!=='changed_settings,target_sha256'||d.target_sha256!==c.intent.target_sha256||!same(parsePortableNames(d.changed_settings),c.summary.changed_settings))fail();out.summary=c.summary;
 }else if(op==='status'){
  if(!['desired-file-observed','unresolved'].includes(v.outcome)||keys(d)!=='observed_sha256'||!basicDigest(d.observed_sha256)||(d.observed_sha256===c.intent.target_sha256)!==(v.outcome==='desired-file-observed'))fail();out.summary=c.summary;
 }else fail();return out;
}
