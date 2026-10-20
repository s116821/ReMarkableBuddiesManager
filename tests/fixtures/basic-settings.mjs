import { createHash } from 'node:crypto';
import { BasicSettingsHost } from '../../host/basic-settings.mjs';
import { MemoryForgetHost } from '../../host/memory-forget.mjs';
import { MaintenanceIO } from '../../host/maintenance-io.mjs';
import { changedBasicFields } from '../../host/basic-settings-protocol.mjs';
import { tablet,prepared,ack,failure,rawReply } from './memory-forget.mjs';
export { tablet };
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export const report=(operation,outcome,data,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:operation==='apply'&&status==='ok'?'restart-required':'unverified',data});
export function basicFixture(options={}){
 const calls=[],io=new MaintenanceIO();let sequence=0,revision=0;
 const state={current:{debug_dump:{origin:'default',value:null},log_level:{origin:'declared-null',value:null},trigger_corner:{origin:'declared',value:'UR'}},hash:'5'.repeat(64),path:'6'.repeat(64),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null,forgetLost:false,cancelled:null};
 const observer={lastObservation:structuredClone(tablet),generation:0,cancels:0,cancel(){this.generation++;this.cancels++;state.cancelled?.();return {contract_version:1,status:'cancelled',observation:null};},async observe(){this.lastObservation=structuredClone(tablet);return {contract_version:1,status:'observed',observation:this.lastObservation};},async run(action,q){
  this.cancel();const bytes=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=bytes===null?null:JSON.parse(bytes);calls.push({action,selector:q.selector,bytes,body});
  if(action==='memory-forget')return rawReply(q.selector==='prepare-forget'?await prepared(body.operation,body.key):state.forgetLost&&q.selector==='forget'?failure('forget','unavailable',true,'unknown'):ack(q.selector,body.intent.operation));
  if(action!=='basic-settings')throw Error('Unexpected fixture action');let r;
  if(q.selector==='inspect'){r=report('inspect','read-only',{schema_version:1,base_sha256:state.hash,config_path_sha256:state.path,current:structuredClone(state.current)});if(state.onInspect)r=await state.onInspect(r);}
  else if(q.selector==='prepare'){
   const after=changedBasicFields(state.current,body.changes);if(JSON.stringify(after)===JSON.stringify(state.current))r=report('prepare','no-change',{current:structuredClone(state.current),base_sha256:state.hash});else{
    const intent={basic_version:1,operation:body.operation,base_sha256:body.base_sha256,target_sha256:createHash('sha256').update(JSON.stringify(after)+String(++revision)).digest('hex'),config_path_sha256:body.config_path_sha256,changes:body.changes};state.prepared.set(intent.operation,{intent,after});r=report('prepare','prepared',{before:structuredClone(state.current),after,intent});
   }if(state.onPrepare)r=await state.onPrepare(r,body);
  }else if(q.selector==='apply'){
   const p=state.prepared.get(body.intent.operation);state.current=structuredClone(p.after);state.hash=body.intent.target_sha256;r=report('apply','verified',{target_sha256:state.hash,current:structuredClone(state.current)});if(state.onApply)r=await state.onApply(r,body);
  }else{
   r=report('status',state.hash===body.intent.target_sha256?'desired-file-observed':'unresolved',{observed_sha256:state.hash,current:structuredClone(state.current)});if(state.onStatus)r=await state.onStatus(r,body);
  }
  return {contract_version:1,status:'observed',observation:structuredClone(tablet),basic_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(r)+'\n').toString('base64')}};
 }};
 let basic;const forget=new MemoryForgetHost({observer,io,beforeIO:()=>basic?.invalidate()});basic=new BasicSettingsHost({observer,io,beforeIO:()=>forget.invalidate(),reference:()=>String(++sequence).padStart(64,'0'),...options});return {state,calls,observer,io,basic,forget,wrapped:forget.wrap()};
}
export async function begin(f){return (await f.basic.request({action:'begin',...identity})).basic_settings.reference;}
export const save=(f,reference,changes={debug_dump:{action:'set',value:true}})=>f.basic.request({action:'save',...identity,reference,changes});
