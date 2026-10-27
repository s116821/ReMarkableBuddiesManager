import {parseConversationRequest,parseConversationResult,type ConversationRequest,type ConversationResult,type ConversationView} from '../host/conversation-inventory-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface ConversationAdapter {inspectConversations(request:ConversationRequest):Promise<ConversationResult>}
export interface ConversationUiState {status:string;busy:boolean;view:ConversationView|null;checkedAt:string|null}
const label=(view:ConversationView)=>view.status==='complete'?(view.candidates!.length?'Conversation ID snapshot inspected':'No current supported conversation IDs observed'):`Conversation inventory ${view.status} - no candidate list admitted`;
export class ConversationInventoryController {
 state:ConversationUiState={status:'Conversation IDs not inspected',busy:false,view:null,checkedAt:null};
 private generation=0;private readonly changed:(v:ConversationUiState)=>void;
 constructor(changed:(v:ConversationUiState)=>void){this.changed=changed;}
 private publish(v:ConversationUiState){this.state=v;this.changed(v);}
 clear(){this.generation++;this.publish({status:'Conversation IDs not inspected',busy:false,view:null,checkedAt:null});}
 stop(){this.generation++;this.publish({status:'Inspection wait stopped - the bounded host read may still finish',busy:false,view:null,checkedAt:null});}
 async inspect(adapter:ConversationAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy)return;const g=++this.generation;let timer:ReturnType<typeof setTimeout>|undefined;this.publish({status:'Inspecting conversation IDs...',busy:true,view:null,checkedAt:null});
  try{
   const value=await Promise.race([(async()=>{if(!await pause()||g!==this.generation)return null;const q=parseConversationRequest({connection_id:tablet.connection_id,boot_id:tablet.boot_id}),v=await adapter.inspectConversations(q);if(g!==this.generation)return null;parseConversationResult(v,q,validateResult);return v;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Inventory wait expired')),14000);})]);
   if(g!==this.generation)return;if(!value){this.clear();return;}const result=value.conversation_inventory;this.publish({busy:false,view:result.view,checkedAt:result.status==='reported'?new Date().toISOString():null,status:result.status==='reported'?label(result.view!):`Conversation inventory ${result.status}`});
  }catch{if(g===this.generation){this.generation++;this.publish({status:'Conversation inventory unavailable - no candidate list admitted',busy:false,view:null,checkedAt:null});}}
  finally{clearTimeout(timer);}
 }
}
