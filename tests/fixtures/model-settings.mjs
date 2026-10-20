import {createHash} from 'node:crypto';
import {ModelSettingsHost} from '../../host/model-settings.mjs';
import {modelPatchJson,changedModelFields} from '../../host/model-settings-protocol.mjs';
import {basicFixture,identity,tablet,defer,report} from './basic-settings.mjs';
export {identity,tablet,defer,report};
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const patchHash=v=>hash('urn:remarkable-buddies:model-settings-patch:v1:'+modelPatchJson(v));
export function modelFixture(options={}){
 const f=basicFixture(),rawRun=f.observer.run;let revision=0,sequence=0;
 const state={current:{base_url:{origin:'declared-null',present:false},model:{origin:'declared',present:true}},values:{model:'old synthetic value'},hash:'7'.repeat(64),path:'8'.repeat(64),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null};
 f.observer.run=async function(action,q){
  if(action!=='model-settings')return rawRun.call(this,action,q);this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);f.calls.push({action,selector:q.selector,bytes,body,budget_ms:q.budget_ms});let r;
  if(q.selector==='inspect'){r=report('inspect','read-only',{schema_version:1,base_sha256:state.hash,config_path_sha256:state.path,current:structuredClone(state.current)});if(state.onInspect)r=await state.onInspect(r,body);}
  else if(q.selector==='prepare'){
   const after=changedModelFields(state.current,body.changes),values={...state.values};for(const [k,c] of Object.entries(body.changes)){if(c.action==='clear')delete values[k];else values[k]=c.value;}
   if(JSON.stringify(after)===JSON.stringify(state.current)&&JSON.stringify(values)===JSON.stringify(state.values))r=report('prepare','no-change',{current:structuredClone(state.current),base_sha256:state.hash,changes_sha256:patchHash(body.changes)});
   else {const intent={model_settings_version:1,operation:body.operation,base_sha256:body.base_sha256,target_sha256:hash(JSON.stringify(values)+String(++revision)),config_path_sha256:body.config_path_sha256,changes_sha256:patchHash(body.changes)};state.prepared.set(intent.operation,{intent,after,values});r=report('prepare','prepared',{before:structuredClone(state.current),after,intent});}
   if(state.onPrepare)r=await state.onPrepare(r,body);
  }else if(q.selector==='apply'){
   const p=state.prepared.get(body.intent.operation);if(p){state.current=structuredClone(p.after);state.values=structuredClone(p.values);state.hash=p.intent.target_sha256;}r=report('apply','verified',{target_sha256:state.hash,current:structuredClone(state.current)});if(state.onApply)r=await state.onApply(r,body);
  }else{r=state.hash===body.intent.target_sha256?report('status','desired-file-observed',{observed_sha256:state.hash,current:structuredClone(state.current)}):report('status','unresolved',null);if(state.onStatus)r=await state.onStatus(r,body);}
  const output=typeof r==='string'?r:JSON.stringify(r)+'\n';return {contract_version:1,status:'observed',observation:structuredClone(tablet),model_raw:{status:'reported',stdout_base64:Buffer.from(output).toString('base64')}};
 };
 const model=new ModelSettingsHost({observer:f.observer,io:f.io,beforeIO:()=>{f.basic.invalidate();f.forget.invalidate();},reference:()=>String(++sequence).padStart(64,'f'),...options});
 f.basic.beforeIO=()=>{f.forget.invalidate();model.invalidate();};f.forget.beforeIO=()=>{f.basic.invalidate();model.invalidate();};return {...f,model,modelState:state};
}
export const begin=async f=>(await f.model.request({action:'begin',...identity})).model_settings.reference;
export const save=(f,reference,changes={model:{action:'set',value:'NEW_PRIVATE_MODEL'}})=>f.model.request({action:'save',...identity,reference,changes});
