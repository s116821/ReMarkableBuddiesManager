import { PRODUCT_KEYS,parseProductSettingsRequest,parseProductSettingsResult,parseProductChanges,type ProductSettingsRequest,type ProductSettingsResult,type ProductFields,type ProductKey,type ProductChanges,type ProductRetained,type ProductView } from '../host/product-settings-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { TabletObservation } from './observation';
export interface ProductSettingsAdapter {productSettings(request:ProductSettingsRequest):Promise<ProductSettingsResult>}
export interface ProductUiState {status:string;busy:boolean;view:ProductView|null;reference:string|null;draft:Record<ProductKey,string>;changes:ProductChanges;retained:ProductRetained[];uncertain:boolean}
const empty=():Record<ProductKey,string>=>({export_destination:'',reader_enabled:'',writer_enabled:''});
const labels:Record<string,string>={none:'Begin a fresh edit to read saved product settings',ready:'Saved settings ready to edit',invalidated:'Editor invalidated - begin a fresh edit',unsupported:'Installed product-settings editor is unsupported',unavailable:'Editor unavailable - read tablet state again',busy:'Another operation is active - this request did not replace it',capacity:'Eight unconfirmed saves are retained - check an original desired file before another save','not-dispatched':'This save was not dispatched','no-change':'No saved change was needed',verified:'Saved file verified - restart required for running behavior',unknown:'Save outcome unknown - no automatic retry',unresolved:'Desired file not observed - original outcome remains unconfirmed','desired-file-observed':'Desired saved file observed - historical publisher and runtime remain unverified'};
export class ProductSettingsController {
 state:ProductUiState={status:'Not inspected',busy:false,view:null,reference:null,draft:empty(),changes:{},retained:[],uncertain:false};
 private readyTimer:ReturnType<typeof setTimeout>|undefined;private waitDeadline=0;private generation=0;private pendingAction:ProductSettingsRequest['action']|null=null;private possible=false;private original:ProductRetained|null=null;
 private readonly changed:(v:ProductUiState)=>void;private readonly clearFields:()=>void;
 constructor(changed:(v:ProductUiState)=>void,clearFields:()=>void=()=>{}){this.changed=changed;this.clearFields=clearFields;}
 private wipe(){clearTimeout(this.readyTimer);this.clearFields();this.publish({draft:empty(),changes:{}});}
 private publish(p:Partial<ProductUiState>){this.state={...this.state,...p};this.changed(this.state);}
 private keepOriginal(){if(this.original&&!this.state.retained.some(x=>x.reference===this.original!.reference))this.publish({retained:[...this.state.retained,this.original].slice(0,8)});}
 clear(){this.wipe();this.generation++;this.pendingAction=null;if(this.possible)this.keepOriginal();this.publish({status:this.possible?'Save outcome unknown - check its original desired file':'Editor invalidated - begin a fresh edit',busy:false,view:null,changes:{},draft:empty(),reference:this.possible?this.original?.reference??null:null,uncertain:this.possible});}
 edit(key:ProductKey,value:string){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.view.current)return;if(key!=='export_destination'&&!['','true','false'].includes(value))throw Error('Product setting choice refused');
  const changes={...this.state.changes},original=this.state.view.current[key];
  const next=value===''?{action:'clear' as const}:{action:'set' as const,value:key==='export_destination'?value:value==='true'};
  parseProductChanges({[key]:next});const equivalent=next.action==='clear'?original.origin==='default':original.origin==='declared'&&original.value===next.value;
  if(equivalent)delete changes[key];else changes[key]=next;this.publish({changes,draft:{...this.state.draft,[key]:value}});
 }
 private async bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Product settings wait expired')),Math.max(1,this.waitDeadline-performance.now()));})]);}finally{clearTimeout(timer);}}
 private async call(adapter:ProductSettingsAdapter,request:ProductSettingsRequest,generation:number){
  parseProductSettingsRequest(request);if(performance.now()>=this.waitDeadline)throw Error('Product settings wait expired');const value=await this.bounded(adapter.productSettings(request));parseProductSettingsResult(value,request,validateResult);if(generation!==this.generation)return;this.pendingAction=null;
  const q=value.product_settings,settled=['verified','no-change','not-dispatched','desired-file-observed','capacity'].includes(q.state)||request.action==='save'&&['busy','unavailable'].includes(q.state);
  if(settled){this.possible=false;this.original=null;}
  const uncertain=this.possible||['unknown','unresolved'].includes(q.state),removed=settled&&'reference'in request?request.reference:null;
  const retained=[...q.retained];for(const old of this.state.retained)if(old.reference!==removed&&!retained.some(x=>x.reference===old.reference))retained.push(old);
  const draft=q.current?Object.fromEntries(PRODUCT_KEYS.map(k=>[k,q.current![k].origin==='default'?'':String(q.current![k].value)])) as Record<ProductKey,string>:empty();
  if(q.state==='ready'){clearTimeout(this.readyTimer);this.readyTimer=setTimeout(()=>this.clear(),120000);(this.readyTimer as unknown as {unref?:()=>void}).unref?.();}
  this.publish({status:labels[q.state],busy:false,view:q,reference:q.reference,draft,changes:{},retained:retained.slice(0,8),uncertain});if(uncertain)this.keepOriginal();
 }
 async retained(adapter:ProductSettingsAdapter){if(this.state.busy)return;this.waitDeadline=performance.now()+14000;const g=++this.generation;this.pendingAction='retained';this.publish({busy:true,status:'Reading retained host diagnostics...'});try{await this.call(adapter,{action:'retained'},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Retained host diagnostics unavailable'});}}
 async begin(adapter:ProductSettingsAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>){
  if(this.state.busy)return;this.waitDeadline=performance.now()+14000;const g=++this.generation;this.pendingAction='begin';this.wipe();this.publish({busy:true,view:null,changes:{},reference:null,status:'Pausing observation before a fresh editor read...'});
  try{if(!await this.bounded(pause())||g!==this.generation){if(g===this.generation)this.publish({busy:false,status:'Editor read invalidated'});return;}this.possible=false;this.original=null;await this.call(adapter,{action:'begin',connection_id:tablet.connection_id,boot_id:tablet.boot_id},g);}catch{if(g===this.generation)this.publish({busy:false,status:'Product settings unavailable or response refused',view:null});}
 }
 async save(adapter:ProductSettingsAdapter,tablet:TabletObservation){
  if(this.state.busy||this.state.view?.state!=='ready'||!this.state.reference||!Object.keys(this.state.changes).length||this.state.retained.length>=8)return;
  this.waitDeadline=performance.now()+14000;const reference=this.state.reference,changes=parseProductChanges(this.state.changes),g=++this.generation;this.original={reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'unknown'};this.possible=true;this.pendingAction='save';this.wipe();this.publish({busy:true,view:null,status:'Saving the original inspected revision...'});
  try{await this.call(adapter,{action:'save',connection_id:tablet.connection_id,boot_id:tablet.boot_id,reference,changes},g);}catch{if(g===this.generation){this.keepOriginal();this.publish({busy:false,view:null,status:'Save outcome unknown - response unavailable; do not retry automatically',uncertain:true});}}
 }
 async status(adapter:ProductSettingsAdapter,original:ProductRetained,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy||tablet.connection_id!==original.connection_id||tablet.boot_id!==original.boot_id)return;
  this.waitDeadline=performance.now()+14000;const g=++this.generation;this.original=original;this.possible=true;this.pendingAction='status';this.wipe();this.publish({busy:true,view:null,reference:original.reference,changes:{},status:'Checking the original desired file only...'});
  try{if(!await this.bounded(pause())||g!==this.generation){if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check invalidated - original outcome remains unknown'});return;}await this.call(adapter,{action:'status',connection_id:original.connection_id,boot_id:original.boot_id,reference:original.reference},g);}catch{if(g===this.generation)this.publish({busy:false,view:null,uncertain:true,status:'Desired-file check unavailable - original outcome remains unknown'});}
 }
 async stop(adapter:ProductSettingsAdapter,cancel:()=>Promise<unknown>){
  this.waitDeadline=performance.now()+14000;const g=++this.generation,reference=this.state.reference,original=this.original,pending=this.pendingAction;this.pendingAction=null;this.wipe();
  if(this.possible)this.keepOriginal();this.publish({busy:true,view:null,status:'Stopping local wait...'});
  const owns=()=>g===this.generation&&this.state.reference===reference&&this.original===original;
  try{
   if(reference&&pending!=='retained'){
    const request={action:'cancel' as const,reference},value=await this.bounded(adapter.productSettings(request));
    if(!owns())return;parseProductSettingsResult(value,request,validateResult);
    if(!owns())return;
    if(['not-dispatched','invalidated'].includes(value.product_settings.state)){
     this.possible=false;this.original=null;this.publish({retained:this.state.retained.filter(x=>x.reference!==reference)});
    }
   }else if(pending==='begin'){await this.bounded(cancel());if(!owns())return;}
   // Retained diagnostics are host-local: stopping that read never cancels I/O.
  }catch{if(!owns())return;/* A failed stop never proves rollback. */}
  if(g===this.generation&&this.state.reference===reference)this.publish({busy:false,view:null,changes:{},status:this.possible?'Save outcome unknown - stopping is not rollback':pending==='retained'?'Retained host read stopped':'This invocation was not dispatched - editor invalidated',uncertain:this.possible});
 }
}
export function productRows(fields:ProductFields|null,draft:Record<ProductKey,string>){
 if(!fields)return [];
 return [
  {key:'reader_enabled' as const,label:'Reader enabled',options:[['','Default (enabled)'],['false','Disabled'],['true','Enabled']]},
  {key:'writer_enabled' as const,label:'Writer enabled',options:[['','Default (enabled)'],['false','Disabled'],['true','Enabled']]},
  {key:'export_destination' as const,label:'Export backend',options:[['','Default (Mem)'],['mem','Mem'],['disabled','Disabled']]},
 ].map(row=>({...row,origin:fields[row.key].origin,originLabel:fields[row.key].origin==='default'?'Default':'Saved value',value:draft[row.key]}));
}
