import {parsePortableRequest,portableContext,parsePortableResult,portableBase64,PORTABLE_FILE,type PortableRequest,type PortableResult,type PortableView,type PortableRetained,type PortableFile} from '../host/portable-configuration-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface PortableAdapter {portableConfiguration(request:PortableRequest):Promise<PortableResult>}
export type PortableSafeView=Omit<PortableView,'export_file'>;
export interface PortableState {status:string;busy:boolean;view:PortableSafeView|null;retained:PortableRetained[];uncertain:boolean}
const labels:Record<PortableView['state'],string>={none:'Choose a preferences file to review',exported:'Preferences handed to the save flow — saved location and permissions are yours to check',ready:'Review the changes, then confirm the import','no-change':'Selected preferences make no saved changes',invalidated:'Preview invalidated — review the file again',verified:'Saved file verified — running settings remain unverified','not-dispatched':'Import did not start',unknown:'Import outcome unknown — do not repeat automatically','desired-file-observed':'The saved file matches this import. We cannot confirm whether Buddy is using it yet.',unresolved:'Original desired file not observed — import remains unconfirmed',unsupported:'Installed Buddy does not support this preferences operation',unavailable:'Preferences operation unavailable — check saved configuration and tablet state',busy:'Another maintenance operation is active',capacity:'Eight unconfirmed imports are retained — check an original file first'};
export function downloadPortableFile(file:PortableFile){
 const raw=portableBase64(file.bytes_base64);let url:string|null=null;
 try{url=URL.createObjectURL(new Blob([Uint8Array.from(raw).buffer],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=PORTABLE_FILE;anchor.click();anchor.remove();const owned=url;setTimeout(()=>URL.revokeObjectURL(owned),1000);url=null;}
 finally{raw.fill(0);if(url)URL.revokeObjectURL(url);}
}
function encoded(raw:Uint8Array){let s='';for(let i=0;i<raw.length;i+=4096)s+=String.fromCharCode(...raw.subarray(i,i+4096));return btoa(s);}
export class PortableController {
 state:PortableState={status:labels.none,busy:false,view:null,retained:[],uncertain:false};
 private generation=0;private possible=false;private original:PortableRetained|null=null;private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly changed:(s:PortableState)=>void;private readonly clearFile:()=>void;private readonly download:(f:PortableFile)=>void;
 constructor(changed:(s:PortableState)=>void,clearFile:()=>void=()=>{},download:(f:PortableFile)=>void=downloadPortableFile){this.changed=changed;this.clearFile=clearFile;this.download=download;}
 private publish(v:Partial<PortableState>){this.state={...this.state,...v};this.changed(this.state);}
 private keep(){if(this.original&&!this.state.retained.some(r=>r.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=null;this.clearFile();if(this.possible)this.keep();this.publish({status:this.possible?labels.unknown:labels.invalidated,busy:false,view:null,uncertain:this.possible});}
 private async call(adapter:PortableAdapter,q:PortableRequest|null,g:number){
  if(!q)throw Error('Preferences request refused');parsePortableRequest(q);const context=portableContext(q),pending=adapter.portableConfiguration(q);q=null;let value:PortableResult|null=await pending;
  parsePortableResult(value,context,validateResult);if(g!==this.generation){value=null;return;}
  const p=value.portable_configuration,file=p.export_file;const {export_file:discard,...safe}=p;void discard;
  // The deliberate exported file goes directly to the save flow, never state.
  if(file){try{this.download(file);}catch{value=null;this.publish({busy:false,view:null,status:'Preferences could not be handed to the save flow — no import was attempted'});return;}}
  const settled=['verified','not-dispatched','desired-file-observed'].includes(p.state);
  if(settled){this.possible=false;this.original=null;}
  const retained=[...p.retained];for(const old of this.state.retained)if((!settled||old.reference!==context.reference)&&!retained.some(r=>r.reference===old.reference))retained.push(old);
  const status=p.state==='not-dispatched'&&p.report?.status==='unsupported'?'Installed Buddy or saved store cannot apply these preferences':p.state==='not-dispatched'&&p.report?.status==='conflict'?'Saved settings changed — review the file again':p.state==='not-dispatched'&&p.report?.status==='busy'?'Buddy is busy — import was not applied':labels[p.state];
  this.publish({busy:false,view:safe,status,retained:retained.slice(0,8),uncertain:this.possible||['unknown','unresolved'].includes(p.state)});value=null;
  if(this.state.uncertain)this.keep();
  if(p.state==='ready'){this.possible=false;this.original=null;this.timer=setTimeout(()=>{if(g===this.generation)this.clear();},120000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 }
 async retained(adapter:PortableAdapter){if(this.state.busy)return;const g=++this.generation;this.publish({busy:true});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained import diagnostics unavailable'});}}
 async read(adapter:PortableAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>,file:File|null=null){
  if(this.state.busy)return;this.clear();this.possible=false;this.original=null;const g=this.generation;this.publish({busy:true,status:file?'Reading the selected preferences file…':'Exporting saved preferences…'});let raw:Uint8Array|null=null;let q:PortableRequest|null=null;
  try{if(file){if(file.size>131072)throw Error('File refused');raw=new Uint8Array(await file.arrayBuffer());if(g!==this.generation)return;q={action:'prepare',connection_id:tablet.connection_id,boot_id:tablet.boot_id,artifact_base64:encoded(raw)};raw.fill(0);raw=null;file=null;}else q={action:'export',connection_id:tablet.connection_id,boot_id:tablet.boot_id};
   parsePortableRequest(q);if(!await pause()||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:labels.invalidated});return;}const pending=this.call(adapter,q,g);q=null;await pending;
  }catch{if(g===this.generation)this.publish({busy:false,view:null,status:'Preferences file or operation refused — no import was dispatched'});}finally{raw?.fill(0);q=null;file=null;this.clearFile();}
 }
 async confirm(adapter:PortableAdapter,tablet:TabletObservation){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.view.reference)return;const reference=this.state.view.reference;if(this.timer)clearTimeout(this.timer);this.timer=null;const g=++this.generation;this.possible=true;this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.publish({busy:true,status:'Importing once from the original preview…'});
  try{await this.call(adapter,{action:'confirm',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference},g);}catch{if(g===this.generation){this.keep();this.publish({busy:false,view:null,status:labels.unknown,uncertain:true});}}
 }
 async status(adapter:PortableAdapter,tablet:TabletObservation,r:PortableRetained,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.clear();const g=this.generation;this.possible=true;this.original=r;this.publish({busy:true,status:'Checking only the original desired saved file…'});
  try{if(!await pause()||g!==this.generation){if(g===this.generation){this.keep();this.publish({busy:false,status:labels.unknown,uncertain:true});}return;}await this.call(adapter,{action:'status',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference:r.reference},g);}catch{if(g===this.generation){this.keep();this.publish({busy:false,status:labels.unknown,uncertain:true});}}
 }
 async stop(adapter:PortableAdapter){const reference=this.state.view?.reference??this.original?.reference;this.clear();const g=this.generation;if(!reference)return;try{const result=await adapter.portableConfiguration({action:'cancel',reference});parsePortableResult(result,{action:'cancel',reference},validateResult);if(g!==this.generation)return;if(result.portable_configuration.state==='not-dispatched'){this.possible=false;this.original=null;this.publish({busy:false,uncertain:false,retained:this.state.retained.filter(r=>r.reference!==reference),status:labels['not-dispatched']});}}catch{/* Keep original uncertainty. */}}
}
