import { BASIC_KEYS,parseBasicSettingsRequest,parseBasicSettingsResult,parseBasicChanges,type BasicSettingsRequest,type BasicSettingsResult,type BasicFields,type BasicKey,type BasicChanges,type BasicRetained,type BasicView } from '../host/basic-settings-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { TabletObservation } from './observation';
export interface BasicSettingsAdapter {basicSettings(request:BasicSettingsRequest):Promise<BasicSettingsResult>}
export interface BasicUiState {status:string;busy:boolean;view:BasicView|null;reference:string|null;draft:Record<BasicKey,string>;changes:BasicChanges;retained:BasicRetained[];uncertain:boolean}
const empty=():Record<BasicKey,string>=>({debug_dump:'',log_level:'',trigger_corner:''});
const labels:Record<string,string>={none:'Begin a fresh edit to read saved basic settings',ready:'Saved settings ready to edit',invalidated:'Editor invalidated - begin a fresh edit',unsupported:'Installed basic-settings editor is unsupported',unavailable:'Editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unconfirmed saves are retained - check an original desired file before another save','not-dispatched':'This save was not dispatched','no-change':'No saved change was needed',verified:'Saved file verified - restart required for running behavior',unknown:'Save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original outcome remains unconfirmed','desired-file-observed':'Desired saved file observed - historical publisher and runtime remain unverified'};
export class BasicSettingsController {
 state:BasicUiState={status:'Not inspected',busy:false,view:null,reference:null,draft:empty(),changes:{},retained:[],uncertain:false};
 private generation=0;private possible=false;private original:BasicRetained|null=null;
 private readonly changed:(v:BasicUiState)=>void;
 constructor(changed:(v:BasicUiState)=>void){this.changed=changed;}
 private publish(p:Partial<BasicUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Save outcome unknown - check its original desired file':'Editor invalidated - begin a fresh edit',busy:false,view:null,changes:{},draft:empty(),reference:this.possible?this.original?.reference??null:null,uncertain:this.possible});}
 edit(key:BasicKey,value:string){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.view.current)return;
  const changes={...this.state.changes},original=this.state.view.current[key];
  const next=value===''?{action:'clear' as const}:{action:'set' as const,value:key==='debug_dump'?value==='true':value};
  parseBasicChanges({[key]:next});const equivalent=next.action==='clear'?original.origin==='default':original.origin==='declared'&&original.value===next.value;
  if(equivalent)delete changes[key];else changes[key]=next;this.publish({changes,draft:{...this.state.draft,[key]:value}});
 }
 private async call(adapter:BasicSettingsAdapter,request:BasicSettingsRequest,generation:number){
  parseBasicSettingsRequest(request);const value=await adapter.basicSettings(request);parseBasicSettingsResult(value,request,validateResult);if(generation!==this.generation)return;
  const q=value.basic_settings,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(q.state);
  if(settled){this.possible=false;this.original=null;}
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state),removed=settled&&'reference'in request?request.reference:null;
  const retained=[...q.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  const draft=q.current?Object.fromEntries(BASIC_KEYS.map(k=>[k,q.current![k].value===null?'':String(q.current![k].value)])) as Record<BasicKey,string>:empty();
  this.publish({status:labels[q.state],busy:false,view:q,reference:q.reference,draft,changes:{},retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
 }
 async retained(adapter:BasicSettingsAdapter){if(this.state.busy)return;const g=++this.generation;this.publish({busy:true,status:'Reading retained host diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained host diagnostics unavailable'});}}
 async begin(adapter:BasicSettingsAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;const g=++this.generation;this.publish({busy:true,view:null,changes:{},reference:null,status:'Pausing observation before a fresh editor read...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Editor read invalidated'});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Basic settings unavailable or response refused',view:null});}
 }
 async save(adapter:BasicSettingsAdapter,tablet:TabletObservation){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.reference||!Object.keys(this.state.changes).length||this.state.retained.length>=8)return;
  const reference=this.state.reference,changes=parseBasicChanges(this.state.changes),g=++this.generation;this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.possible=true;this.publish({busy:true,status:'Saving the original inspected revision...'});
  try{await this.call(adapter,{action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,changes},g);}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}
 }
 async status(adapter:BasicSettingsAdapter,original:BasicRetained,tablet:TabletObservation){
  if(this.state.busy||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;
  const g=++this.generation;this.original=original;this.possible=true;this.publish({busy:true,view:null,reference:original.reference,changes:{},status:'Checking the original desired file only...'});
  try{await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check unavailable - original outcome remains unknown'});}
 }
 async stop(adapter:BasicSettingsAdapter,cancel:()=>Promise<unknown>){
  const g=++this.generation,reference=this.state.reference;if(this.possible)this.keepOriginal();this.publish({busy:true,status:'Stopping local wait...'});
  try{if(reference){const request={action:'cancel' as const,reference};const value=await adapter.basicSettings(request);parseBasicSettingsResult(value,request,validateResult);if(['not-dispatched','invalidated'].includes(value.basic_settings.state)){this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});}}else await cancel();}catch{/* A failed stop never proves rollback. */}
  if(g===this.generation)this.publish({busy:false,view:null,changes:{},status:this.possible?'Save outcome unknown - stopping is not rollback':'This invocation was not dispatched - editor invalidated',uncertain:this.possible});
 }
}
export function basicRows(fields:BasicFields|null,draft:Record<BasicKey,string>){
 if(!fields)return [];
 return [{key:'trigger_corner' as const,label:'Trigger corner',options:[['','No saved override'],['UR','Top right'],['UL','Top left'],['LR','Bottom right'],['LL','Bottom left']]},{key:'log_level' as const,label:'Diagnostic level',options:[['','No saved override'],...['off','error','warn','info','debug','trace'].map(x=>[x,x])]},{key:'debug_dump' as const,label:'Save diagnostic images',options:[['','No saved override'],['false','Disabled'],['true','Enabled']]}].map(row=>({...row,origin:fields[row.key].origin,originLabel:{default:'No saved override',declared:'Saved value','declared-null':'Explicitly empty'}[fields[row.key].origin],value:draft[row.key]}));
}
