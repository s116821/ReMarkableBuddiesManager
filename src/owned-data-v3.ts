import {STORAGE,DOMAINS,NOTEBOOKS,parseOwnedV3Request,parseOwnedV3Result,type OwnedV3Request,type OwnedV3Result,type OwnedV3View} from '../host/owned-data-v3-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface OwnedV3Adapter {inspectOwnedV3(request:OwnedV3Request):Promise<OwnedV3Result>}
export interface OwnedV3UiState {status:string;busy:boolean;view:OwnedV3View|null;checkedAt:string|null}
const label=(view:OwnedV3View)=>({complete:'Complete',partial:'Some data could not be checked',busy:'Busy',unsupported:'Unsupported',unavailable:'Unavailable'})[view.status];
export class OwnedV3Controller {
 state:OwnedV3UiState={status:'Stored data not inspected',busy:false,view:null,checkedAt:null};
 private generation=0;private readonly changed:(v:OwnedV3UiState)=>void;
 constructor(changed:(v:OwnedV3UiState)=>void){this.changed=changed;}
 private publish(v:OwnedV3UiState){this.state=v;this.changed(v);}
 clear(){this.generation++;this.publish({status:'Stored data not inspected',busy:false,view:null,checkedAt:null});}
 stop(){this.generation++;this.publish({status:'Inspection wait stopped - the bounded host read may still finish',busy:false,view:null,checkedAt:null});}
 async inspect(adapter:OwnedV3Adapter,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy)return;const g=++this.generation;let timer:ReturnType<typeof setTimeout>|undefined;this.publish({status:'Inspecting stored data...',busy:true,view:null,checkedAt:null});
  try{
   const value=await Promise.race([(async()=>{if(!await pause()||g!==this.generation)return null;const q=parseOwnedV3Request({connection_id:tablet.connection_id,boot_id:tablet.boot_id}),v=await adapter.inspectOwnedV3(q);if(g!==this.generation)return null;parseOwnedV3Result(v,q,validateResult);return v;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Inventory wait expired')),14000);})]);
   if(g!==this.generation)return;if(!value){this.clear();return;}const result=value.owned_data_v3;this.publish({busy:false,view:result.view,checkedAt:result.status==='reported'?new Date().toISOString():null,status:result.status==='reported'?label(result.view!):`Stored data inspection ${result.status}`});
  }catch{if(g===this.generation){this.generation++;this.publish({status:'Stored data inspection unavailable - no snapshot admitted',busy:false,view:null,checkedAt:null});}}
  finally{clearTimeout(timer);}
 }
}

export function exactCount(value:string|null|undefined):string {return value===undefined?'Not checked':value===null?'Unknown':BigInt(value).toLocaleString('en-US');}
const categoryLabels:Record<string,string>={structural:'Storage structure','record-metadata':'Record metadata','media-object':'Media objects','unclassified-object':'Unclassified objects','retained-generation':'Retained history',cache:'Caches and indexes',diagnostics:'Owned diagnostics',staging:'Staging',conversation:'Conversations',source:'Source evidence','export-association':'Export associations','subject-memory':'Subject memory',handwriting:'Handwriting learning','unassociated-feedback':'Unassociated feedback','archived-normalized-source':'Archived source metadata','notebook-plan':'Notebook plans','notebook-stage':'Notebook stages'};
export function ownedV3Rows(view:OwnedV3View|null){if(!view)return [];return [
 ...STORAGE.map(key=>({kind:'Physical files',key,label:categoryLabels[key],files:exactCount(view.storage[key]?.files),bytes:exactCount(view.storage[key]?.apparent_bytes)})),
 ...DOMAINS.map(key=>({kind:'References (not additive)',key,label:categoryLabels[key],files:exactCount(view.observed_domains[key]?.observed_record_files),bytes:exactCount(view.observed_domains[key]?.observed_record_bytes)})),
 ...NOTEBOOKS.map(key=>({kind:'Notebook metadata (included above)',key,label:categoryLabels[key],files:exactCount(view.observed_notebook_records[key]?.files),bytes:exactCount(view.observed_notebook_records[key]?.apparent_bytes)}))];}
