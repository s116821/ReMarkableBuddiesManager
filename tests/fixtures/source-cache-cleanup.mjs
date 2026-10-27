import {randomUUID,randomBytes} from 'node:crypto';
import {SourceCacheCleanupHost} from '../../host/source-cache-cleanup.mjs';
import {MaintenanceIO} from '../../host/maintenance-io.mjs';
import {cleanupFrame} from '../../host/source-cache-cleanup-private.mjs';
import {tablet} from './model-settings.mjs';
import {readFileSync} from 'node:fs';
export {tablet};
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export const document='22222222-2222-4222-8222-222222222222';
export const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const vector=JSON.parse(readFileSync(new URL('./source-cache-cleanup-reference-vectors.json',import.meta.url),'utf8'));
export const makeIntent=(operation,doc=document)=>{const i={...vector.private_intent,operation,document:doc};i.intent_sha256=cleanupFrame('buddy-source-cache-cleanup-intent-v1',Object.entries(i).filter(([k])=>k!=='intent_sha256').map(([,v])=>v));return i;};
export const report=(selector,status,intent)=>({report_version:1,operation:selector,status,runtime_unverified:true,possible_effect:selector==='apply'&&['unknown','applied'].includes(status),document:intent.document,intent:selector==='prepare'&&status==='prepared'?intent:null,entry_bytes:['prepared','applied','unknown','unchanged'].includes(status)?intent.entry_bytes:null,entry_sha256:['prepared','applied','unknown','unchanged'].includes(status)?intent.entry_sha256:null});
export function cleanupFixture(options={}){
 const io=new MaintenanceIO(),calls=[],state={hooks:0,onRaw:null,apply:'unknown',status:'unchanged'};
 const observer={lastObservation:structuredClone(tablet),cancels:0,cancel(){this.cancels++;},async run(action,q){assertAction(action);const body=JSON.parse(Buffer.from(q.input_base64,'base64'));calls.push({action,selector:q.selector,body:structuredClone(body),budget:q.budget_ms});let i=q.selector==='prepare'?makeIntent(body.operation,body.document):body.intent;let r=report(q.selector,q.selector==='prepare'?'prepared':q.selector==='apply'?state.apply:state.status,i);if(state.onRaw)r=await state.onRaw(r,q,body);return {contract_version:1,status:'observed',observation:structuredClone(tablet),source_cache_cleanup_raw:{status:'reported',stdout_base64:Buffer.from(typeof r==='string'?r:JSON.stringify(r)+'\n').toString('base64')}};}};
 const host=new SourceCacheCleanupHost({observer,io,beforeIO:()=>{state.hooks++;},...options});
 const prepare=()=>host.request({action:'prepare',...identity,document,invocation:randomUUID()});
 const use=(action,reference,invocation=randomUUID())=>host.request({action,...identity,reference,invocation});
 return {host,observer,io,calls,state,prepare,use};
}
function assertAction(action){if(action!=='source-cache-cleanup')throw Error('Unexpected synthetic action');}
export function addCleanupFixture(f,options={}){
 const local=cleanupFixture(options),previous=f.observer.run;
 f.observer.run=async function(action,q){if(action==='source-cache-cleanup'){const result=await local.observer.run(action,q);f.calls.push(...local.calls.splice(0));return result;}return previous.call(this,action,q);};
 const cacheCleanup=new SourceCacheCleanupHost({observer:f.observer,io:f.io,...options}),lanes={...f.lanes,cacheCleanup};
 for(const [name,h]of Object.entries(lanes))h.beforeIO=()=>{local.state.hooks++;for(const [other,peer]of Object.entries(lanes))if(other!==name)peer.invalidate();};
 return {...f,cacheCleanup,cleanupState:local.state,lanes};
}
export const freshReference=()=>randomBytes(32).toString('hex');
