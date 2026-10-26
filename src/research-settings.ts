import {parseResearchSettingsRequest,parseResearchSettingsResult,researchResponseContext,type ResearchChanges,type ResearchSettingsRequest,type ResearchSettingsResult,type ResearchRetained,type ResearchView} from '../host/research-settings-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface ResearchSettingsAdapter {researchSettings(request:ResearchSettingsRequest):Promise<ResearchSettingsResult>}
export type ResearchChoice='keep'|'required'|'disabled'|'clear';
export interface ResearchUiState {status:string;busy:boolean;view:ResearchView|null;reference:string|null;choice:ResearchChoice;valid:boolean;retained:ResearchRetained[];uncertain:boolean}
const labels:Record<string,string>={none:'Begin a fresh saved research-policy edit',ready:'Saved policy origin ready - choose a deliberate change',invalidated:'Research editor invalidated - begin a fresh edit',unsupported:'Installed research editor is unsupported',unavailable:'Research editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unconfirmed policy saves are retained - check an original first','not-dispatched':'This policy save was not dispatched','no-change':'No saved research-policy change was needed',verified:'Saved research policy verified - runtime activation remains unverified',unknown:'Policy save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original policy save remains unconfirmed','desired-file-observed':'Desired saved policy observed - historical publication and runtime remain unverified'};
export class ResearchSettingsController {
 state:ResearchUiState={status:'Not inspected',busy:false,view:null,reference:null,choice:'keep',valid:false,retained:[],uncertain:false};
 private generation=0;private possible=false;private original:ResearchRetained|null=null;private pending:ResearchSettingsRequest['action']|null=null;private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly changed:(v:ResearchUiState)=>void;private readonly clearInput:()=>void;
 constructor(changed:(v:ResearchUiState)=>void,clearInput:()=>void=()=>{}){this.changed=changed;this.clearInput=clearInput;}
 private publish(v:Partial<ResearchUiState>){this.state={...this.state,...v};this.changed(this.state);}
 private reset(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.clearInput();}
 private keepOriginal(){if(this.original&&!this.state.retained.some(v=>v.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;this.pending=null;this.reset();if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Policy save outcome unknown - check its original desired file':labels.invalidated,busy:false,view:null,reference:this.possible?this.original?.reference??null:null,choice:'keep',valid:false,uncertain:this.possible});}
 choose(value:string){if(this.state.busy||this.state.view?.state!=='ready'||!['keep','required','disabled','clear'].includes(value))return;this.publish({choice:value as ResearchChoice,valid:value!=='keep'});}
 private async call(adapter:ResearchSettingsAdapter,q:ResearchSettingsRequest|null,g:number){
  if(!q)throw Error('Research request refused');parseResearchSettingsRequest(q);const context=researchResponseContext(q),pending=adapter.researchSettings(q);q=null;
  const value=await pending;parseResearchSettingsResult(value,context,validateResult);if(g!==this.generation)return;this.pending=null;this.reset();
  const v=value.research_settings,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(v.state);if(settled){this.possible=false;this.original=null;}
  const removed=settled?context.reference:null,retained=[...v.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  const uncertain=this.possible||['unknown','unresolved'].includes(v.state);this.publish({status:labels[v.state],busy:false,view:v,reference:v.reference,choice:'keep',valid:false,retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
  if(v.state==='ready'){this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:ResearchSettingsAdapter){if(this.state.busy)return;this.reset();const g=++this.generation;this.pending='retained';this.publish({busy:true,choice:'keep',valid:false,status:'Reading retained host policy diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained policy diagnostics unavailable'});}}
 async begin(adapter:ResearchSettingsAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.reset();const g=++this.generation;this.pending='begin';this.publish({busy:true,view:null,reference:null,choice:'keep',valid:false,status:'Pausing observation before a fresh saved policy read...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:labels.invalidated});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,status:'Research settings unavailable or response refused'});}
 }
 async save(adapter:ResearchSettingsAdapter,tablet:TabletObservation){
  const {choice,reference}=this.state;if(this.state.busy||this.state.view?.state!=='ready'||!this.state.valid||!reference||choice==='keep'||this.state.retained.length>=8)return;
  const changes:ResearchChanges={research_policy:choice==='clear'?{action:'clear'}:{action:'set',value:choice}},q:ResearchSettingsRequest={action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,changes};parseResearchSettingsRequest(q);
  const g=++this.generation;this.reset();this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.possible=true;this.pending='save';this.publish({busy:true,choice:'keep',valid:false,status:'Saving original policy declaration - local choice cleared...'});
  try{await this.call(adapter,q,g);}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Policy save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}
 }
 async status(adapter:ResearchSettingsAdapter,original:ResearchRetained,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;this.reset();const g=++this.generation;this.original=original;this.possible=true;this.pending='status';this.publish({busy:true,view:null,reference:original.reference,choice:'keep',valid:false,status:'Checking only the original desired file...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:labels.invalidated});return;}await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,status:'Desired-file check unavailable - original outcome remains unknown',uncertain:true});}
 }
 async stop(adapter:ResearchSettingsAdapter){
  const g=++this.generation,reference=this.state.reference,original=this.original,pending=this.pending;this.pending=null;this.reset();if(this.possible)this.keepOriginal();this.publish({busy:true,choice:'keep',valid:false,status:'Stopping policy wait; local choice cleared...'});
  const owns=()=>g===this.generation&&reference===this.state.reference&&original===this.original;
  try{if(reference&&pending!=='retained'){const q={action:'cancel' as const,reference},value=await adapter.researchSettings(q);if(!owns())return;parseResearchSettingsResult(value,q,validateResult);if(!owns())return;if(['not-dispatched','invalidated'].includes(value.research_settings.state)){this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});}}}catch{if(!owns())return;}
  if(owns())this.publish({busy:false,view:null,status:this.possible?'Policy save outcome unknown - stopping is not rollback':labels.invalidated,uncertain:this.possible});
 }
}
