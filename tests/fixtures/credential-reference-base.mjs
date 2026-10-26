import {addModelCredentialFixture} from './model-credential-base.mjs';
// Synthetic POSIX transport reports; never producer/device qualification.
import {createHash} from 'node:crypto';
import {CredentialReferenceHost} from '../../host/credential-reference.mjs';
import {CREDENTIAL_CONFIG} from '../../host/credential-reference-protocol.mjs';
import {tablet,defer} from './model-settings.mjs';
export {tablet,defer};
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const name='SYNTHETIC_Credential-01';
export const report=(operation,outcome,data=null,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:'unverified',data});
export const rawReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),credential_reference_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}});
const canonical=v=>v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const patchHash=v=>hash('urn:remarkable-buddies:credential-reference-patch:v1:'+JSON.stringify(canonical(v)));
export function addCredentialFixture(f,options={}){
 const rawRun=f.observer.run;let sequence=0,revision=0;
 const state={document:{model_credential:null,reader:'SYNTHETIC_READER_DRAFT',writer:'SYNTHETIC_WRITER_DRAFT'},hash:'9'.repeat(64),path:hash('urn:remarkable-buddies:credential-reference-path:v1:'+CREDENTIAL_CONFIG),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null,hooks:0,refusePrepare:false};
 const fields=raw=>({model_credential:{origin:!Object.hasOwn(raw,'model_credential')?'default':raw.model_credential===null?'declared-null':'declared',present:typeof raw.model_credential==='string'}});
 f.observer.run=async function(action,q){
  if(action!=='credential-reference')return rawRun.call(this,action,q);
  this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);f.calls.push({action,selector:q.selector,bytes,body,budget_ms:q.budget_ms});let r;
  if(q.selector==='inspect')r=report('inspect','read-only',{schema_version:1,base_sha256:state.hash,config_path_sha256:state.path,current:fields(state.document)});
  else if(q.selector==='prepare'){
   const next=structuredClone(state.document),change=body.change;if(change.action==='clear')delete next.model_credential;else next.model_credential=change.value;
   if(state.refusePrepare)r=report('prepare','not-dispatched',null,'invalid-input');
   else if(JSON.stringify(next)===JSON.stringify(state.document))r=report('prepare','no-change',{current:fields(state.document),base_sha256:state.hash,changes_sha256:patchHash(change)});
   else{const intent={credential_reference_version:1,operation:body.operation,base_sha256:state.hash,target_sha256:hash(JSON.stringify(next)+String(++revision)),config_path_sha256:state.path,changes_sha256:patchHash(change)};state.prepared.set(intent.operation,{intent,next});r=report('prepare','prepared',{before:fields(state.document),after:fields(next),intent});}
  }else if(q.selector==='apply'){
   const p=state.prepared.get(body.intent.operation);if(!p||patchHash(body.change)!==p.intent.changes_sha256)r=report('apply','not-dispatched',null,'conflict');else{state.document=structuredClone(p.next);state.hash=p.intent.target_sha256;r=report('apply','verified',{target_sha256:state.hash,current:fields(state.document)});}
  }else r=state.hash===body.intent.target_sha256?report('status','desired-file-observed',{observed_sha256:state.hash,current:fields(state.document)}):report('status','unresolved');
  const hook={inspect:state.onInspect,prepare:state.onPrepare,apply:state.onApply,status:state.onStatus}[q.selector];if(hook)r=await hook(r,body);return rawReply(r);
 };
 const credential=new CredentialReferenceHost({observer:f.observer,io:f.io,reference:()=>String(++sequence).padStart(64,'c'),...options}),lanes={...f.lanes,credential};
 for(const [name,host] of Object.entries(lanes))host.beforeIO=()=>{state.hooks++;f.researchState.hooks++;f.memoryState.hooks++;for(const [other,h] of Object.entries(lanes))if(other!==name)h.invalidate();};
 return addModelCredentialFixture({...f,credential,credentialState:state,lanes},options.modelCredential??{});
}
export const begin=async f=>(await f.credential.request({action:'begin',...identity})).credential_reference.reference;
export const save=(f,reference,change={action:'set',value:name})=>f.credential.request({action:'save',...identity,reference,change});
