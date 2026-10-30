import {parseLocalModeRequest,parseLocalModeResult,type LocalModeRequest,type LocalModeResult,type LocalModeRetained,type LocalModeView} from '../host/local-mode-choice-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface LocalModeAdapter{localModeChoice(request:LocalModeRequest):Promise<LocalModeResult>}
export interface LocalModeUiState{status:string;busy:boolean;view:LocalModeView|null;reference:string|null;retained:LocalModeRetained[]}
const labels:Record<string,string>={none:'Review the change before saving Local-only mode',ready:'Review complete — ready to save',invalidated:'Review cancelled or expired — review the change again',unsupported:'This version of Buddy cannot save this setting',unavailable:'Could not read the setting — read tablet state again',busy:'Another task is running — try again when it finishes',capacity:'The change history is full — another change cannot be saved here',refused:'The change was not saved',acknowledged:'Local-only mode was saved',unknown:'Save not confirmed — it will not be retried automatically'};
export class LocalModeChoiceController{
 state:LocalModeUiState={status:'Not reviewed',busy:false,view:null,reference:null,retained:[]};
 private generation=0;private action:LocalModeRequest['action']|null=null;private original:LocalModeRetained|null=null;private possible=false;private deadline=0;private timer:ReturnType<typeof setTimeout>|undefined;
 private readonly changed:(s:LocalModeUiState)=>void;
 constructor(changed:(s:LocalModeUiState)=>void){this.changed=changed;}
 private publish(p:Partial<LocalModeUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private keep(){if(this.original&&!this.state.retained.some(r=>r.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){clearTimeout(this.timer);this.generation++;this.action=null;if(this.possible)this.keep();this.publish({busy:false,view:null,reference:this.possible?this.original?.reference??null:null,status:this.possible?labels['unknown']:labels['invalidated']});}
 private async bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Local-only wait expired')),Math.max(1,this.deadline-performance.now()));})]);}finally{clearTimeout(timer);}}
 private async call(adapter:LocalModeAdapter,q:LocalModeRequest,g:number){
  parseLocalModeRequest(q);if(performance.now()>=this.deadline)throw Error('Local-only wait expired');const v=await this.bounded(adapter.localModeChoice(q));parseLocalModeResult(v,q,validateResult);if(g!==this.generation)return;this.action=null;
  const view=v.local_mode_choice,retained=[...view.retained];
  for(const r of this.state.retained)if(!retained.some(x=>x.reference===r.reference))retained.push(r);
  const matching=this.original?retained.find(r=>r.reference===this.original!.reference):null;
  if(['acknowledged','refused','invalidated','capacity'].includes(view.state)||q.action==='choose'&&['busy','unavailable'].includes(view.state)&&matching?.state!=='unknown'){this.possible=false;this.original=null;}
  if(view.state==='unknown'){this.possible=true;this.original=retained.find(r=>r.reference===view.reference)??this.original;}
  if(view.state==='ready'){clearTimeout(this.timer);this.timer=setTimeout(()=>this.clear(),120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
  let status=labels[view.state];if(q.action==='refresh')status=view.state==='unknown'?'Saved mode checked — the earlier save is still unconfirmed':view.current?'Saved mode checked — earlier results have not changed':`${status}; the saved mode could not be checked`;
  this.publish({busy:false,status,view,reference:view.reference,retained:retained.slice(0,8)});if(this.possible)this.keep();
 }
 async retained(adapter:LocalModeAdapter){if(this.state.busy)return;this.deadline=performance.now()+14000;const g=++this.generation;this.action='retained';this.publish({busy:true,status:'Reading recent changes…'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Recent changes could not be read'});}}
 async begin(adapter:LocalModeAdapter,t:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;clearTimeout(this.timer);this.deadline=performance.now()+14000;const g=++this.generation;this.action='begin';this.publish({busy:true,view:null,reference:null,status:'Reading the saved mode…'});
  try{if(!await this.bounded(pause())||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:labels['invalidated']});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:t.connection_id,boot_id:t.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'The saved mode could not be read'});}
 }
 async choose(adapter:LocalModeAdapter,t:TabletObservation){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.reference||this.state.retained.some(r=>r.connection_id===t.connection_id&&r.state==='unknown'))return;
  clearTimeout(this.timer);this.deadline=performance.now()+14000;const g=++this.generation,reference=this.state.reference;this.original={reference,connection_id:t.connection_id,boot_id:t.boot_id,state:'unknown'};this.possible=true;this.action='choose';this.publish({busy:true,view:null,status:'Saving Local-only mode…'});
  try{await this.call(adapter,{action:'choose',connection_id:t.connection_id,boot_id:t.boot_id,reference},g);}catch{if(g===this.generation){this.keep();this.publish({busy:false,view:null,status:labels['unknown']});}}
 }
 async refresh(adapter:LocalModeAdapter,t:TabletObservation,r:LocalModeRetained,pause:()=>Promise<boolean>){
  if(this.state.busy||t.connection_id!==r.connection_id||t.boot_id!==r.boot_id)return;clearTimeout(this.timer);this.deadline=performance.now()+14000;const g=++this.generation;this.original=r;this.possible=r.state==='unknown';this.action='refresh';this.publish({busy:true,view:null,reference:r.reference,status:'Checking the saved mode without saving again…'});
  try{if(!await this.bounded(pause())||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Check cancelled — the earlier save result has not changed'});return;}await this.call(adapter,{action:'refresh',connection_id:t.connection_id,boot_id:t.boot_id,reference:r.reference},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Saved mode could not be checked — the earlier save result has not changed'});}
 }
 async stop(adapter:LocalModeAdapter,cancel:()=>Promise<unknown>){
  const pending=this.action,reference=this.state.reference;this.clear();const g=this.generation;this.deadline=performance.now()+14000;this.publish({busy:true,status:'Stopping the wait…'});
  try{if(reference&&pending!=='retained'){const q={action:'cancel' as const,reference},v=await this.bounded(adapter.localModeChoice(q));if(g!==this.generation)return;parseLocalModeResult(v,q,validateResult);if(v.local_mode_choice.state==='invalidated'){this.possible=false;this.original=null;}}else if(pending==='begin')await this.bounded(cancel());}catch{/* Stopping never proves rollback. */}
  if(g===this.generation)this.publish({busy:false,view:null,status:this.possible?labels['unknown']:pending==='retained'?'Stopped reading recent changes':labels['invalidated']});
 }
}
