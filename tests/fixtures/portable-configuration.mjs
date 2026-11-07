// Synthetic producer callbacks, distinct from the separately attributed CLI corpus.
import {modelFixture,identity,tablet,defer} from './model-settings.mjs';
import {PortableConfigurationHost} from '../../host/portable-configuration.mjs';
import {portableCanonical} from '../../host/portable-configuration-protocol.mjs';
import {portableHash,portablePathHash} from '../../host/portable-configuration-private.mjs';
export {identity,tablet,defer};
export const artifact={portable_configuration_version:1,settings:{personalization:{enabled:false,text:'SYNTHETIC_PRIVATE_PORTABLE_雪😀\r\n\t\b'},product_settings:{reader_enabled:false},research_policy:null}};
export const selected=Buffer.from(JSON.stringify(artifact)).toString('base64');
export const originalOrigins={personalization:'absent',product_settings:'absent',research_policy:'absent'};
export const report=(operation,outcome,data,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:'unverified',data});
export function portableFixture(options={}){
 const f=modelFixture(),run=f.observer.run;let sequence=0,revision=0;
 const state={hash:'7'.repeat(64),prepared:new Map(),onInspect:null,onPrepare:null,onApply:null,onStatus:null,onExport:null,noop:false,mode:'normal',packets:[],pending:new Map()};
 f.observer.run=async function(action,q){
  if(action!=='portable-configuration')return run.call(this,action,q);this.cancel();const raw=q.input_base64===null?null:Buffer.from(q.input_base64,'base64'),body=raw===null?null:JSON.parse(raw);f.calls.push({action,selector:q.selector,body,bytes:raw,budget_ms:q.budget_ms});state.packets.push({...q});let value;
  if(q.selector==='export')value={report_version:1,operation:'export',status:'ok',runtime_activation:'unverified',artifact:structuredClone(artifact),summary:{artifact_sha256:portableHash(portableCanonical(artifact)),declared_settings:3,personalization_included:true}};
  else if(q.selector==='inspect')value=report('inspect','read-only',{base_sha256:state.hash,config_path_sha256:portablePathHash,current:structuredClone(originalOrigins)});
  else if(q.selector==='prepare'){
   const names=Object.keys(body.artifact.settings).sort(),artifact_sha256=portableHash(portableCanonical(body.artifact));
   if(state.noop||!names.length)value=report('prepare','no-change',{base_sha256:state.hash,artifact_sha256,changed_settings:[]});
   else{const intent={portable_import_version:1,operation:body.operation,base_sha256:body.base_sha256,target_sha256:portableHash('synthetic-target-'+(++revision)),config_path_sha256:body.config_path_sha256,artifact_sha256},after={...originalOrigins};for(const name of names)after[name]=body.artifact.settings[name]===null?'declared-null':'declared';state.prepared.set(intent.operation,{intent,names});value=report('prepare','prepared',{intent,changed_settings:names,before:structuredClone(originalOrigins),after});}
  }else if(q.selector==='apply'){const p=state.prepared.get(body.intent.operation);if(!p)throw Error('Synthetic original absent');state.hash=body.intent.target_sha256;value=report('apply','verified',{target_sha256:state.hash,changed_settings:p.names});}
  else value=report('status',state.hash===body.intent.target_sha256?'desired-file-observed':'unresolved',{observed_sha256:state.hash});
  const hook=state['on'+q.selector[0].toUpperCase()+q.selector.slice(1)];if(hook)value=await hook(value,body);
  if(state.mode==='delay-'+q.selector){const ticket=body?.operation??body?.intent?.operation??q.selector,gate=defer();state.pending.set(ticket,gate.resolve);await gate.promise;state.pending.delete(ticket);}
  if(state.mode==='lost'&&q.selector==='apply')throw Error('Synthetic report loss');
  if(state.mode==='status-refused'&&q.selector==='status')value=report('status','read-only',null,'unavailable');
  const stdout=typeof value==='string'?value:JSON.stringify(value)+'\n';return {contract_version:1,status:'observed',observation:structuredClone(tablet),portable_configuration_raw:{status:'reported',stdout_base64:Buffer.from(stdout).toString('base64')}};
 };
 const portable=new PortableConfigurationHost({observer:f.observer,io:f.io,beforeIO:()=>{f.basic.invalidate();f.forget.invalidate();f.model.invalidate();},reference:()=>String(++sequence).padStart(64,'e'),...options});
 for(const peer of [f.basic,f.forget,f.model]){const before=peer.beforeIO;peer.beforeIO=()=>{portable.invalidate();before();};}
 return {...f,portable,portableState:state};
}
export const prepare=async(f,data=selected)=>(await f.portable.request({action:'prepare',...identity,artifact_base64:data})).portable_configuration;
export const confirm=(f,reference)=>f.portable.request({action:'confirm',...identity,reference});
export function hostFixture(){const f=portableFixture(),observe=f.observer.observe.bind(f.observer);let observations=0;f.observer.observe=async()=>{const result=await observe();observations++;return result;};return {f,snapshot:()=>({observations,pending:f.portableState.pending.size,applies:f.calls.filter(c=>c.action==='portable-configuration'&&c.selector==='apply').length,statuses:f.calls.filter(c=>c.action==='portable-configuration'&&c.selector==='status').length,selectors:f.calls.filter(c=>c.action==='portable-configuration').map(c=>c.selector),lastApply:f.calls.findLast(c=>c.action==='portable-configuration'&&c.selector==='apply')?.bytes?.toString('base64')??null,lastStatus:f.calls.findLast(c=>c.action==='portable-configuration'&&c.selector==='status')?.bytes?.toString('base64')??null})};}
