import {SourceCacheInventoryHost} from '../../host/source-cache-inventory.mjs';
import {CACHE_BYTE_BASIS} from '../../host/source-cache-inventory-protocol.mjs';
import {tablet} from './model-settings.mjs';
export const document=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
export const inventoryReport=(entries=[],status='ok')=>({report_version:1,operation:'inspect-source-cache',status,runtime_unverified:true,cleanup_authority:false,entry_payloads_read:false,entry_payloads_validated:false,source_freshness_verified:false,byte_basis:CACHE_BYTE_BASIS,actor:status==='ok'?'11111111-1111-4111-8111-111111111111':null,generation:status==='ok'?'22222222-2222-4222-8222-222222222222':null,entries:status==='ok'?entries:null,total_apparent_bytes:status==='ok'?entries.reduce((a,e)=>a+e.apparent_bytes,0):null});
export const cacheRaw=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),source_cache_inventory_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}});
export function addSourceCacheFixture(f,options={}){
 const previous=f.observer.run,state={report:inventoryReport([{document:document(1),apparent_bytes:0},{document:document(2),apparent_bytes:33554432}]),onInspect:null,hooks:0};
 f.observer.run=async function(action,q){if(action!=='source-cache-inventory')return previous.call(this,action,q);this.cancel();f.calls.push({action,selector:'inspect',body:structuredClone(q),budget_ms:q.budget_ms});let r=structuredClone(state.report);if(state.onInspect)r=await state.onInspect(r,q);return cacheRaw(r);};
 const cacheInventory=new SourceCacheInventoryHost({observer:f.observer,io:f.io,...options}),lanes={...f.lanes,cacheInventory};
 for(const [name,h]of Object.entries(lanes))h.beforeIO=()=>{state.hooks++;f.modelCredentialState.hooks++;f.credentialState.hooks++;f.memoryState.hooks++;f.researchState.hooks++;for(const [other,peer]of Object.entries(lanes))if(other!==name)peer.invalidate();};
 return {...f,cacheInventory,cacheState:state,lanes};
}
