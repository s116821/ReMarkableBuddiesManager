import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ConversationManagementHost} from '../../host/conversation-management.mjs';
import {MaintenanceIO} from '../../host/maintenance-io.mjs';
import {managementHash,managementUuid} from '../../host/conversation-management-private.mjs';
import {tablet} from './model-settings.mjs';
export {tablet};
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const conversation='22222222-2222-4222-8222-222222222222';
export const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const vector=JSON.parse(readFileSync(new URL('./conversation-management-reference-vectors.json',import.meta.url),'utf8'));
export function makeIntent(operation,conversationId=conversation){const i=structuredClone(vector.intent_fixtures[0].intent);delete i.intent_sha256;i.operation=operation;i.conversation=conversationId;i.intent_sha256=managementHash('RMB-CONVERSATION-DELETE-V1\n'+JSON.stringify(i));return i;}
export function report(selector,status,intent){
 const r={report_version:1,operation:selector,status,runtime_unverified:true,local_only:true,physical_reclamation:false,service_observation:'inactive',possible_effect:['acknowledged','unknown'].includes(status),conversation:intent.conversation,intent:null,receipt:null,current_state:null,summary:null};
 if(['ready','prepared'].includes(status)){r.current_state='live-original';r.summary=intent.summary;if(status==='prepared')r.intent=intent;}
 if(status==='unknown'){r.service_observation='unverified';}
 if(status==='unchanged')r.current_state='live-original';
 if(status==='unresolved')r.current_state='changed';
 if(status==='acknowledged'){r.current_state='desired-tombstones';r.receipt={operation:intent.operation,transaction:managementUuid(intent.operation,'transaction'),root_revision:managementUuid(intent.operation,'root-revision'),binding_revision:intent.binding===null?null:managementUuid(intent.operation,'binding-revision')};}
 if(status==='invalid-input')r.conversation=null;return r;
}
export function managementFixture(options={}){
 const io=new MaintenanceIO(),calls=[],state={hooks:0,onRaw:null,apply:'unknown',status:'unchanged'};
 const observer={lastObservation:structuredClone(tablet),cancels:0,cancel(){this.cancels++;},async run(action,q){
  if(action!=='conversation-management')throw Error('Unexpected synthetic action');
  const body=JSON.parse(Buffer.from(q.input_base64,'base64'));calls.push({action,selector:q.selector,body:structuredClone(body),budget:q.budget_ms});
  const i=q.selector==='inspect'?makeIntent('11111111-1111-4111-8111-111111111111',body.conversation):q.selector==='prepare'?makeIntent(body.operation,body.conversation):body.intent;
  let r=report(q.selector,q.selector==='inspect'?'ready':q.selector==='prepare'?'prepared':q.selector==='apply'?state.apply:state.status,i);if(state.onRaw)r=await state.onRaw(r,q,body);
  return {contract_version:1,status:'observed',observation:structuredClone(tablet),conversation_management_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}};
 }};
 const host=new ConversationManagementHost({observer,io,beforeIO:()=>{state.hooks++;},...options});
 const inspect=(id=conversation,invocation=randomUUID())=>host.request({action:'inspect',...identity,conversation:id,invocation});
 const use=(action,reference,invocation=randomUUID())=>host.request({action,...identity,reference,invocation});
 const prepare=async(id=conversation)=>use('prepare',(await inspect(id)).conversation_management.reference);
 return {host,observer,io,calls,state,inspect,use,prepare};
}

export function addManagementFixture(f,options={}){
 const local=managementFixture(),previous=f.observer.run;
 f.observer.run=async function(action,q){if(action==='conversation-management'){const result=await local.observer.run(action,q);f.calls.push(...local.calls.splice(0));return result;}return previous.call(this,action,q);};
 const management=new ConversationManagementHost({observer:f.observer,io:f.io,...options}),lanes={...f.lanes,management};
 for(const [name,h]of Object.entries(lanes))h.beforeIO=()=>{local.state.hooks++;for(const [other,peer]of Object.entries(lanes))if(other!==name)peer.invalidate();};
 return {...f,management,managementState:local.state,lanes};
}
