// HOST ONLY: real bindings, intents and all their hashes are confidential.
import {createHash} from 'node:crypto';
import {basicDigest as digest,basicUuid as uuid} from './basic-settings-protocol.mjs';
import {keys,bytes,refuse,parseModelCredentialChange,parseModelCredentialCurrent,modelCredentialReport} from './model-credential-protocol.mjs';
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const CONFIG='/home/root/.config/remarkable-buddies/config.json';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const mode=v=>v===256||v===384;
export function state(v,metadata=false){
 if(v?.kind==='absent'&&keys(v)==='kind')return {kind:'absent'};
 if(v?.kind==='present'&&keys(v)===(metadata?'kind,metadata_sha256,mode,sha256':'kind,mode,sha256')&&digest(v.sha256)&&mode(v.mode)&&(!metadata||digest(v.metadata_sha256)))return {kind:'present',sha256:v.sha256,...metadata?{metadata_sha256:v.metadata_sha256}:{},mode:v.mode};refuse();
}
export function binding(v){if(keys(v)!=='config_path_sha256,config_sha256,credential_path_sha256,parent_identity_sha256,state'||![v.config_sha256,v.config_path_sha256,v.credential_path_sha256,v.parent_identity_sha256].every(digest))refuse();return {config_sha256:v.config_sha256,config_path_sha256:v.config_path_sha256,credential_path_sha256:v.credential_path_sha256,parent_identity_sha256:v.parent_identity_sha256,state:state(v.state,true)};}
export function target(base,change){
 const b=binding(base),c=parseModelCredentialChange(change),present=b.state.kind==='present';
 if(c.action==='remove')return {kind:'absent'};
 if(c.action==='install'&&present||c.action==='replace'&&!present)refuse();
 return {kind:'present',sha256:hash(Buffer.from(c.value,'utf8')),mode:c.action==='install'?384:b.state.mode};
}
export function intent(v){
 if(keys(v)!=='action,base,credential_version,operation,target'||v.credential_version!==1||!uuid(v.operation)||!['install','replace','remove'].includes(v.action))refuse();const b=binding(v.base),t=state(v.target),present=b.state.kind==='present';
 if(v.action==='remove'&&(!present||t.kind!=='absent')||v.action==='install'&&(present||t.kind!=='present'||t.mode!==384)||v.action==='replace'&&(!present||t.kind!=='present'||t.mode!==b.state.mode||t.sha256===b.state.sha256))refuse();return {credential_version:1,operation:v.operation,base:b,action:v.action,target:t};
}
export function parseModelCredentialReport(v,operation,context={}){
 if(keys(v)!=='data,disk_readback_verified,operation,outcome,report_version,runtime_activation,status'||v.report_version!==1||v.operation!==operation||bytes(v)+1>16384)refuse();
 const {data,report_version,...safe}=v;void report_version;const report=modelCredentialReport(safe),out={report,current:null,binding:null,intent:null};if(v.status!=='ok'){if(data!==null)refuse();return out;}
 if(operation==='inspect'){if(keys(data)!=='binding,schema_version'||data.schema_version!==1)refuse();out.binding=binding(data.binding);out.current={present:out.binding.state.kind==='present'};}
 else if(operation==='prepare'){
  const base=binding(context.base),c=parseModelCredentialChange(context.change),desired=target(base,c);
  if(v.outcome==='no-change'){if(keys(data)!=='binding'||!eq(binding(data.binding),base)||!((c.action==='remove'&&base.state.kind==='absent')||(c.action==='replace'&&desired.sha256===base.state.sha256)))refuse();out.current={present:base.state.kind==='present'};out.binding=base;}
  else{if(v.outcome!=='prepared'||keys(data)!=='intent')refuse();const i=intent(data.intent);if(i.operation!==context.operation||i.action!==c.action||!eq(i.base,base)||!eq(i.target,desired))refuse();out.intent=i;}
 }else{
  const i=intent(context.intent);if(operation==='status'&&v.outcome==='unresolved'){if(data!==null)refuse();}
  else{out.current=parseModelCredentialCurrent(data);if(out.current.present!==(i.target.kind==='present'))refuse();}
 }return out;
}
