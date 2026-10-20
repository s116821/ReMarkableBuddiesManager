import { parseForgetRequest,parseForgetResult,type ForgetRequest,type ForgetView } from '../host/memory-forget-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { ObservationResult } from './observation';
export interface ForgetResult extends ObservationResult {forget:ForgetView}
export interface ForgetAdapter {memoryForget(request:ForgetRequest):Promise<ForgetResult>}
export interface ForgetUiState {status:string;busy:boolean;uncertain:boolean;reference:string|null;view:ForgetView|null}
export class MemoryForgetController {
  state:ForgetUiState={status:'No retained request checked',busy:false,uncertain:false,reference:null,view:null};
  private generation=0;
  private possible=false;
  private readonly changed:(v:ForgetUiState)=>void;
  constructor(changed:(v:ForgetUiState)=>void){this.changed=changed;}
  private publish(status:string,busy=false,uncertain=this.state.uncertain,reference=this.state.reference,view:ForgetView|null=null){this.state={status,busy,uncertain,reference,view};this.changed(this.state);}
  clear(){this.generation++;const uncertain=this.possible||this.state.uncertain;this.publish(uncertain?'Original request outcome unknown — check its historical receipt or deliberately inspect current data':'Prepared confirmation invalidated',false,uncertain,uncertain?this.state.reference:null);}
  async stop(adapter:ForgetAdapter|null,cancelHost:()=>Promise<unknown>){
    const generation=++this.generation, reference=this.state.reference;
    const uncertain=this.possible||this.state.uncertain;
    this.publish('Stopping local wait…',true,uncertain,uncertain?reference:null);
    try { if(reference&&adapter) await adapter.memoryForget({action:'cancel',reference}); else await cancelHost(); }
    catch { /* Cancellation never establishes rollback. */ }
    if(generation===this.generation)this.publish(uncertain?'Original request outcome unknown — stopping a wait is not rollback':'Prepared confirmation invalidated',false,uncertain,uncertain?reference:null);
  }
  async run(adapter:ForgetAdapter,request:ForgetRequest){
    if(this.state.busy)return;
    parseForgetRequest(request);
    if(request.action==='confirm'&&(this.state.view?.state!=='prepared'||request.reference!==this.state.reference))return;
    const generation=++this.generation,previousUncertain=this.state.uncertain,original=this.state.reference;
    if(request.action==='confirm')this.possible=true;
    const pendingReference=request.action==='prepare'&&!previousUncertain?null:original;
    this.publish(request.action==='prepare'?'Preparing a fresh conditional preview…':request.action==='confirm'?'Confirming the original request…':request.action==='receipt'?'Checking historical acknowledgement only…':request.action==='cancel'?'Stopping local wait…':'Checking retained host request…',true,this.possible||previousUncertain,pendingReference);
    try{
      const value=await adapter.memoryForget(request);await parseForgetResult(value,validateResult);
      if(generation!==this.generation)return;
      const q=value.forget;
      if(previousUncertain && (q.reference!==original || q.state==='not-dispatched')){this.publish('Original intent is unavailable or unresolved — a later refusal does not prove no earlier commit',false,true,original);return;}
      if(request.action==='prepare'&&q.state==='prepared'&&(q.preview?.key.profile!==request.key.profile||q.preview?.key.fact!==request.key.fact||value.observation?.connection_id!==request.connection_id||value.observation?.boot_id!==request.boot_id))throw Error('Preview identity refused');
      if('reference' in request&&q.reference!==null&&q.reference!==request.reference)throw Error('Reference refused');
      const uncertain=['unknown','unresolved','confirming','checking-receipt'].includes(q.state) || this.possible&&!['acknowledged','not-dispatched'].includes(q.state);
      if(q.state==='acknowledged'||q.state==='not-dispatched')this.possible=false;
      const labels:Record<string,string>={none:'No request retained by this host — no prior outcome is established',prepared:'Fresh preview ready — explicit confirmation required',invalidated:'Prepared confirmation invalidated',busy:'Another request occupies this host — no target was replaced',unsupported:'Installed preparation protocol unsupported',unavailable:'Request unavailable', 'not-dispatched':'This confirmation invocation was refused before mutation attempt',unknown:'Original request outcome unknown — no automatic retry',unresolved:'Historical receipt unresolved — original outcome remains unknown',acknowledged:'Original transaction acknowledged historically — current data is unverified',preparing:'Another client is preparing a request',confirming:'Confirmation may be in progress — outcome not yet known','checking-receipt':'Read-only receipt check in progress'};
      this.publish(uncertain&&q.state==='none'?'Original intent no longer retained — recovery unavailable; inspect current data deliberately':labels[q.state]??'Request unavailable',false,uncertain,q.reference??(uncertain?original:null),q);
    }catch{if(generation===this.generation)this.publish(this.possible||previousUncertain?'Original request outcome unknown — response refused; do not retry automatically':'Preparation unavailable or response refused',false,this.possible||previousUncertain,original);}
  }
}
