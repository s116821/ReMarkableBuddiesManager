import {parseSourceCacheRequest,parseSourceCacheResult,type SourceCacheRequest,type SourceCacheResult,type SourceCacheView} from '../host/source-cache-inventory-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import type {TabletObservation} from './observation';
export interface SourceCacheAdapter {inspectSourceCache(request:SourceCacheRequest):Promise<SourceCacheResult>}
export interface SourceCacheUiState {status:string;busy:boolean;view:SourceCacheView|null;checkedAt:string|null}
const label=(view:SourceCacheView)=>view.status==='ok'?(view.entries!.length?'Source-cache metadata snapshot inspected':'Source-cache metadata inspected - no slots observed'):`Source-cache inventory ${view.status} - no candidate list admitted`;
export class SourceCacheInventoryController {
 state:SourceCacheUiState={status:'Source-cache slots not inspected',busy:false,view:null,checkedAt:null};
 private generation=0;private readonly changed:(v:SourceCacheUiState)=>void;
 constructor(changed:(v:SourceCacheUiState)=>void){this.changed=changed;}
 private publish(v:SourceCacheUiState){this.state=v;this.changed(v);}
 clear(){this.generation++;this.publish({status:'Source-cache slots not inspected',busy:false,view:null,checkedAt:null});}
 stop(){this.generation++;this.publish({status:'Inspection wait stopped - the bounded host read may still finish',busy:false,view:null,checkedAt:null});}
 async inspect(adapter:SourceCacheAdapter,tablet:TabletObservation,pause:()=>Promise<boolean>=async()=>true){
  if(this.state.busy)return;const g=++this.generation;let timer:ReturnType<typeof setTimeout>|undefined;this.publish({status:'Inspecting source-cache metadata...',busy:true,view:null,checkedAt:null});
  try{
   const value=await Promise.race([(async()=>{if(!await pause()||g!==this.generation)return null;const q=parseSourceCacheRequest({connection_id:tablet.connection_id,boot_id:tablet.boot_id}),v=await adapter.inspectSourceCache(q);if(g!==this.generation)return null;parseSourceCacheResult(v,q,validateResult);return v;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Inventory wait expired')),14000);})]);
   if(g!==this.generation)return;if(!value){this.clear();return;}const result=value.source_cache_inventory;this.publish({busy:false,view:result.view,checkedAt:result.status==='reported'?new Date().toISOString():null,status:result.status==='reported'?label(result.view!):`Source-cache inventory ${result.status}`});
  }catch{if(g===this.generation){this.generation++;this.publish({status:'Source-cache inventory unavailable - no candidate list admitted',busy:false,view:null,checkedAt:null});}}
  finally{clearTimeout(timer);}
 }
}
