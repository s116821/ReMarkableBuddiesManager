import {parseCleanupRequest,parseCleanupResult,type CleanupRequest,type CleanupResult,type CleanupView,type CleanupRetained} from '../host/source-cache-cleanup-protocol.mjs';
import {basicUuid} from '../host/basic-settings-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface CleanupAdapter {sourceCacheCleanup(request:CleanupRequest):Promise<CleanupResult>}
export interface CleanupUiState {selection:string;busy:boolean;status:string;view:CleanupView|null;retained:CleanupRetained[]}
const labels:Record<string,string>={ready:'Cleanup preview ready — confirmation required',applied:'Derived cache slot removed — runtime and source freshness remain unverified',absent:'Derived cache slot already absent — no deletion acknowledgment', 'absent-observed':'Original slot currently absent — historical deletion outcome unproven',unknown:'Cleanup outcome unknown — do not retry; check only this original operation',unchanged:'Original derived slot unchanged — no permission to retry',conflict:'Original derived slot changed — no permission to retry','not-dispatched':'This cleanup invocation did not dispatch a deletion',unsupported:'Cache cleanup unsupported',unavailable:'Cache cleanup unavailable — no new authority',busy:'Another bounded operation is busy',capacity:'Cleanup capacity reached — retained originals were preserved',invalidated:'Cleanup preview invalidated'};
export class SourceCacheCleanupController {
 state:CleanupUiState={selection:'',busy:false,status:'No derived cache slot selected',view:null,retained:[]};
 private generation=0;private active:{reference:string|null;invocation:string}|null=null;private readyInvocation:string|null=null;
 private timer:ReturnType<typeof setTimeout>|undefined;private readonly expiries=new Map<string,number>();private readonly expiryTimers=new Map<string,ReturnType<typeof setTimeout>>();
 private readonly changed:(s:CleanupUiState)=>void;private readonly erase:()=>void;private readonly now:()=>number;private readonly uuid:()=>string;
 constructor(changed:(s:CleanupUiState)=>void,erase:()=>void=()=>{},now:()=>number=()=>performance.now(),uuid:()=>string=()=>crypto.randomUUID()){this.changed=changed;this.erase=erase;this.now=now;this.uuid=uuid;}
 canCheck(row:CleanupRetained){return row.status_available&&(this.expiries.get(row.reference)??Infinity)>this.now();}
 private expireAt(reference:string,deadline:number){this.expiries.set(reference,deadline);if(this.expiryTimers.has(reference))return;const timer=setTimeout(()=>{this.expiryTimers.delete(reference);this.publish({retained:this.state.retained.map(r=>r.reference===reference?{...r,status_available:false}:r)});},Math.max(1,deadline-this.now()));this.expiryTimers.set(reference,timer);(timer as unknown as {unref?:()=>void}).unref?.();}
 dispose(){this.clear();for(const timer of this.expiryTimers.values())clearTimeout(timer);this.expiryTimers.clear();}
 private publish(p:Partial<CleanupUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private rows(rows:CleanupRetained[]){const merged=new Map(this.state.retained.map(r=>[r.reference,r]));for(const r of rows)merged.set(r.reference,{...r,status_available:r.status_available&&(this.expiries.get(r.reference)??Infinity)>this.now()});return [...merged.values()];}
 valid(){return basicUuid(this.state.selection);}
 select(value:string){if(this.state.busy)return;this.generation++;clearTimeout(this.timer);this.readyInvocation=null;this.active=null;this.publish({selection:value,view:null,status:'Select a derived cache slot and prepare a fresh preview'});}
 clear(){this.generation++;clearTimeout(this.timer);this.active=null;this.readyInvocation=null;this.erase();this.publish({selection:'',view:null,busy:false,status:'Cleanup preview cleared'});}
 private accept(view:CleanupView){let retained=this.rows(view.retained);if(view.reference&&['unavailable','unsupported'].includes(view.state)&&!view.retained.some(r=>r.reference===view.reference))retained=retained.map(r=>r.reference===view.reference?{...r,status_available:false}:r);if((['applied','absent','absent-observed'].includes(view.state)||view.state==='not-dispatched'&&!view.retained.some(r=>r.reference===view.reference)))retained=retained.filter(r=>r.reference!==view.reference);this.publish({busy:false,view,retained,status:labels[view.state]??'Cache cleanup unavailable'});}
 private localUnknown(reference:string,tablet:TabletObservation,document:string){this.readyInvocation=null;const row:CleanupRetained={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,document,state:'unknown',status_available:(this.expiries.get(reference)??0)>this.now()};this.publish({busy:false,view:{state:'unknown',reference,preview:null,report:null,retained:[row]},retained:this.rows([row]),status:'Cleanup outcome unknown — original check may be unavailable; never retry confirmation'});}
 async prepare(adapter:CleanupAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){if(this.state.busy||!this.valid()||this.state.retained.length>=8)return;await this.run(adapter,tablet,'prepare',null,this.state.selection,pause);}
 async confirm(adapter:CleanupAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){const v=this.state.view;if(this.state.busy||v?.state!=='ready'||!v.reference||!v.preview)return;await this.run(adapter,tablet,'confirm',v.reference,v.preview.document,pause);}
 async status(adapter:CleanupAdapter,tablet:TabletObservation,row:CleanupRetained,pause:()=>Promise<boolean>){if(this.state.busy||!this.canCheck(row)||tablet.connection_id!==row.connection_id||tablet.boot_id!==row.boot_id)return;await this.run(adapter,tablet,'status',row.reference,row.document,pause);}
 private async run(adapter:CleanupAdapter,tablet:TabletObservation,action:'prepare'|'confirm'|'status',reference:string|null,document:string,pause:()=>Promise<boolean>){
  const invocation=this.uuid(),g=++this.generation,started=this.now();let timer:ReturnType<typeof setTimeout>|undefined,possible=false;
  clearTimeout(this.timer);this.readyInvocation=null;this.active={reference,invocation};this.erase();this.publish({selection:'',view:null,busy:true,status:action==='prepare'?'Preparing cleanup preview...':action==='confirm'?'Confirming cache cleanup...':'Checking original cache cleanup...'});
  const q=parseCleanupRequest(action==='prepare'?{action,...{connection_id:tablet.connection_id,boot_id:tablet.boot_id},document,invocation}:{action,connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,invocation});
  try{
   const result=await Promise.race([(async()=>{if(!await pause()||g!==this.generation)return null;if(action==='confirm'&&reference){possible=true;this.expireAt(reference,started+1800000);this.publish({retained:this.rows([{reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,document,state:'unknown',status_available:true}])});}const v=await adapter.sourceCacheCleanup(q);if(g!==this.generation)return null;return parseCleanupResult(v,q,validateResult);})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Cleanup wait expired')),14000);})]);
   if(g!==this.generation)return;this.active=null;
   if(!result){this.clear();return;}const v=result.source_cache_cleanup;this.accept(v);
   if(action==='prepare'&&v.state==='ready'){
    this.readyInvocation=invocation;const ref=v.reference;this.timer=setTimeout(()=>{if(g===this.generation&&this.state.view?.reference===ref){this.clear();this.publish({status:'Cleanup preview expired — prepare a new preview'});}},Math.max(1,120000-(this.now()-started)));
   }
  }catch{if(g===this.generation){this.generation++;this.active=null;if(action==='confirm'&&possible&&reference)this.localUnknown(reference,tablet,document);else this.publish({busy:false,view:null,status:'Cache cleanup unavailable — no new authority'});}}
  finally{clearTimeout(timer);}
 }
 async stop(adapter:CleanupAdapter){
  const target=this.active?.reference?{...this.active,reference:this.active.reference}:this.state.view?.state==='ready'&&this.state.view.reference&&this.readyInvocation?{reference:this.state.view.reference,invocation:this.readyInvocation}:null;
  const active=this.active,view=this.state.view,rows=this.state.retained;this.clear();const g=this.generation;
  // Without an already captured tuple Stop is entirely local.
  if(!target){this.publish({status:'Cleanup wait stopped locally — bounded preparation may still finish'});return;}
  if(active&&view===null&&rows.some(r=>r.reference===target.reference))this.publish({retained:rows});
  this.publish({busy:true,status:'Stopping the captured cleanup invocation...'});let timer:ReturnType<typeof setTimeout>|undefined;
  const q=parseCleanupRequest({action:'cancel',...target});
  try{const result=await Promise.race([adapter.sourceCacheCleanup(q),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Stop wait expired')),14000);})]);if(g!==this.generation)return;this.accept(parseCleanupResult(result,q,validateResult).source_cache_cleanup);}
  catch{if(g===this.generation){this.generation++;this.publish({busy:false,view:null,status:'Cleanup Stop wait ended — historical outcome remains unverified'});}}
  finally{clearTimeout(timer);}
 }
}
