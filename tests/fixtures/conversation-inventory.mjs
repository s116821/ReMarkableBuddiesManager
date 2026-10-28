import {ConversationInventoryHost} from '../../host/conversation-inventory.mjs';
import {sourceCacheFixture} from './source-cache-inventory.mjs';
import {addCleanupFixture} from './source-cache-cleanup.mjs';
export {tablet,identity,defer,secret} from './source-cache-inventory.mjs';
export const conversationId='22222222-2222-4222-8222-222222222222';
export const inventoryReport=(ids=[conversationId],status='complete')=>({report_version:1,status,scope:'ordinary-current-root-candidates',complete:status==='complete',candidates:status==='complete'?ids:null,candidate_count:status==='complete'?ids.length:null,eligibility_evaluated:false,mutation_authority:false,native_authority:false,runtime_unverified:true,physical_reclamation:false,local_only:true,service_observation:status==='complete'?'inactive':'unverified'});
export function addConversationFixture(f,options={}){
 const state={report:inventoryReport(),onInspect:null,hooks:0},previous=f.observer.run;
 f.observer.run=async function(action,q){if(action!=='conversation-inventory')return previous.call(this,action,q);f.calls.push({action,...q});let report=state.report;if(state.onInspect)report=await state.onInspect(report,q);return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),conversation_inventory_raw:{status:'reported',stdout_base64:Buffer.from(typeof report==='string'?report:JSON.stringify(report)+'\n').toString('base64')}};};
 const conversations=new ConversationInventoryHost({observer:f.observer,io:f.io,...options}),lanes={...f.lanes,conversations};
 for(const [name,h]of Object.entries(lanes))h.beforeIO=()=>{state.hooks++;for(const [other,peer]of Object.entries(lanes))if(other!==name)peer.invalidate();};
 return {...f,conversations,lanes,conversationState:state};
}
export const conversationFixture=(options={},fileOptions={})=>addConversationFixture(addCleanupFixture(sourceCacheFixture({},fileOptions)),options);
