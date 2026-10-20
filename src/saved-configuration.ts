import { FIELD_KEYS,parseSavedConfigurationRequest,parseSavedConfigurationResult,type SavedConfigurationRequest,type SavedConfigurationView } from '../host/saved-configuration.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { ObservationResult,TabletObservation } from './observation';
export interface SavedConfigurationResult extends ObservationResult {saved_configuration:{status:'reported'|'unsupported'|'unavailable';view:SavedConfigurationView|null}}
export interface SavedConfigurationAdapter {inspectSavedConfiguration(request:SavedConfigurationRequest):Promise<SavedConfigurationResult>}
export interface SavedConfigurationState {status:string;busy:boolean;view:SavedConfigurationView|null}
export class SavedConfigurationController {
 state:SavedConfigurationState={status:'Not inspected',busy:false,view:null};
 private generation=0;
 private readonly changed:(state:SavedConfigurationState)=>void;
 constructor(changed:(state:SavedConfigurationState)=>void){this.changed=changed;}
 private publish(status:string,busy=false,view:SavedConfigurationView|null=null){this.state={status,busy,view};this.changed(this.state);}
 clear(){this.generation++;this.publish('Not inspected');}
 async inspect(adapter:SavedConfigurationAdapter,tablet:TabletObservation,prepare:()=>Promise<boolean>){
  if(this.state.busy)return;
  const generation=++this.generation;this.publish('Reading saved configuration…',true);
  const request={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
  try{
   parseSavedConfigurationRequest(request);
   const current=await prepare();
   if(generation!==this.generation)return;
   if(!current){this.publish('Saved configuration unavailable — read tablet state again');return;}
   const value=await adapter.inspectSavedConfiguration(request);
   if(generation!==this.generation)return;
   parseSavedConfigurationResult(value,request,validateResult);
   if(value.status!=='observed'){this.publish(`Saved configuration unavailable (${value.status}) — read tablet state again`);return;}
   const q=value.saved_configuration;
   if(q.status!=='reported'||!q.view){this.publish(`Saved configuration inspection ${q.status}`);return;}
   this.publish(q.view.status==='ok'?'Saved configuration inspected — runtime remains unverified':`Saved configuration inspection ${q.view.status}`,false,q.view);
  }catch{if(generation===this.generation)this.publish('Saved configuration unavailable or response refused');}
 }
 async cancel(cancelHost:()=>Promise<unknown>){
  const generation=++this.generation;this.publish('Cancelling configuration inspection…',true);
  try{await cancelHost();}catch{/* Fixed cancelled view; no raw errors. */}
  if(generation===this.generation)this.publish('Configuration inspection cancelled');
 }
}
const labels:Record<string,string>={config_schema_version:'Configuration schema',model:'Model value',base_url:'Model endpoint',model_credential:'Model credential reference',trigger_corner:'Trigger corner',log_level:'Log level',debug_dump:'Debug dump','paths.data':'Data path','paths.cache':'Cache path','paths.credentials':'Credential directory path','memory.enabled':'Memory enabled','memory.profile':'Memory profile','memory.selection':'Memory selection','sync.enabled':'Legacy sync enabled','sync.media':'Sync media','sync.create_new':'Create new collection','sync.namespaces':'Sync namespaces','sync.max_media_bytes':'Sync media byte ceiling','sync.poll_seconds':'Sync polling seconds','sync.batch_items':'Sync batch items','sync.collection':'Sync collection','personalization.schema_version':'Personalization schema','personalization.enabled':'Personalization enabled','personalization.text':'Personalization text','personalization.text_bytes':'Personalization text bytes'};
const presence=new Set(['model','base_url','model_credential','memory.profile','memory.selection','sync.collection']);
export function savedConfigurationRows(view:SavedConfigurationView|null){
 const snapshot=view?.snapshot;if(!snapshot)return [];
 return FIELD_KEYS.map(key=>{
  const field=snapshot.fields[key],v=field.value;
  const value=key.startsWith('paths.')?'Path setting present; details withheld; validity unchecked':presence.has(key)?v?'Configured (details withheld)':'No configured value in saved source':key==='personalization.text'?v?'Text present (contents withheld)':'No saved text':v===null?'Not specified in saved source':Array.isArray(v)?v.join(', ')||'None':typeof v==='boolean'?v?'True (saved)':'False (saved)':String(v);
  return {key,label:labels[key],origin:field.origin==='default'?'Default':field.origin==='declared-null'?'Explicit null':'Declared',value};
 });
}
