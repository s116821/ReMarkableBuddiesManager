import {parseModelCredentialRequest,parseModelCredentialResult,parseModelCredentialChange,modelCredentialContext,modelCredentialText,type ModelCredentialChange,type ModelCredentialRequest,type ModelCredentialResult,type ModelCredentialKey,type ModelCredentialRetained,type ModelCredentialView} from '../host/model-credential-protocol.mjs';
const CREDENTIAL_KEYS:readonly ModelCredentialKey[]=['model_credential'];
import { validateResult } from '../host/observation-protocol.mjs';
import type { TabletObservation } from './observation';
// Raw scalar drafts stay separate from normalized textarea display and safe UI state.
export type ModelCredentialAction='keep'|'install'|'replace'|'remove';
import {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
export {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
export class ModelCredentialDraft {
 private raw:Record<ModelCredentialKey,string>={model_credential:''};private version=0;
 private before:{key:ModelCredentialKey;version:number;start:number;end:number;type:string;data:string|null}|null=null;
 private invalid:Record<ModelCredentialKey,boolean>={model_credential:false};
 display(key:ModelCredentialKey){return displayModelText(this.raw[key]);}
 clear(key?:ModelCredentialKey){this.version++;this.before=null;for(const k of key?[key]:['model_credential'] as ModelCredentialKey[]){this.raw[k]='';this.invalid[k]=false;}}
 beforeInput(key:ModelCredentialKey,start:number,end:number,type:string,data:string|null){this.before={key,version:this.version,start,end,type,data};}
 private store(key:ModelCredentialKey,value:string){
  if(key!=='model_credential')return false;
  // Transport/scalar bounds only; the producer owns credential name validation.
  if([...value].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;})||new TextEncoder().encode(value).length>8192){this.invalid[key]=true;this.version++;this.before=null;return false;}
  this.raw[key]=value;this.invalid[key]=false;this.version++;this.before=null;return true;
 }
 paste(key:ModelCredentialKey,start:number,end:number,text:string){try{return this.store(key,spliceModelText(this.raw[key],start,end,text));}catch{this.invalid[key]=true;this.before=null;return false;}}
 input(key:ModelCredentialKey,next:string){
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
 valid(key:ModelCredentialKey){return !this.invalid[key]&&modelCredentialText(this.raw[key]);}
 patch(actions:Record<ModelCredentialKey,ModelCredentialAction>):ModelCredentialChange{
  if(actions.model_credential==='remove')return {action:'remove'};
  if(['install','replace'].includes(actions.model_credential)&&this.valid('model_credential'))return {action:actions.model_credential as 'install'|'replace',value:this.raw.model_credential};throw Error('Private replacement refused');
 }
}

export interface ModelCredentialAdapter {modelCredential(request:ModelCredentialRequest):Promise<ModelCredentialResult>}
export interface ModelCredentialUiState {status:string;busy:boolean;view:ModelCredentialView|null;reference:string|null;actions:Record<ModelCredentialKey,ModelCredentialAction>;valid:boolean;retained:ModelCredentialRetained[];uncertain:boolean}
const empty=():Record<ModelCredentialKey,ModelCredentialAction>=>({model_credential:'keep'});
const labels:Record<string,string>={none:'Begin a fresh edit to read saved credential file declarations',ready:'Saved credential file ready - choose a deliberate action',invalidated:'Model credential file editor invalidated - begin a fresh edit',unsupported:'Installed credential file editor is unsupported',unavailable:'Model credential file editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unresolved operations are retained. Another saved-file change is unavailable in this host session.','not-dispatched':'This credential file save was not dispatched','no-change':'No saved credential file change was needed',verified:'Saved credential file verified - runtime activation and authentication remain unverified',unknown:'Model credential file save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original credential file save remains unconfirmed','desired-file-observed':'Desired saved file observed - historical publisher and runtime remain unverified'};
export class ModelCredentialController {
 state:ModelCredentialUiState={status:'Not inspected',busy:false,view:null,reference:null,actions:empty(),valid:false,retained:[],uncertain:false};
 private readyDeadline=0;private generation=0;private pendingAction:ModelCredentialRequest['action']|null=null;private possible=false;private original:ModelCredentialRetained|null=null;
 private draft=new ModelCredentialDraft();private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly changed:(v:ModelCredentialUiState)=>void;private readonly clearInputs:(key?:ModelCredentialKey)=>void;
 constructor(changed:(v:ModelCredentialUiState)=>void,clearInputs:(key?:ModelCredentialKey)=>void=()=>{}){this.changed=changed;this.clearInputs=clearInputs;}
 private publish(p:Partial<ModelCredentialUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private resetDraft(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.draft.clear();this.clearInputs();}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Model credential file save outcome unknown - check its original desired file':'Model credential file editor invalidated - begin a fresh edit',busy:false,view:null,actions:empty(),valid:false,reference:this.possible?this.original?.reference??null:null,uncertain:this.possible});}
 text(key:ModelCredentialKey){return this.draft.display(key);}
 private editable(){return !this.state.busy&&this.state.view?.state==='ready';}
 private refreshValidity(){
  let valid=this.editable()&&CREDENTIAL_KEYS.some(k=>this.state.actions[k]!=='keep')&&CREDENTIAL_KEYS.every(k=>!['replace','install'].includes(this.state.actions[k])||this.draft.valid(k));
  if(valid){let change:ModelCredentialChange|null=null;try{change=this.draft.patch(this.state.actions);parseModelCredentialRequest({action:'save',connection_id:'a'.repeat(64),boot_id:'11111111-1111-4111-8111-111111111111',reference:'b'.repeat(64),change});}catch{valid=false;}finally{if(change&&'value'in change)change.value='';change=null;}}
  this.publish({valid});
 }
 action(key:ModelCredentialKey,value:string){if(!this.editable()||!['keep','install','replace','remove'].includes(value)||value==='install'&&this.state.view?.current?.present||value==='replace'&&!this.state.view?.current?.present)return;this.draft.clear(key);this.clearInputs(key);this.publish({actions:{...this.state.actions,[key]:value as ModelCredentialAction},});this.refreshValidity();}
 beforeInput(key:ModelCredentialKey,start:number,end:number,type:string,data:string|null){if(this.editable()&&['install','replace'].includes(this.state.actions[key]))this.draft.beforeInput(key,start,end,type,data);}
 input(key:ModelCredentialKey,value:string){if(!this.editable()||!['install','replace'].includes(this.state.actions[key]))return;const ok=this.draft.input(key,value);this.publish({status:ok?labels['ready']:'Replacement edit refused - enter a fresh valid replacement'});this.refreshValidity();}
 paste(key:ModelCredentialKey,start:number,end:number,text:string){if(!this.editable()||!['install','replace'].includes(this.state.actions[key]))return;const ok=this.draft.paste(key,start,end,text);this.publish({status:ok?labels['ready']:'Replacement paste refused - enter a fresh valid replacement'});this.refreshValidity();}
 private async call(adapter:ModelCredentialAdapter,request:ModelCredentialRequest|null,generation:number){
  if(!request)throw Error('Model credential file request refused');parseModelCredentialRequest(request);const context=modelCredentialContext(request),pending=adapter.modelCredential(request);request=null;
  let timer:ReturnType<typeof setTimeout>|undefined;let value:ModelCredentialResult;try{value=await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Model credential wait expired')),14000);})]);}finally{clearTimeout(timer);}parseModelCredentialResult(value,context,validateResult);if(generation!==this.generation)return;this.pendingAction=null;this.resetDraft();
  const q=value.model_credential,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(q.state);if(settled){this.possible=false;this.original=null;}
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state),removed=settled?context.reference:null,retained=[...q.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  this.publish({status:q.retained.some(x=>!x.status_available)?'Outcome unknown. Original check is no longer available; the current saved file cannot prove what this operation did.':labels[q.state],busy:false,view:q,reference:q.reference,actions:empty(),valid:false,retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
  if(q.state==='ready'&&performance.now()>=this.readyDeadline){this.clear();return;}
  if(q.state==='ready'){const g=this.generation;this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},Math.max(0,this.readyDeadline-performance.now()));(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:ModelCredentialAdapter){if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='retained';this.publish({busy:true,actions:empty(),valid:false,status:'Reading retained host credential file diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained credential file diagnostics unavailable'});}}
 async begin(adapter:ModelCredentialAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.readyDeadline=performance.now()+120000;this.pendingAction='begin';this.publish({busy:true,view:null,actions:empty(),valid:false,reference:null,status:'Pausing observation before a fresh credential file editor read...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Model credential file read invalidated'});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Model credential file settings unavailable or response refused',view:null});}
 }
 async save(adapter:ModelCredentialAdapter,tablet:TabletObservation){
  if(!this.editable()||!this.state.valid||!this.state.reference||this.state.retained.length>=8)return;
  let change=parseModelCredentialChange(this.draft.patch(this.state.actions));const reference=this.state.reference,g=++this.generation;this.resetDraft();try{parseModelCredentialRequest({action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,change});}catch{if('value'in change)change.value='';change={action:'remove'};this.publish({busy:false,view:null,reference:null,actions:empty(),valid:false,status:'Model credential file save refused locally - no request was dispatched'});return;}this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown',status_available:true};this.possible=true;this.pendingAction='save';this.publish({busy:true,actions:empty(),valid:false,status:'Saving original credential file declarations - replacement text cleared...'});
  try{const pending=this.call(adapter,{action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,change},g);change={action:'remove'};await pending;}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Model credential file save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}finally{if('value'in change)change.value='';change={action:'remove'};}
 }
 async status(adapter:ModelCredentialAdapter,original:ModelCredentialRetained,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy||!original.status_available||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;this.resetDraft();const g=++this.generation;this.original=original;this.possible=true;this.pendingAction='status';this.publish({busy:true,view:null,reference:original.reference,actions:empty(),valid:false,status:'Checking original desired file without replacement text...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Model credential file status check invalidated'});return;}await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check unavailable - original outcome remains unknown'});}
 }
 async stop(adapter:ModelCredentialAdapter){
  const g=++this.generation,reference=this.state.reference,original=this.original,pending=this.pendingAction;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({busy:true,actions:empty(),valid:false,status:'Stopping credential file wait; replacement text cleared...'});const owns=()=>g===this.generation&&this.state.reference===reference&&this.original===original;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{if(reference&&pending!=='retained'){const request={action:'cancel' as const,reference},value=await Promise.race([adapter.modelCredential(request),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Model credential stop wait expired')),14000);})]);if(!owns())return;parseModelCredentialResult(value,request,validateResult);if(!owns())return;if(['not-dispatched','invalidated'].includes(value.model_credential.state)){this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});}}}catch{if(!owns())return;}finally{clearTimeout(timer);}
  if(g===this.generation&&this.state.reference===reference)this.publish({busy:false,view:null,status:this.possible?'Model credential file save outcome unknown - stopping is not rollback':pending==='retained'?'Retained credential file read stopped':'Model credential file editor invalidated - no save was requested',uncertain:this.possible});
 }
}
