import {isDeepStrictEqual} from 'node:util';
// Deliberately synthetic producer transport. No filesystem/device operation.
import {ModelCredentialHost} from '../../host/model-credential.mjs';
import {CONFIG,hash} from '../../host/model-credential-private.mjs';
import {tablet} from './model-settings.mjs';
export const rawReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),model_credential_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}});
export const report=(operation,outcome,data=null,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:'unverified',data});
export function addModelCredentialFixture(f,options={}){
 const previous=f.observer.run;let sequence=0;
 const state={binding:{config_sha256:'a'.repeat(64),config_path_sha256:hash('urn:remarkable-buddies:model-credential-config-path:v1:'+CONFIG),credential_path_sha256:'c'.repeat(64),parent_identity_sha256:'d'.repeat(64),state:{kind:'absent'}},onInspect:null,onPrepare:null,onApply:null,onStatus:null,hooks:0};
 f.observer.run=async function(action,q){
  if(action!=='model-credential')return previous.call(this,action,q);
  this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);f.calls.push({action,selector:q.selector,bytes,body,budget_ms:q.budget_ms});let r;
  if(q.selector==='inspect')r=report('inspect','read-only',{schema_version:1,binding:structuredClone(state.binding)});
  else if(q.selector==='prepare'){
   const b=structuredClone(state.binding),c=body.change,p=b.state.kind==='present';
   if(c.action==='install'&&p||c.action==='replace'&&!p)r=report('prepare','not-dispatched',null,'conflict');
   else if(c.action==='remove'&&!p||c.action==='replace'&&hash(c.value)===b.state.sha256)r=report('prepare','no-change',{binding:b});
   else r=report('prepare','prepared',{intent:{credential_version:1,operation:body.operation,base:b,action:c.action,target:c.action==='remove'?{kind:'absent'}:{kind:'present',sha256:hash(c.value),mode:c.action==='install'?384:b.state.mode}}});
  }else if(q.selector==='apply'){
   const i=body.intent;if(!isDeepStrictEqual(i.base,state.binding))r=report('apply','not-dispatched',null,'conflict');
   else{state.binding.state=i.target.kind==='absent'?{kind:'absent'}:{...i.target,metadata_sha256:'e'.repeat(64)};r=report('apply','verified',{present:i.target.kind==='present'});}
  }else{const i=body.intent,actual=state.binding.state,desired=i.target,sameLocation=['config_sha256','config_path_sha256','credential_path_sha256','parent_identity_sha256'].every(k=>i.base[k]===state.binding[k]);r=!sameLocation?report('status','read-only',null,'conflict'):actual.kind===desired.kind&&(actual.kind==='absent'||actual.sha256===desired.sha256&&actual.mode===desired.mode)?report('status','desired-file-observed',{present:desired.kind==='present'}):report('status','unresolved');}
  const hook={inspect:state.onInspect,prepare:state.onPrepare,apply:state.onApply,status:state.onStatus}[q.selector];if(hook)r=await hook(r,body);return rawReply(r);
 };
 const modelCredential=new ModelCredentialHost({observer:f.observer,io:f.io,reference:()=>String(++sequence).padStart(64,'f'),...options}),lanes={...f.lanes,modelCredential};
 for(const [name,h] of Object.entries(lanes))h.beforeIO=()=>{state.hooks++;f.credentialState.hooks++;f.memoryState.hooks++;f.researchState.hooks++;for(const [other,peer] of Object.entries(lanes))if(other!==name)peer.invalidate();};
 return {...f,modelCredential,modelCredentialState:state,lanes};
}
