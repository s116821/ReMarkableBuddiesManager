import { MEMORY_KEYS,parseMemorySettingsRequest,parseMemorySettingsResult,parseMemoryChanges,memoryResponseContext,memoryText,type MemoryChanges,type MemorySettingsRequest,type MemorySettingsResult,type MemoryKey,type MemoryRetained,type MemoryView } from '../host/memory-settings-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { TabletObservation } from './observation';
// Raw scalar drafts stay separate from normalized textarea display and safe UI state.
export type MemoryAction='keep'|'replace'|'clear';
import {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
export {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
export class MemoryDraft {
 private raw:Record<MemoryKey,string>={enabled:'',profile:''};private version=0;private enabledValue=false;
 private before:{key:MemoryKey;version:number;start:number;end:number;type:string;data:string|null}|null=null;
 private invalid:Record<MemoryKey,boolean>={enabled:false,profile:false};
 display(key:MemoryKey){return displayModelText(this.raw[key]);}
 clear(key?:MemoryKey){if(!key||key==='enabled')this.enabledValue=false;this.version++;this.before=null;for(const k of key?[key]:['enabled','profile'] as MemoryKey[]){this.raw[k]='';this.invalid[k]=false;}}
 beforeInput(key:MemoryKey,start:number,end:number,type:string,data:string|null){this.before={key,version:this.version,start,end,type,data};}
 enabled(value:boolean){this.enabledValue=value;}
 private store(key:MemoryKey,value:string){
  if(key!=='profile')return false;
  // Transport/scalar bounds only; the producer owns profile UUID validation.
  if([...value].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;})||new TextEncoder().encode(value).length>4096){this.invalid[key]=true;this.version++;this.before=null;return false;}
  this.raw[key]=value;this.invalid[key]=false;this.version++;this.before=null;return true;
 }
 paste(key:MemoryKey,start:number,end:number,text:string){try{return this.store(key,spliceModelText(this.raw[key],start,end,text));}catch{this.invalid[key]=true;this.before=null;return false;}}
 input(key:MemoryKey,next:string){
  const before=this.before;try{
   let candidate:string|null=null;
   if(before?.key===key&&before.version===this.version){
    if(before.type==='insertText'&&before.data!==null)candidate=spliceModelText(this.raw[key],before.start,before.end,before.data);
    else if(['insertLineBreak','insertParagraph'].includes(before.type))candidate=spliceModelText(this.raw[key],before.start,before.end,'\n');
    else if(before.type.startsWith('delete')){
     if(before.start!==before.end)candidate=spliceModelText(this.raw[key],before.start,before.end,'');
     else{
      const removed=this.display(key).length-next.length;if(removed<0)throw Error('Replacement edit refused');
      if(before.type.endsWith('Backward'))candidate=spliceModelText(this.raw[key],before.start-removed,before.end,'');
      else if(before.type.endsWith('Forward'))candidate=spliceModelText(this.raw[key],before.start,before.end+removed,'');
      else if(removed===0)candidate=this.raw[key];else throw Error('Replacement edit ambiguous');
     }
    }
   }
   if(candidate===null){
    if(next===this.display(key)&&before&&(before.start!==before.end||before.type!=='insertCompositionText'))throw Error('Replacement edit ambiguous');
    candidate=reconcileModelText(this.raw[key],next);
   }
   if(displayModelText(candidate)!==next)throw Error('Replacement edit refused');return this.store(key,candidate);
  }catch{this.invalid[key]=true;this.version++;this.before=null;return false;}
 }
 valid(key:MemoryKey){return key==='enabled'||!this.invalid[key]&&memoryText(key,this.raw[key]);}
 patch(actions:Record<MemoryKey,MemoryAction>):MemoryChanges{
  const changes:MemoryChanges={};if(actions.enabled==='clear')changes.enabled={action:'clear'};else if(actions.enabled==='replace')changes.enabled={action:'set',value:this.enabledValue};
  if(actions.profile==='clear')changes.profile={action:'clear'};else if(actions.profile==='replace'){if(!this.valid('profile'))throw Error('Private replacement refused');changes.profile={action:'set',value:this.raw.profile};}return changes;
 }
}

export interface MemorySettingsAdapter {memorySettings(request:MemorySettingsRequest):Promise<MemorySettingsResult>}
export interface MemoryUiState {status:string;busy:boolean;view:MemoryView|null;reference:string|null;actions:Record<MemoryKey,MemoryAction>;valid:boolean;retained:MemoryRetained[];uncertain:boolean;enabledValue:boolean}
const empty=():Record<MemoryKey,MemoryAction>=>({enabled:'keep',profile:'keep'});
const labels:Record<string,string>={none:'Begin a fresh edit to read saved memory declarations',ready:'Saved declaration origins ready - enter replacements deliberately',invalidated:'Memory editor invalidated - begin a fresh edit',unsupported:'Installed memory editor is unsupported',unavailable:'Memory editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unconfirmed memory saves are retained - check an original desired file first','not-dispatched':'This memory save was not dispatched','no-change':'No saved memory change was needed',verified:'Saved memory declarations verified - runtime and automatic Reader activation remain unverified',unknown:'Memory save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original memory save remains unconfirmed','desired-file-observed':'Desired saved file observed - historical publisher and runtime remain unverified'};
export class MemorySettingsController {
 state:MemoryUiState={status:'Not inspected',busy:false,view:null,reference:null,enabledValue:false,actions:empty(),valid:false,retained:[],uncertain:false};
 private generation=0;private pendingAction:MemorySettingsRequest['action']|null=null;private possible=false;private original:MemoryRetained|null=null;
 private draft=new MemoryDraft();private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly changed:(v:MemoryUiState)=>void;private readonly clearInputs:(key?:MemoryKey)=>void;
 constructor(changed:(v:MemoryUiState)=>void,clearInputs:(key?:MemoryKey)=>void=()=>{}){this.changed=changed;this.clearInputs=clearInputs;}
 private publish(p:Partial<MemoryUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private resetDraft(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.draft.clear();this.clearInputs();}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Memory save outcome unknown - check its original desired file':'Memory editor invalidated - begin a fresh edit',busy:false,view:null,enabledValue:false,actions:empty(),valid:false,reference:this.possible?this.original?.reference??null:null,uncertain:this.possible});}
 text(key:MemoryKey){return this.draft.display(key);}
 private editable(){return !this.state.busy&&this.state.view?.state==='ready';}
 private refreshValidity(){this.publish({valid:this.editable()&&MEMORY_KEYS.some(k=>this.state.actions[k]!=='keep')&&MEMORY_KEYS.every(k=>this.state.actions[k]!=='replace'||this.draft.valid(k))});}
 action(key:MemoryKey,value:string){if(!this.editable()||!['keep','replace','clear'].includes(value))return;this.draft.clear(key);this.clearInputs(key);this.publish({actions:{...this.state.actions,[key]:value as MemoryAction},...key==='enabled'?{enabledValue:false}:{}});this.refreshValidity();}
 enabled(value:boolean){if(this.editable()&&this.state.actions.enabled==='replace'){this.draft.enabled(value);this.publish({enabledValue:value});this.refreshValidity();}}
 beforeInput(key:MemoryKey,start:number,end:number,type:string,data:string|null){if(this.editable()&&this.state.actions[key]==='replace')this.draft.beforeInput(key,start,end,type,data);}
 input(key:MemoryKey,value:string){if(!this.editable()||this.state.actions[key]!=='replace')return;const ok=this.draft.input(key,value);this.publish({status:ok?labels['ready']:'Replacement edit refused - enter a fresh valid replacement'});this.refreshValidity();}
 paste(key:MemoryKey,start:number,end:number,text:string){if(!this.editable()||this.state.actions[key]!=='replace')return;const ok=this.draft.paste(key,start,end,text);this.publish({status:ok?labels['ready']:'Replacement paste refused - enter a fresh valid replacement'});this.refreshValidity();}
 private async call(adapter:MemorySettingsAdapter,request:MemorySettingsRequest|null,generation:number){
  if(!request)throw Error('Memory request refused');parseMemorySettingsRequest(request);const context=memoryResponseContext(request),pending=adapter.memorySettings(request);request=null;
  const value=await pending;parseMemorySettingsResult(value,context,validateResult);if(generation!==this.generation)return;this.pendingAction=null;this.resetDraft();
  const q=value.memory_settings,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(q.state);if(settled){this.possible=false;this.original=null;}
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state),removed=settled?context.reference:null,retained=[...q.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  this.publish({status:labels[q.state],busy:false,view:q,reference:q.reference,enabledValue:false,actions:empty(),valid:false,retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
  if(q.state==='ready'){const g=this.generation;this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:MemorySettingsAdapter){if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='retained';this.publish({busy:true,enabledValue:false,actions:empty(),valid:false,status:'Reading retained host memory diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained memory diagnostics unavailable'});}}
 async begin(adapter:MemorySettingsAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='begin';this.publish({busy:true,view:null,enabledValue:false,actions:empty(),valid:false,reference:null,status:'Pausing observation before a fresh memory editor read...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Memory read invalidated'});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Memory settings unavailable or response refused',view:null});}
 }
 async save(adapter:MemorySettingsAdapter,tablet:TabletObservation){
  if(!this.editable()||!this.state.valid||!this.state.reference||this.state.retained.length>=8)return;
  let changes=parseMemoryChanges(this.draft.patch(this.state.actions));const reference=this.state.reference,g=++this.generation;this.resetDraft();try{parseMemorySettingsRequest({action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,changes});}catch{for(const key of Object.keys(changes) as MemoryKey[])delete changes[key];changes={};this.publish({busy:false,view:null,reference:null,enabledValue:false,actions:empty(),valid:false,status:'Memory save refused locally - no request was dispatched'});return;}this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.possible=true;this.pendingAction='save';this.publish({busy:true,enabledValue:false,actions:empty(),valid:false,status:'Saving original memory declarations - replacement text cleared...'});
  try{const pending=this.call(adapter,{action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,changes},g);changes={};await pending;}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Memory save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}finally{for(const k of Object.keys(changes) as MemoryKey[])delete changes[k];changes={};}
 }
 async status(adapter:MemorySettingsAdapter,original:MemoryRetained,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;this.resetDraft();const g=++this.generation;this.original=original;this.possible=true;this.pendingAction='status';this.publish({busy:true,view:null,reference:original.reference,enabledValue:false,actions:empty(),valid:false,status:'Checking original desired file without replacement text...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Memory status check invalidated'});return;}await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check unavailable - original outcome remains unknown'});}
 }
 async stop(adapter:MemorySettingsAdapter){
  const g=++this.generation,reference=this.state.reference,original=this.original,pending=this.pendingAction;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({busy:true,enabledValue:false,actions:empty(),valid:false,status:'Stopping memory wait; replacement text cleared...'});const owns=()=>g===this.generation&&this.state.reference===reference&&this.original===original;
  try{if(reference&&pending!=='retained'){const request={action:'cancel' as const,reference},value=await adapter.memorySettings(request);if(!owns())return;parseMemorySettingsResult(value,request,validateResult);if(!owns())return;if(['not-dispatched','invalidated'].includes(value.memory_settings.state)){this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});}}}catch{if(!owns())return;}
  if(g===this.generation&&this.state.reference===reference)this.publish({busy:false,view:null,status:this.possible?'Memory save outcome unknown - stopping is not rollback':pending==='retained'?'Retained memory read stopped':'Memory editor invalidated - no save was requested',uncertain:this.possible});
 }
}
