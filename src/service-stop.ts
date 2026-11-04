import {parseServiceStopResult,type ServiceStopRequest,type ServiceStopResult,type ServiceStopView,type ServiceStopRetained} from '../host/service-stop-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface ServiceStopAdapter{serviceStop(request:ServiceStopRequest):Promise<ServiceStopResult>}
export interface ServiceStopUiState{status:string;busy:boolean;view:ServiceStopView|null;retained:ServiceStopRetained[]}
const labels:Record<string,string>={none:'Buddy stop not reviewed',ready:'Review complete — confirm stop','request-accepted':'Stop requested — shutdown and native recovery unverified',unknown:'Buddy stop not confirmed — no automatic retry',busy:'Another task is running',capacity:'The stop history or check limit is full',invalidated:'Review cancelled — start again',expired:'Review expired — start again',unsupported:'Buddy stop is not qualified for this installation',unavailable:'Buddy stop unavailable — read tablet state again'};
export class ServiceStopController{
 state:ServiceStopUiState={status:labels['none'],busy:false,view:null,retained:[]};
 private generation=0;private timer:ReturnType<typeof setTimeout>|undefined;private context:{reference:string;invocation:string|null}|null=null;private adapter:ServiceStopAdapter|null=null;private original:ServiceStopRetained|null=null;private possible=false;
 private readonly changed:(s:ServiceStopUiState)=>void;
 constructor(changed:(s:ServiceStopUiState)=>void){this.changed=changed;}
 private publish(p:Partial<ServiceStopUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private keepUnknown(){if(!this.original)return;const r={...this.original,outcome:'unknown' as const,reason:'cancelled' as const},rows=this.state.retained.filter(x=>x.reference!==r.reference);this.publish({retained:[...rows,r].slice(0,8)});}
 private cancelCaptured(){const q=this.context,a=this.adapter;this.context=null;if(q&&a)void a.serviceStop({action:'cancel',...q}).catch(()=>{});}
 clear(){clearTimeout(this.timer);this.generation++;if(this.possible)this.keepUnknown();this.possible=false;this.cancelCaptured();this.publish({busy:false,view:null,status:'Stop view cleared — earlier results unchanged'});}
 stop(){this.clear();this.publish({status:'Stop wait stopped — the service job may continue'});}
 private async bounded<T>(p:Promise<T>,deadline:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Buddy stop wait expired')),Math.max(1,deadline-performance.now()));})]);}finally{clearTimeout(timer);}}
 private merge(rows:ServiceStopRetained[]){const next=[...rows];for(const r of this.state.retained)if(!next.some(x=>x.reference===r.reference))next.push(r);return next.slice(0,8);}
 private async perform(adapter:ServiceStopAdapter,q:ServiceStopRequest,pause:()=>Promise<boolean>,status:string,until?:number){
  if(this.state.busy)return;clearTimeout(this.timer);this.adapter=adapter;const g=++this.generation,deadline=Math.min(until===undefined?Infinity:Number.isFinite(until)?until:0,performance.now()+14000);this.publish({busy:true,view:null,status});
  try{
   if(!await this.bounded(pause(),deadline)||g!==this.generation)return;
   if(performance.now()>=deadline)throw Error('Buddy stop wait expired');
   if(q.action==='confirm'){this.possible=true;this.original={reference:q.reference,connection_id:q.connection_id,boot_id:q.boot_id,outcome:'unknown',reason:'unavailable'};}
   const v=await this.bounded(adapter.serviceStop(q),deadline);parseServiceStopResult(v,q,validateResult);
   const s=v.service_stop;
   if(g!==this.generation){if(s.state==='ready'&&s.reference)void adapter.serviceStop({action:'cancel',reference:s.reference,invocation:null}).catch(()=>{});return;}
   this.possible=false;this.context=s.state==='ready'&&s.reference?{reference:s.reference,invocation:null}:null;
   if(s.state==='ready'){this.timer=setTimeout(()=>this.clear(),120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
   const rows=this.merge(s.retained);let text=labels[s.state];
   if(q.action==='refresh')text=s.current?'Current service checked — the earlier stop result has not changed':'Current service unavailable — the earlier stop result has not changed';
   if(q.action==='retained')text='Earlier stop attempts loaded';
   this.publish({busy:false,view:s,retained:rows,status:text});
  }catch{
   if(g===this.generation){this.generation++;if(this.possible)this.keepUnknown();this.possible=false;this.cancelCaptured();this.publish({busy:false,view:null,status:q.action==='confirm'?labels['unknown']:'Buddy stop unavailable'});}
  }finally{if(g===this.generation&&this.state.busy)this.publish({busy:false,status:'Stop wait cancelled'});}
 }
 async retained(adapter:ServiceStopAdapter){await this.perform(adapter,{action:'retained'},async()=>true,'Reading earlier stop attempts…');}
 async begin(adapter:ServiceStopAdapter,t:TabletObservation,pause:()=>Promise<boolean>,until?:number){
  if(this.state.busy||this.state.retained.some(r=>r.connection_id===t.connection_id&&r.outcome==='unknown'))return;this.cancelCaptured();this.original=null;this.possible=false;await this.perform(adapter,{action:'begin',connection_id:t.connection_id,boot_id:t.boot_id},pause,'Preparing the Buddy stop review…',until);
 }
 async confirm(adapter:ServiceStopAdapter,t:TabletObservation,pause:()=>Promise<boolean>,until?:number){
  const ref=this.state.view?.reference;if(this.state.busy||this.state.view?.state!=='ready'||!ref)return;const invocation=crypto.randomUUID();this.context={reference:ref,invocation};await this.perform(adapter,{action:'confirm',connection_id:t.connection_id,boot_id:t.boot_id,reference:ref,invocation},pause,'Requesting Buddy stop…',until);
 }
 async refresh(adapter:ServiceStopAdapter,t:TabletObservation,r:ServiceStopRetained,pause:()=>Promise<boolean>,until?:number){
  if(this.state.busy||r.connection_id!==t.connection_id||r.boot_id!==t.boot_id)return;const invocation=crypto.randomUUID();this.context={reference:r.reference,invocation};this.original=r;this.possible=false;await this.perform(adapter,{action:'refresh',connection_id:t.connection_id,boot_id:t.boot_id,reference:r.reference,invocation},pause,'Checking current service…',until);
 }
}
