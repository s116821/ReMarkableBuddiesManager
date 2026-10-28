import {parseManagementRequest,parseManagementResult,type ManagementRequest,type ManagementResult,type ManagementView,type ManagementRetained} from '../host/conversation-management-protocol.mjs';
import {basicUuid} from '../host/basic-settings-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface ManagementAdapter {conversationManagement(request:ManagementRequest):Promise<ManagementResult>}
export interface ManagementUiState {selection:string;busy:boolean;status:string;view:ManagementView|null;retained:ManagementRetained[]}
const labels:Record<string,string>={inspected:'Conversation inspected — prepare a fresh removal preview',ready:'Logical-removal preview ready — deliberate confirmation required',acknowledged:'Original logical-removal receipt verified — current state is shown separately',unknown:'Original outcome unknown — check only this original; never retry Apply',unchanged:'Original state observed unchanged — historical no-deletion is unproven; no retry',unresolved:'Original outcome unresolved — no receipt acknowledgment; no retry','not-dispatched':'This confirmation did not dispatch a logical removal',unsupported:'Conversation management unsupported',unavailable:'Conversation management unavailable — no new authority',busy:'Another bounded operation is busy',capacity:'Original-operation capacity reached — originals were preserved',invalidated:'Conversation preview invalidated'};
export class ConversationManagementController {
 state:ManagementUiState={selection:'',busy:false,status:'No conversation selected',view:null,retained:[]};
 private generation=0;private active:{reference:string|null;invocation:string}|null=null;private readyInvocation:string|null=null;
 private timer:ReturnType<typeof setTimeout>|undefined;private readonly expiries=new Map<string,number>();private readonly expiryTimers=new Map<string,ReturnType<typeof setTimeout>>();
 private readonly changed:(s:ManagementUiState)=>void;private readonly erase:()=>void;private readonly now:()=>number;private readonly uuid:()=>string;
 constructor(changed:(s:ManagementUiState)=>void,erase:()=>void=()=>{},now:()=>number=()=>performance.now(),uuid:()=>string=()=>crypto.randomUUID()){this.changed=changed;this.erase=erase;this.now=now;this.uuid=uuid;}
 canCheck(row:ManagementRetained){return row.status_available&&(this.expiries.get(row.reference)??Infinity)>this.now();}
 private expireAt(reference:string,deadline:number){this.expiries.set(reference,deadline);if(this.expiryTimers.has(reference))return;const timer=setTimeout(()=>{this.expiryTimers.delete(reference);this.publish({retained:this.state.retained.map(r=>r.reference===reference?{...r,status_available:false}:r)});},Math.max(1,deadline-this.now()));this.expiryTimers.set(reference,timer);(timer as unknown as {unref?:()=>void}).unref?.();}
 dispose(){this.clear();for(const timer of this.expiryTimers.values())clearTimeout(timer);this.expiryTimers.clear();}
 private publish(p:Partial<ManagementUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private rows(rows:ManagementRetained[]){const merged=new Map(this.state.retained.map(r=>[r.reference,r]));for(const r of rows)merged.set(r.reference,{...r,status_available:r.status_available&&(this.expiries.get(r.reference)??Infinity)>this.now()});return [...merged.values()];}
 valid(){return basicUuid(this.state.selection);}
 select(value:string){if(this.state.busy)return;this.generation++;clearTimeout(this.timer);this.readyInvocation=null;this.active=null;this.publish({selection:value,view:null,status:'Select a conversation and inspect it afresh'});}
 clear(){this.generation++;clearTimeout(this.timer);this.active=null;this.readyInvocation=null;this.erase();this.publish({selection:'',view:null,busy:false,status:'Conversation preview cleared'});}
 private accept(view:ManagementView){let retained=this.rows(view.retained);if(view.reference&&['unavailable','unsupported'].includes(view.state)&&!view.retained.some(r=>r.reference===view.reference))retained=retained.map(r=>r.reference===view.reference?{...r,status_available:false}:r);if((['acknowledged'].includes(view.state)||view.state==='not-dispatched'&&!view.retained.some(r=>r.reference===view.reference))){retained=retained.filter(r=>r.reference!==view.reference);if(view.reference){clearTimeout(this.expiryTimers.get(view.reference));this.expiryTimers.delete(view.reference);this.expiries.delete(view.reference);}}this.publish({busy:false,view,retained,status:labels[view.state]??'Conversation management unavailable'});}
 private localUnknown(reference:string,tablet:TabletObservation,conversation:string){this.readyInvocation=null;const row:ManagementRetained={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,conversation,state:'unknown',status_available:(this.expiries.get(reference)??0)>this.now()};this.publish({busy:false,view:{state:'unknown',reference,preview:null,report:null,retained:[row]},retained:this.rows([row]),status:'Original outcome unknown — original check may be unavailable; never retry confirmation'});}
 async inspect(adapter:ManagementAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){if(this.state.busy||!this.valid()||this.state.retained.length>=8)return;await this.run(adapter,tablet,'inspect',null,this.state.selection,pause);}
 async prepare(adapter:ManagementAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){const v=this.state.view;if(this.state.busy||v?.state!=='inspected'||!v.reference||!v.preview)return;await this.run(adapter,tablet,'prepare',v.reference,v.preview.conversation,pause);}
 async confirm(adapter:ManagementAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){const v=this.state.view;if(this.state.busy||v?.state!=='ready'||!v.reference||!v.preview)return;await this.run(adapter,tablet,'confirm',v.reference,v.preview.conversation,pause);}
 async status(adapter:ManagementAdapter,tablet:TabletObservation,row:ManagementRetained,pause:()=>Promise<boolean>){if(this.state.busy||!this.canCheck(row)||tablet.connection_id!==row.connection_id||tablet.boot_id!==row.boot_id)return;await this.run(adapter,tablet,'status',row.reference,row.conversation,pause);}
 async retained(adapter:ManagementAdapter){const g=this.generation;try{const q={action:'retained' as const},v=await adapter.conversationManagement(q);if(g===this.generation)this.publish({retained:this.rows(parseManagementResult(v,q,validateResult).conversation_management.retained)});}catch{/* Memory-only original list is optional; never recover using a fresh operation. */}}
 private async run(adapter:ManagementAdapter,tablet:TabletObservation,action:'inspect'|'prepare'|'confirm'|'status',reference:string|null,conversation:string,pause:()=>Promise<boolean>){
  const invocation=this.uuid(),g=++this.generation,started=this.now();let timer:ReturnType<typeof setTimeout>|undefined,possible=false;
  clearTimeout(this.timer);this.readyInvocation=null;this.active={reference,invocation};this.erase();this.publish({selection:'',view:null,busy:true,status:action==='inspect'?'Inspecting selected conversation...':action==='prepare'?'Preparing logical-removal preview...':action==='confirm'?'Confirming logical removal...':'Checking original logical removal...'});
  const q=parseManagementRequest(action==='inspect'?{action,...{connection_id:tablet.connection_id,boot_id:tablet.boot_id},conversation,invocation}:{action,connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,invocation});
  try{
   const result=await Promise.race([(async()=>{if(!await pause()||g!==this.generation)return null;if(action==='confirm'&&reference){possible=true;this.expireAt(reference,started+1800000);this.publish({retained:this.rows([{reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,conversation,state:'unknown',status_available:true}])});}const v=await adapter.conversationManagement(q);if(g!==this.generation)return null;return parseManagementResult(v,q,validateResult);})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Management wait expired')),14000);})]);
   if(g!==this.generation)return;this.active=null;
   if(!result){this.clear();return;}const v=result.conversation_management;this.accept(v);
   if(['inspect','prepare'].includes(action)&&['inspected','ready'].includes(v.state)){
    this.readyInvocation=invocation;const ref=v.reference;this.timer=setTimeout(()=>{if(g===this.generation&&this.state.view?.reference===ref){this.clear();this.publish({status:'Conversation preview expired — inspect and prepare afresh'});}},Math.max(1,120000-(this.now()-started)));
   }
  }catch{if(g===this.generation){this.generation++;this.active=null;if(action==='confirm'&&possible&&reference)this.localUnknown(reference,tablet,conversation);else this.publish({busy:false,view:null,status:'Conversation management unavailable — no new authority'});}}
  finally{clearTimeout(timer);}
 }
 async stop(adapter:ManagementAdapter){
  const target=this.active?.reference?{...this.active,reference:this.active.reference}:['inspected','ready'].includes(this.state.view?.state??'')&&this.state.view?.reference&&this.readyInvocation?{reference:this.state.view.reference,invocation:this.readyInvocation}:null;
  const active=this.active,view=this.state.view,rows=this.state.retained;this.clear();const g=this.generation;
  // Without an already captured tuple Stop is entirely local.
  if(!target){this.publish({status:'Management wait stopped locally — bounded preparation may still finish'});return;}
  if(active&&view===null&&rows.some(r=>r.reference===target.reference))this.publish({retained:rows});
  this.publish({busy:true,status:'Stopping the captured conversation management invocation...'});let timer:ReturnType<typeof setTimeout>|undefined;
  const q=parseManagementRequest({action:'cancel',...target});
  try{const result=await Promise.race([adapter.conversationManagement(q),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Stop wait expired')),14000);})]);if(g!==this.generation)return;this.accept(parseManagementResult(result,q,validateResult).conversation_management);}
  catch{if(g===this.generation){this.generation++;this.publish({busy:false,view:null,status:'Management Stop wait ended — historical outcome remains unverified'});}}
  finally{clearTimeout(timer);}
 }
}
