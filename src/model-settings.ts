import { MODEL_KEYS,parseModelSettingsRequest,parseModelSettingsResult,parseModelChanges,modelResponseContext,modelText,type ModelChanges,type ModelSettingsRequest,type ModelSettingsResult,type ModelKey,type ModelRetained,type ModelView } from '../host/model-settings-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { TabletObservation } from './observation';
// Raw scalar drafts stay separate from normalized textarea display and safe UI state.
export type ModelAction='keep'|'replace'|'clear';
export const displayModelText=(raw:string)=>raw.replace(/\r\n?/g,'\n');
function rawOffset(raw:string,position:number){
 const display=displayModelText(raw);if(!Number.isSafeInteger(position)||position<0||position>display.length)throw Error('Replacement edit refused');
 let index=0;for(let n=0;n<position;n++){index+=raw[index]==='\r'&&raw[index+1]==='\n'?2:1;}return index;
}
export function spliceModelText(raw:string,start:number,end:number,text:string){if(end<start)throw Error('Replacement edit refused');return raw.slice(0,rawOffset(raw,start))+text+raw.slice(rawOffset(raw,end));}
export function reconcileModelText(raw:string,next:string){
 const before=displayModelText(raw);if(next!==displayModelText(next))throw Error('Replacement edit refused');if(before===next)return raw;
 // Equal displayed spans can contain different raw CRLF/LF/CR. Without an
 // event anchor, accept only when every minimal splice produces identical raw text.
 if(!raw.includes('\r'))return next;
 let prefix=0;while(prefix<before.length&&prefix<next.length&&before[prefix]===next[prefix])prefix++;
 let suffix=0;while(suffix<before.length&&suffix<next.length&&before[before.length-1-suffix]===next[next.length-1-suffix])suffix++;
 const matched=Math.min(before.length,next.length,prefix+suffix);let result:string|null=null;
 for(let start=Math.max(0,matched-suffix);start<=Math.min(prefix,matched);start++){
  const tail=matched-start,oldEnd=before.length-tail,insertion=next.slice(start,next.length-tail);
  if(raw.slice(rawOffset(raw,start),rawOffset(raw,oldEnd)).includes('\r')&&insertion.includes('\n'))throw Error('Replacement edit ambiguous');
  const candidate=spliceModelText(raw,start,oldEnd,insertion);
  if(result!==null&&result!==candidate)throw Error('Replacement edit ambiguous');result=candidate;
 }
 if(result===null||displayModelText(result)!==next)throw Error('Replacement edit refused');return result;
}
export class ModelDraft {
 private raw:Record<ModelKey,string>={model:'',base_url:''};private version=0;
 private before:{key:ModelKey;version:number;start:number;end:number;type:string;data:string|null}|null=null;
 private invalid:Record<ModelKey,boolean>={model:false,base_url:false};
 display(key:ModelKey){return displayModelText(this.raw[key]);}
 clear(key?:ModelKey){this.version++;this.before=null;for(const k of key?[key]:['model','base_url'] as ModelKey[]){this.raw[k]='';this.invalid[k]=false;}}
 beforeInput(key:ModelKey,start:number,end:number,type:string,data:string|null){this.before={key,version:this.version,start,end,type,data};}
 private store(key:ModelKey,value:string){
  // Empty/whitespace drafts are editable, but never a valid set operation.
  if([...value].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;})||new TextEncoder().encode(value).length>(key==='model'?256:2048)){this.invalid[key]=true;this.version++;this.before=null;return false;}
  this.raw[key]=value;this.invalid[key]=false;this.version++;this.before=null;return true;
 }
 paste(key:ModelKey,start:number,end:number,text:string){try{return this.store(key,spliceModelText(this.raw[key],start,end,text));}catch{this.invalid[key]=true;this.before=null;return false;}}
 input(key:ModelKey,next:string){
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
 valid(key:ModelKey){return !this.invalid[key]&&modelText(key,this.raw[key]);}
 patch(actions:Record<ModelKey,ModelAction>):ModelChanges{
  const changes:ModelChanges={};for(const key of ['model','base_url'] as ModelKey[]){if(actions[key]==='clear')changes[key]={action:'clear'};else if(actions[key]==='replace'){if(!this.valid(key))throw Error('Replacement input refused');changes[key]={action:'set',value:this.raw[key]};}}return changes;
 }
}

export interface ModelSettingsAdapter {modelSettings(request:ModelSettingsRequest):Promise<ModelSettingsResult>}
export interface ModelUiState {status:string;busy:boolean;view:ModelView|null;reference:string|null;actions:Record<ModelKey,ModelAction>;valid:boolean;retained:ModelRetained[];uncertain:boolean}
const empty=():Record<ModelKey,ModelAction>=>({model:'keep',base_url:'keep'});
const labels:Record<string,string>={none:'Begin a fresh edit to read saved model declarations',ready:'Saved declaration origins ready - enter replacements deliberately',invalidated:'Model editor invalidated - begin a fresh edit',unsupported:'Installed model editor is unsupported',unavailable:'Model editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unconfirmed model saves are retained - check an original desired file first','not-dispatched':'This model save was not dispatched','no-change':'No saved model change was needed',verified:'Saved file verified - restart required; effective model and endpoint unverified',unknown:'Model save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original model save remains unconfirmed','desired-file-observed':'Desired saved file observed - historical publisher and runtime remain unverified'};
export class ModelSettingsController {
 state:ModelUiState={status:'Not inspected',busy:false,view:null,reference:null,actions:empty(),valid:false,retained:[],uncertain:false};
 private generation=0;private pendingAction:ModelSettingsRequest['action']|null=null;private possible=false;private original:ModelRetained|null=null;
 private draft=new ModelDraft();private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly changed:(v:ModelUiState)=>void;private readonly clearInputs:(key?:ModelKey)=>void;
 constructor(changed:(v:ModelUiState)=>void,clearInputs:(key?:ModelKey)=>void=()=>{}){this.changed=changed;this.clearInputs=clearInputs;}
 private publish(p:Partial<ModelUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private resetDraft(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.draft.clear();this.clearInputs();}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Model save outcome unknown - check its original desired file':'Model editor invalidated - begin a fresh edit',busy:false,view:null,actions:empty(),valid:false,reference:this.possible?this.original?.reference??null:null,uncertain:this.possible});}
 text(key:ModelKey){return this.draft.display(key);}
 private editable(){return !this.state.busy&&this.state.view?.state==='ready';}
 private refreshValidity(){this.publish({valid:this.editable()&&MODEL_KEYS.some(k=>this.state.actions[k]!=='keep')&&MODEL_KEYS.every(k=>this.state.actions[k]!=='replace'||this.draft.valid(k))});}
 action(key:ModelKey,value:string){if(!this.editable()||!['keep','replace','clear'].includes(value))return;this.draft.clear(key);this.clearInputs(key);this.publish({actions:{...this.state.actions,[key]:value as ModelAction}});this.refreshValidity();}
 beforeInput(key:ModelKey,start:number,end:number,type:string,data:string|null){if(this.editable()&&this.state.actions[key]==='replace')this.draft.beforeInput(key,start,end,type,data);}
 input(key:ModelKey,value:string){if(!this.editable()||this.state.actions[key]!=='replace')return;const ok=this.draft.input(key,value);this.publish({status:ok?labels['ready']:'Replacement edit refused - enter a fresh valid replacement'});this.refreshValidity();}
 paste(key:ModelKey,start:number,end:number,text:string){if(!this.editable()||this.state.actions[key]!=='replace')return;const ok=this.draft.paste(key,start,end,text);this.publish({status:ok?labels['ready']:'Replacement paste refused - enter a fresh valid replacement'});this.refreshValidity();}
 private async call(adapter:ModelSettingsAdapter,request:ModelSettingsRequest|null,generation:number){
  if(!request)throw Error('Model request refused');parseModelSettingsRequest(request);const context=modelResponseContext(request),pending=adapter.modelSettings(request);request=null;
  const value=await pending;parseModelSettingsResult(value,context,validateResult);if(generation!==this.generation)return;this.pendingAction=null;this.resetDraft();
  const q=value.model_settings,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(q.state);if(settled){this.possible=false;this.original=null;}
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state),removed=settled?context.reference:null,retained=[...q.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  this.publish({status:labels[q.state],busy:false,view:q,reference:q.reference,actions:empty(),valid:false,retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
  if(q.state==='ready'){const g=this.generation;this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:ModelSettingsAdapter){if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='retained';this.publish({busy:true,actions:empty(),valid:false,status:'Reading retained host model diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained model diagnostics unavailable'});}}
 async begin(adapter:ModelSettingsAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='begin';this.publish({busy:true,view:null,actions:empty(),valid:false,reference:null,status:'Pausing observation before a fresh model editor read...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Model read invalidated'});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Model settings unavailable or response refused',view:null});}
 }
 async save(adapter:ModelSettingsAdapter,tablet:TabletObservation){
  if(!this.editable()||!this.state.valid||!this.state.reference||this.state.retained.length>=8)return;
  let changes=parseModelChanges(this.draft.patch(this.state.actions));const reference=this.state.reference,g=++this.generation;this.resetDraft();this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.possible=true;this.pendingAction='save';this.publish({busy:true,actions:empty(),valid:false,status:'Saving original model declarations - replacement text cleared...'});
  try{const pending=this.call(adapter,{action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,changes},g);changes={};await pending;}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Model save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}finally{for(const k of Object.keys(changes) as ModelKey[])delete changes[k];changes={};}
 }
 async status(adapter:ModelSettingsAdapter,original:ModelRetained,tablet:TabletObservation){
  if(this.state.busy||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;this.resetDraft();const g=++this.generation;this.original=original;this.possible=true;this.pendingAction='status';this.publish({busy:true,view:null,reference:original.reference,actions:empty(),valid:false,status:'Checking original desired file without replacement text...'});
  try{await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check unavailable - original outcome remains unknown'});}
 }
 async stop(adapter:ModelSettingsAdapter,cancel:()=>Promise<unknown>){
  const g=++this.generation,reference=this.state.reference,original=this.original,pending=this.pendingAction;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({busy:true,actions:empty(),valid:false,status:'Stopping model wait; replacement text cleared...'});const owns=()=>g===this.generation&&this.state.reference===reference&&this.original===original;
  try{if(reference&&pending!=='retained'){const request={action:'cancel' as const,reference},value=await adapter.modelSettings(request);if(!owns())return;parseModelSettingsResult(value,request,validateResult);if(!owns())return;if(['not-dispatched','invalidated'].includes(value.model_settings.state)){this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});}}else if(pending==='begin'){await cancel();if(!owns())return;}}catch{if(!owns())return;}
  if(g===this.generation&&this.state.reference===reference)this.publish({busy:false,view:null,status:this.possible?'Model save outcome unknown - stopping is not rollback':pending==='retained'?'Retained model read stopped':'This model invocation was not dispatched - editor invalidated',uncertain:this.possible});
 }
}
