import { createHash } from 'node:crypto';
import { ProductSettingsHost } from '../../host/product-settings.mjs';
import { MemoryForgetHost } from '../../host/memory-forget.mjs';
import { MaintenanceIO } from '../../host/maintenance-io.mjs';
import { changedProductFields } from '../../host/product-settings-protocol.mjs';
import { tablet,prepared,ack,failure,rawReply } from './memory-forget.mjs';
export { tablet };
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export const report=(operation,outcome,data,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:operation==='apply'&&status==='ok'?'restart-required':'unverified',data});
export function productFixture(options={}){
 const calls=[],io=new MaintenanceIO();let sequence=0,revision=0;
 const state={current:{export_destination:{origin:'default',value:'mem'},reader_enabled:{origin:'default',value:true},writer_enabled:{origin:'default',value:true}},hash:'5'.repeat(64),path:'6'.repeat(64),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null,forgetLost:false,cancelled:null};
 const observer={lastObservation:structuredClone(tablet),generation:0,cancels:0,cancel(){this.generation++;this.cancels++;state.cancelled?.();return {contract_version:1,status:'cancelled',observation:null};},async observe(){this.lastObservation=structuredClone(tablet);return {contract_version:1,status:'observed',observation:this.lastObservation};},async run(action,q){
  this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);calls.push({action,selector:q.selector,bytes,body,budget_ms:q.budget_ms});
  if(action==='memory-forget')return rawReply(q.selector==='prepare-forget'?await prepared(body.operation,body.key):state.forgetLost&&q.selector==='forget'?failure('forget','unavailable',true,'unknown'):ack(q.selector,body.intent.operation));
  if(action!=='product-settings')throw Error('Unexpected fixture action');let r;
  if(q.selector==='inspect'){r=report('inspect','read-only',{schema_version:1,base_sha256:state.hash,config_path_sha256:state.path,current:structuredClone(state.current)});if(state.onInspect)r=await state.onInspect(r);}
  else if(q.selector==='prepare'){
   const after=changedProductFields(state.current,body.changes);if(JSON.stringify(after)===JSON.stringify(state.current))r=report('prepare','no-change',{current:structuredClone(state.current),base_sha256:state.hash});else{
    const intent={product_settings_version:1,operation:body.operation,base_sha256:body.base_sha256,target_sha256:createHash('sha256').update(JSON.stringify(after)+String(++revision)).digest('hex'),config_path_sha256:body.config_path_sha256,changes:body.changes};state.prepared.set(intent.operation,{intent,after});r=report('prepare','prepared',{before:structuredClone(state.current),after,intent});
   }if(state.onPrepare)r=await state.onPrepare(r,body);
  }else if(q.selector==='apply'){
   const p=state.prepared.get(body.intent.operation);state.current=structuredClone(p.after);state.hash=body.intent.target_sha256;r=report('apply','verified',{target_sha256:state.hash,current:structuredClone(state.current)});if(state.onApply)r=await state.onApply(r,body);
  }else{
   r=report('status',state.hash===body.intent.target_sha256?'desired-file-observed':'unresolved',{observed_sha256:state.hash,current:structuredClone(state.current)});if(state.onStatus)r=await state.onStatus(r,body);
  }
  return {contract_version:1,status:'observed',observation:structuredClone(tablet),product_settings_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(r)+'\n').toString('base64')}};
 }};
 let product;const forget=new MemoryForgetHost({observer,io,beforeIO:()=>product?.invalidate()});product=new ProductSettingsHost({observer,io,beforeIO:()=>forget.invalidate(),reference:()=>String(++sequence).padStart(64,'0'),...options});return {state,calls,observer,io,product,forget,wrapped:forget.wrap()};
}
export async function begin(f){return (await f.product.request({action:'begin',...identity})).product_settings.reference;}
export const save=(f,reference,changes={reader_enabled:{action:'set',value:false}})=>f.product.request({action:'save',...identity,reference,changes});
// Compose the new producer fixture with the existing15-lane host harness.
export function addProductFixture(f){const p=productFixture(),previous=f.observer.run;f.productState=p.state;f.productCalls=p.calls;f.observer.run=async function(action,q){if(action!=='product-settings')return previous.call(this,action,q);f.calls.push({action,selector:q.selector});return p.observer.run.call(this,action,q);};return f;}
