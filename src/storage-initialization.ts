import {parseStorageInitializationResult,type StorageInitializationRequest,type StorageInitializationResult,type StorageInitializationView,type StorageInitializationRetained} from '../host/storage-initialization-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface StorageInitializationAdapter{storageInitialization(request:StorageInitializationRequest):Promise<StorageInitializationResult>}
export interface StorageInitializationUiState{status:string;busy:boolean;view:StorageInitializationView|null;retained:StorageInitializationRetained[]}
const labels:Record<string,string>={none:'Storage setup not reviewed',ready:'Review complete — confirm setup',prepared:'Buddy storage prepared — runtime and cloud unverified',unknown:'Storage setup not confirmed — no automatic retry',busy:'Another task is running',capacity:'The setup history or check limit is full',invalidated:'Review cancelled — start again',expired:'Review expired — start again',unsupported:'Buddy storage setup unsupported',unavailable:'Storage setup unavailable — read tablet state again'};
export class StorageInitializationController{
 state:StorageInitializationUiState={status:labels['none'],busy:false,view:null,retained:[]};
 private generation=0;private timer:ReturnType<typeof setTimeout>|undefined;private context:{reference:string;invocation:string|null}|null=null;private adapter:StorageInitializationAdapter|null=null;private original:StorageInitializationRetained|null=null;private possible=false;
 private readonly changed:(s:StorageInitializationUiState)=>void;
 constructor(changed:(s:StorageInitializationUiState)=>void){this.changed=changed;}
 private publish(p:Partial<StorageInitializationUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private keepUnknown(){if(!this.original)return;const r={...this.original,outcome:'unknown' as const,reason:'cancelled' as const},rows=this.state.retained.filter(x=>x.reference!==r.reference);this.publish({retained:[...rows,r].slice(0,8)});}
 private cancelCaptured(){const q=this.context,a=this.adapter;this.context=null;if(q&&a)void a.storageInitialization({action:'cancel',...q}).catch(()=>{});}
 clear(){clearTimeout(this.timer);this.generation++;if(this.possible)this.keepUnknown();this.possible=false;this.cancelCaptured();this.publish({busy:false,view:null,status:'Setup view cleared — earlier results unchanged'});}
 stop(){this.clear();this.publish({status:'Setup wait stopped — storage may have changed'});}
 private async bounded<T>(p:Promise<T>,deadline:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Storage setup wait expired')),Math.max(1,deadline-performance.now()));})]);}finally{clearTimeout(timer);}}
 private merge(rows:StorageInitializationRetained[]){const next=[...rows];for(const r of this.state.retained)if(!next.some(x=>x.reference===r.reference))next.push(r);return next.slice(0,8);}
 private async perform(adapter:StorageInitializationAdapter,q:StorageInitializationRequest,pause:()=>Promise<boolean>,status:string){
  if(this.state.busy)return;clearTimeout(this.timer);this.adapter=adapter;const g=++this.generation,deadline=performance.now()+14000;this.publish({busy:true,view:null,status});
  try{
   if(!await this.bounded(pause(),deadline)||g!==this.generation)return;
   if(performance.now()>=deadline)throw Error('Storage setup wait expired');
   if(q.action==='confirm'){this.possible=true;this.original={reference:q.reference,connection_id:q.connection_id,boot_id:q.boot_id,outcome:'unknown',reason:'unavailable'};}
   const v=await this.bounded(adapter.storageInitialization(q),deadline);parseStorageInitializationResult(v,q,validateResult);
   const s=v.storage_initialization;
   if(g!==this.generation){if(s.state==='ready'&&s.reference)void adapter.storageInitialization({action:'cancel',reference:s.reference,invocation:null}).catch(()=>{});return;}
   this.possible=false;this.context=s.state==='ready'&&s.reference?{reference:s.reference,invocation:null}:null;
   if(s.state==='ready'){this.timer=setTimeout(()=>this.clear(),120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
   const rows=this.merge(s.retained);let text=labels[s.state];
   if(q.action==='refresh')text=s.current?'Current storage checked — the earlier setup result has not changed':'Current storage unavailable — the earlier setup result has not changed';
   if(q.action==='retained')text='Earlier setup attempts loaded';
   this.publish({busy:false,view:s,retained:rows,status:text});
  }catch{
   if(g===this.generation){this.generation++;if(this.possible)this.keepUnknown();this.possible=false;this.cancelCaptured();this.publish({busy:false,view:null,status:q.action==='confirm'?labels['unknown']:'Storage setup unavailable'});}
  }finally{if(g===this.generation&&this.state.busy)this.publish({busy:false,status:'Setup wait cancelled'});}
 }
 async retained(adapter:StorageInitializationAdapter){await this.perform(adapter,{action:'retained'},async()=>true,'Reading earlier setup attempts…');}
 async begin(adapter:StorageInitializationAdapter,t:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy||this.state.retained.some(r=>r.connection_id===t.connection_id&&r.outcome==='unknown'))return;this.cancelCaptured();this.original=null;this.possible=false;await this.perform(adapter,{action:'begin',connection_id:t.connection_id,boot_id:t.boot_id},pause,'Preparing the storage setup review…');
 }
 async confirm(adapter:StorageInitializationAdapter,t:TabletObservation,pause:()=>Promise<boolean>){
  const ref=this.state.view?.reference;if(this.state.busy||this.state.view?.state!=='ready'||!ref)return;const invocation=crypto.randomUUID();this.context={reference:ref,invocation};await this.perform(adapter,{action:'confirm',connection_id:t.connection_id,boot_id:t.boot_id,reference:ref,invocation},pause,'Preparing Buddy storage…');
 }
 async refresh(adapter:StorageInitializationAdapter,t:TabletObservation,r:StorageInitializationRetained,pause:()=>Promise<boolean>){
  if(this.state.busy||r.connection_id!==t.connection_id||r.boot_id!==t.boot_id)return;const invocation=crypto.randomUUID();this.context={reference:r.reference,invocation};this.original=r;this.possible=false;await this.perform(adapter,{action:'refresh',connection_id:t.connection_id,boot_id:t.boot_id,reference:r.reference,invocation},pause,'Checking current storage…');
 }
}
