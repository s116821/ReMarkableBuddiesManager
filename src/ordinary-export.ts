import {exportPath,parseExportRequest,exportResponseContext,parseExportResult,type ExportRequest,type ExportResult,type ExportRetained,type ExportView} from '../host/ordinary-export-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {displayModelText,spliceModelText,reconcileModelText} from '../host/opaque-text.mjs';
import type {TabletObservation} from './observation';
export interface OrdinaryExportAdapter {ordinaryExport(request:ExportRequest):Promise<ExportResult>}
export interface OrdinaryExportState {status:string;busy:boolean;view:ExportView|null;reference:string|null;retained:ExportRetained[];valid:boolean;uncertain:boolean}
const labels:Record<string,string>={none:'Enter a new absolute tablet destination',ready:'Archive preview ready - confirm deliberately',invalidated:'Preview invalidated - prepare again',unsupported:'Installed archive export is unsupported',unavailable:'Archive export unavailable - read tablet state again',busy:'Another operation is active',capacity:'Eight unconfirmed exports are retained - check an original archive first','not-dispatched':'Export was not dispatched','not-published':'Archive marker was not published - a partial directory may remain',verified:'Archive verified on this tablet - copy it off-device separately',unknown:'Export outcome unknown - no automatic retry',unresolved:'Original complete archive not observed - outcome remains unconfirmed','desired-archive-observed':'Original complete archive currently observed - historical publication unverified'};
export class OrdinaryExportController {
 state:OrdinaryExportState={status:'Not prepared',busy:false,view:null,reference:null,retained:[],valid:false,uncertain:false};
 private raw='';private invalid=false;private version=0;private before:{version:number;start:number;end:number;type:string;data:string|null}|null=null;
 private generation=0;private possible=false;private original:ExportRetained|null=null;private timer:ReturnType<typeof setTimeout>|null=null;private pending:ExportRequest['action']|null=null;
 private readonly changed:(state:OrdinaryExportState)=>void;private readonly clearInput:()=>void;
 constructor(changed:(state:OrdinaryExportState)=>void,clearInput:()=>void=()=>{}){this.changed=changed;this.clearInput=clearInput;}
 private publish(p:Partial<OrdinaryExportState>){this.state={...this.state,...p};this.changed(this.state);}
 private clearDraft(){this.raw='';this.invalid=false;this.version++;this.before=null;this.clearInput();}
 private clearTimer(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){const hadPreview=this.state.reference!==null||this.state.busy;this.generation++;this.pending=null;this.clearTimer();this.clearDraft();if(this.possible)this.keepOriginal();this.publish({status:this.possible?labels.unknown:hadPreview?labels.invalidated:labels.none,busy:false,view:null,reference:this.possible?this.original?.reference??null:null,valid:false,uncertain:this.possible});}
 text(){return displayModelText(this.raw);}
 private editable(){return !this.state.busy&&this.state.view?.state!=='ready';}
 private store(raw:string){if([...raw].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;})||new TextEncoder().encode(raw).length>4096){this.invalid=true;this.publish({valid:false});return false;}this.raw=raw;this.invalid=false;this.version++;this.before=null;this.publish({valid:exportPath(raw)});return true;}
 beforeInput(start:number,end:number,type:string,data:string|null){if(this.editable())this.before={version:this.version,start,end,type,data};}
 paste(start:number,end:number,text:string){if(!this.editable())return false;try{return this.store(spliceModelText(this.raw,start,end,text));}catch{this.invalid=true;this.publish({valid:false});return false;}}
 input(next:string){if(!this.editable())return;const b=this.before;try{let candidate:string|null=null;
  if(b?.version===this.version){if(b.type==='insertText'&&b.data!==null)candidate=spliceModelText(this.raw,b.start,b.end,b.data);else if(['insertLineBreak','insertParagraph'].includes(b.type))candidate=spliceModelText(this.raw,b.start,b.end,'\n');else if(b.type.startsWith('delete')){if(b.start!==b.end)candidate=spliceModelText(this.raw,b.start,b.end,'');else{const n=this.text().length-next.length;if(n<0)throw Error('Input refused');if(b.type.endsWith('Backward'))candidate=spliceModelText(this.raw,b.start-n,b.end,'');else if(b.type.endsWith('Forward'))candidate=spliceModelText(this.raw,b.start,b.end+n,'');else if(n===0)candidate=this.raw;else throw Error('Input refused');}}}
  if(candidate===null){if(next===this.text()&&b&&(b.start!==b.end||b.type!=='insertCompositionText'))throw Error('Input refused');candidate=reconcileModelText(this.raw,next);}if(displayModelText(candidate)!==next)throw Error('Input refused');this.store(candidate);
 }catch{this.invalid=true;this.version++;this.before=null;this.publish({valid:false,status:'Destination edit refused - enter a fresh valid path'});}}
 private async call(adapter:OrdinaryExportAdapter,request:ExportRequest|null,g:number){
  if(!request)throw Error('Export request refused');parseExportRequest(request);const context=exportResponseContext(request),pending=adapter.ordinaryExport(request);request=null;const value=await pending;parseExportResult(value,context,validateResult);if(g!==this.generation)return;this.pending=null;this.clearDraft();this.clearTimer();const q=value.ordinary_export;
  const settled=['verified','not-published','not-dispatched','desired-archive-observed'].includes(q.state)||(context.action==='confirm'&&['busy','unavailable'].includes(q.state));if(settled){this.possible=false;this.original=null;}
  const retained=[...q.retained];for(const old of this.state.retained)if((!settled||old.reference!==context.reference)&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state);this.publish({status:labels[q.state],busy:false,view:q,reference:q.reference,retained:retained.slice(0,8),valid:false,uncertain});if(uncertain)this.keepOriginal();
  if(q.state==='ready'){this.possible=false;this.original=null;this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:OrdinaryExportAdapter){if(this.state.busy)return;this.clearDraft();this.clearTimer();const g=++this.generation;this.pending='retained';this.publish({busy:true,valid:false,status:'Reading retained export diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained export diagnostics unavailable'});}}
 async prepare(adapter:OrdinaryExportAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(!this.editable()||!this.state.valid||this.invalid)return;let destination:string|null=this.raw;this.clearDraft();this.clearTimer();const g=++this.generation;this.pending='prepare';this.possible=false;this.original=null;this.publish({busy:true,view:null,reference:null,valid:false,uncertain:false,status:'Pausing observation before preparing an archive preview...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:labels.invalidated});return;}const pending=this.call(adapter,{action:'prepare',destination,...{connection_id:tablet.connection_id,boot_id:tablet.boot_id}},g);destination=null;await pending;}catch{if(g===this.generation)this.publish({busy:false,status:labels.unavailable,view:null});}finally{destination=null;}
 }
 async confirm(adapter:OrdinaryExportAdapter,tablet:TabletObservation){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.reference)return;this.clearDraft();this.clearTimer();const g=++this.generation,reference=this.state.reference;this.pending='confirm';this.possible=true;this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.publish({busy:true,valid:false,status:'Exporting once to the original tablet destination...'});
  try{await this.call(adapter,{action:'confirm',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference},g);}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:labels.unknown,uncertain:true});}}
 }
 async status(adapter:OrdinaryExportAdapter,tablet:TabletObservation,reference:string,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy)return;this.clearDraft();this.clearTimer();const g=++this.generation;this.pending='status';this.possible=true;this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.publish({busy:true,view:null,reference,valid:false,status:'Checking only the original complete archive...'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation){this.keepOriginal();this.publish({busy:false,status:labels.unknown,uncertain:true});}return;}await this.call(adapter,{action:'status',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference},g);}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,status:labels.unknown,uncertain:true});}}
 }
 async stop(adapter:OrdinaryExportAdapter){
  if(!this.state.busy&&this.state.view?.state!=='ready')return;const reference=this.state.reference,pending=this.pending;this.clear();const g=this.generation,original=this.original;
  // A prepare has no public original handle yet; stopping its local wait never sends a global cancel.
  if(!reference||pending==='retained')return;
  try{const request:ExportRequest={action:'cancel',reference},result=await adapter.ordinaryExport(request);parseExportResult(result,exportResponseContext(request),validateResult);if(g!==this.generation||this.state.reference!==(this.possible?reference:null)||this.original!==original)return;
   if(!this.possible){this.publish({status:labels.invalidated});return;}const q=result.ordinary_export;if(q.state==='not-dispatched'){this.possible=false;this.original=null;this.publish({reference:null,uncertain:false,retained:this.state.retained.filter(x=>x.reference!==reference),status:labels['not-dispatched']});}else this.keepOriginal();
  }catch{/* Original uncertainty is preserved. */}
 }
}
