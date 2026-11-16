import {parseResidentPackageResult,type ResidentPackageRequest,type ResidentPackageResult,type ResidentPackageView,type PackageRetained,type PackageOperation} from '../host/resident-package-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface ResidentPackageAdapter{residentPackage(request:ResidentPackageRequest):Promise<ResidentPackageResult>}
export interface PackageUiState{busy:boolean;status:string;view:ResidentPackageView|null;retained:PackageRetained[]}
const labels:Record<string,string>={none:'Package controls not reviewed',ready:'Review complete — confirm the remaining change',busy:'Another task is running',unavailable:'Package controls unavailable for this installation',unsupported:'Package controls are not qualified for this installation',expired:'Review expired — review again',invalidated:'Review cancelled',unknown:'Outcome unconfirmed — check the original operation',continuable:'Step verified — review the remaining change',completed:'Requested package change verified'};
export class ResidentPackageController{
 state:PackageUiState={busy:false,status:labels['none'],view:null,retained:[]};
 private generation=0;private timer:ReturnType<typeof setTimeout>|undefined;private adapter:ResidentPackageAdapter|null=null;private captured:{reference:string;invocation:string|null}|null=null;
 private readonly changed:(s:PackageUiState)=>void;
 constructor(changed:(s:PackageUiState)=>void){this.changed=changed;}
 private publish(p:Partial<PackageUiState>){this.state={...this.state,...p};this.changed(this.state);}
 clear(){clearTimeout(this.timer);this.generation++;const c=this.captured,a=this.adapter;this.captured=null;if(c&&a)void a.residentPackage({action:'cancel',...c}).catch(()=>{});this.publish({busy:false,view:null,status:'Package wait stopped — check earlier operations before continuing'});}
 private async perform(a:ResidentPackageAdapter,q:ResidentPackageRequest,pause:()=>Promise<boolean>,until=Infinity){
  if(this.state.busy)return;clearTimeout(this.timer);this.adapter=a;const g=++this.generation,deadline=Math.min(until,performance.now()+14000);this.publish({busy:true,status:'Checking the reviewed package operation…'});let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const v=await Promise.race([(async()=>{if(!await pause()||g!==this.generation||performance.now()>=deadline)throw Error('Package context changed');return a.residentPackage(q);})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Package wait expired')),Math.max(1,deadline-performance.now()));})]);
   parseResidentPackageResult(v,q,validateResult);const s=v.resident_package;
   if(g!==this.generation){if(s.state==='ready'&&s.reference)void a.residentPackage({action:'cancel',reference:s.reference,invocation:s.invocation}).catch(()=>{});return;}
   this.captured=s.state==='ready'&&s.reference?{reference:s.reference,invocation:s.invocation}:null;
   if(s.state==='ready'){this.timer=setTimeout(()=>this.clear(),120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
   this.publish({busy:false,view:s,retained:s.retained,status:labels[s.state]});
  }catch{if(g===this.generation){this.clear();this.publish({status:q.action==='confirm'?labels['unknown']:labels['unavailable']});}}
  finally{clearTimeout(timer);if(g===this.generation)this.publish({busy:false});}
 }
 async retained(a:ResidentPackageAdapter,until?:number){await this.perform(a,{action:'retained'},async()=>true,until);}
 async begin(a:ResidentPackageAdapter,t:TabletObservation,operation:PackageOperation,pause:()=>Promise<boolean>,until?:number){this.captured=null;await this.perform(a,{action:'begin',operation,connection_id:t.connection_id,boot_id:t.boot_id},pause,until);}
 async confirm(a:ResidentPackageAdapter,t:TabletObservation,pause:()=>Promise<boolean>,until?:number){const s=this.state.view;if(s?.state!=='ready'||!s.reference||this.state.busy)return;const invocation=s.invocation??crypto.randomUUID();
  const row:PackageRetained={reference:s.reference,operation:s.operation!,connection_id:t.connection_id,boot_id:t.boot_id,state:'unknown',reason:'recovery-pending'};
  this.publish({retained:[...this.state.retained.filter(r=>r.reference!==s.reference),row]});this.captured={reference:s.reference,invocation};await this.perform(a,{action:'confirm',reference:s.reference,invocation,connection_id:t.connection_id,boot_id:t.boot_id},pause,until);}
 async check(a:ResidentPackageAdapter,t:TabletObservation,r:PackageRetained,pause:()=>Promise<boolean>,resume=false,until?:number){if(r.connection_id!==t.connection_id||r.boot_id!==t.boot_id||resume&&r.state!=='continuable')return;const invocation=crypto.randomUUID();this.captured={reference:r.reference,invocation};await this.perform(a,{action:resume?'resume':'refresh',reference:r.reference,invocation,connection_id:t.connection_id,boot_id:t.boot_id},pause,until);}
}
