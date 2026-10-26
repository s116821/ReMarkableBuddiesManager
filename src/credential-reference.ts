import { CREDENTIAL_KEYS,parseCredentialReferenceRequest,parseCredentialReferenceResult,parseCredentialChange,credentialResponseContext,credentialName,type CredentialChange,type CredentialReferenceRequest,type CredentialReferenceResult,type CredentialKey,type CredentialRetained,type CredentialView } from '../host/credential-reference-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { TabletObservation } from './observation';
// Raw scalar drafts stay separate from normalized textarea display and safe UI state.
export type CredentialAction='keep'|'replace'|'clear';
import {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
export {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
export class CredentialDraft {
 private raw:Record<CredentialKey,string>={model_credential:''};private version=0;
 private before:{key:CredentialKey;version:number;start:number;end:number;type:string;data:string|null}|null=null;
 private invalid:Record<CredentialKey,boolean>={model_credential:false};
 display(key:CredentialKey){return displayModelText(this.raw[key]);}
 clear(key?:CredentialKey){this.version++;this.before=null;for(const k of key?[key]:['model_credential'] as CredentialKey[]){this.raw[k]='';this.invalid[k]=false;}}
 beforeInput(key:CredentialKey,start:number,end:number,type:string,data:string|null){this.before={key,version:this.version,start,end,type,data};}
 private store(key:CredentialKey,value:string){
  if(key!=='model_credential')return false;
  // Transport/scalar bounds only; the producer owns credential name validation.
  if([...value].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;})||new TextEncoder().encode(value).length>80){this.invalid[key]=true;this.version++;this.before=null;return false;}
  this.raw[key]=value;this.invalid[key]=false;this.version++;this.before=null;return true;
 }
 paste(key:CredentialKey,start:number,end:number,text:string){try{return this.store(key,spliceModelText(this.raw[key],start,end,text));}catch{this.invalid[key]=true;this.before=null;return false;}}
 input(key:CredentialKey,next:string){
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
 valid(key:CredentialKey){return !this.invalid[key]&&credentialName(this.raw[key]);}
 patch(actions:Record<CredentialKey,CredentialAction>):CredentialChange{
  if(actions.model_credential==='clear')return {action:'clear'};
  if(actions.model_credential==='replace'&&this.valid('model_credential'))return {action:'set',value:this.raw.model_credential};throw Error('Private replacement refused');
 }
}

export interface CredentialReferenceAdapter {credentialReference(request:CredentialReferenceRequest):Promise<CredentialReferenceResult>}
export interface CredentialUiState {status:string;busy:boolean;view:CredentialView|null;reference:string|null;actions:Record<CredentialKey,CredentialAction>;valid:boolean;retained:CredentialRetained[];uncertain:boolean}
const empty=():Record<CredentialKey,CredentialAction>=>({model_credential:'keep'});
const labels:Record<string,string>={none:'Begin a fresh edit to read saved credential reference declarations',ready:'Saved declaration origins ready - enter replacements deliberately',invalidated:'Credential reference editor invalidated - begin a fresh edit',unsupported:'Installed credential reference editor is unsupported',unavailable:'Credential reference editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unconfirmed credential reference saves are retained - check an original desired file first','not-dispatched':'This credential reference save was not dispatched','no-change':'No saved credential reference change was needed',verified:'Saved credential reference declarations verified - runtime activation and authentication remain unverified',unknown:'Credential reference save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original credential reference save remains unconfirmed','desired-file-observed':'Desired saved file observed - historical publisher and runtime remain unverified'};
export class CredentialReferenceController {
 state:CredentialUiState={status:'Not inspected',busy:false,view:null,reference:null,actions:empty(),valid:false,retained:[],uncertain:false};
 private generation=0;private pendingAction:CredentialReferenceRequest['action']|null=null;private possible=false;private original:CredentialRetained|null=null;
 private draft=new CredentialDraft();private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly changed:(v:CredentialUiState)=>void;private readonly clearInputs:(key?:CredentialKey)=>void;
 constructor(changed:(v:CredentialUiState)=>void,clearInputs:(key?:CredentialKey)=>void=()=>{}){this.changed=changed;this.clearInputs=clearInputs;}
 private publish(p:Partial<CredentialUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private resetDraft(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.draft.clear();this.clearInputs();}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Credential reference save outcome unknown - check its original desired file':'Credential reference editor invalidated - begin a fresh edit',busy:false,view:null,actions:empty(),valid:false,reference:this.possible?this.original?.reference??null:null,uncertain:this.possible});}
 text(key:CredentialKey){return this.draft.display(key);}
 private editable(){return !this.state.busy&&this.state.view?.state==='ready';}
 private refreshValidity(){this.publish({valid:this.editable()&&CREDENTIAL_KEYS.some(k=>this.state.actions[k]!=='keep')&&CREDENTIAL_KEYS.every(k=>this.state.actions[k]!=='replace'||this.draft.valid(k))});}
 action(key:CredentialKey,value:string){if(!this.editable()||!['keep','replace','clear'].includes(value))return;this.draft.clear(key);this.clearInputs(key);this.publish({actions:{...this.state.actions,[key]:value as CredentialAction},});this.refreshValidity();}
 beforeInput(key:CredentialKey,start:number,end:number,type:string,data:string|null){if(this.editable()&&this.state.actions[key]==='replace')this.draft.beforeInput(key,start,end,type,data);}
 input(key:CredentialKey,value:string){if(!this.editable()||this.state.actions[key]!=='replace')return;const ok=this.draft.input(key,value);this.publish({status:ok?labels['ready']:'Replacement edit refused - enter a fresh valid replacement'});this.refreshValidity();}
 paste(key:CredentialKey,start:number,end:number,text:string){if(!this.editable()||this.state.actions[key]!=='replace')return;const ok=this.draft.paste(key,start,end,text);this.publish({status:ok?labels['ready']:'Replacement paste refused - enter a fresh valid replacement'});this.refreshValidity();}
 private async call(adapter:CredentialReferenceAdapter,request:CredentialReferenceRequest|null,generation:number){
  if(!request)throw Error('Credential reference request refused');parseCredentialReferenceRequest(request);const context=credentialResponseContext(request),pending=adapter.credentialReference(request);request=null;
  const value=await pending;parseCredentialReferenceResult(value,context,validateResult);if(generation!==this.generation)return;this.pendingAction=null;this.resetDraft();
  const q=value.credential_reference,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(q.state);if(settled){this.possible=false;this.original=null;}
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state),removed=settled?context.reference:null,retained=[...q.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  this.publish({status:labels[q.state],busy:false,view:q,reference:q.reference,actions:empty(),valid:false,retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
  if(q.state==='ready'){const g=this.generation;this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:CredentialReferenceAdapter){if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='retained';this.publish({busy:true,actions:empty(),valid:false,status:'Reading retained host credential reference diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained credential reference diagnostics unavailable'});}}
 async begin(adapter:CredentialReferenceAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.resetDraft();const g=++this.generation;this.pendingAction='begin';this.publish({busy:true,view:null,actions:empty(),valid:false,reference:null,status:'Pausing observation before a fresh credential reference editor read...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Credential reference read invalidated'});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Credential reference settings unavailable or response refused',view:null});}
 }
 async save(adapter:CredentialReferenceAdapter,tablet:TabletObservation){
  if(!this.editable()||!this.state.valid||!this.state.reference||this.state.retained.length>=8)return;
  let change=parseCredentialChange(this.draft.patch(this.state.actions));const reference=this.state.reference,g=++this.generation;this.resetDraft();try{parseCredentialReferenceRequest({action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,change});}catch{if(change.action==='set')change.value='';change={action:'clear'};this.publish({busy:false,view:null,reference:null,actions:empty(),valid:false,status:'Credential reference save refused locally - no request was dispatched'});return;}this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.possible=true;this.pendingAction='save';this.publish({busy:true,actions:empty(),valid:false,status:'Saving original credential reference declarations - replacement text cleared...'});
  try{const pending=this.call(adapter,{action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,change},g);change={action:'clear'};await pending;}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Credential reference save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}finally{if(change.action==='set')change.value='';change={action:'clear'};}
 }
 async status(adapter:CredentialReferenceAdapter,original:CredentialRetained,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;this.resetDraft();const g=++this.generation;this.original=original;this.possible=true;this.pendingAction='status';this.publish({busy:true,view:null,reference:original.reference,actions:empty(),valid:false,status:'Checking original desired file without replacement text...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Credential reference status check invalidated'});return;}await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check unavailable - original outcome remains unknown'});}
 }
 async stop(adapter:CredentialReferenceAdapter){
  const g=++this.generation,reference=this.state.reference,original=this.original,pending=this.pendingAction;this.pendingAction=null;this.resetDraft();if(this.possible)this.keepOriginal();this.publish({busy:true,actions:empty(),valid:false,status:'Stopping credential reference wait; replacement text cleared...'});const owns=()=>g===this.generation&&this.state.reference===reference&&this.original===original;
  try{if(reference&&pending!=='retained'){const request={action:'cancel' as const,reference},value=await adapter.credentialReference(request);if(!owns())return;parseCredentialReferenceResult(value,request,validateResult);if(!owns())return;if(['not-dispatched','invalidated'].includes(value.credential_reference.state)){this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});}}}catch{if(!owns())return;}
  if(g===this.generation&&this.state.reference===reference)this.publish({busy:false,view:null,status:this.possible?'Credential reference save outcome unknown - stopping is not rollback':pending==='retained'?'Retained credential reference read stopped':'Credential reference editor invalidated - no save was requested',uncertain:this.possible});
 }
}
