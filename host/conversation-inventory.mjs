import {randomBytes} from 'node:crypto';
import {MaintenanceIO} from './maintenance-io.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseConversationRequest,parseConversationResult} from './conversation-inventory-protocol.mjs';
import {parseConversationRaw,ConversationUnsupported} from './conversation-inventory-private.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class ConversationInventoryHost {
 #epoch=0;#active=null;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Inventory budget refused');Object.assign(this,{observer,io,beforeIO,now,reference,budgetMs});}
 invalidate(){this.#epoch++;const a=this.#active;if(a){this.io.release(a.token);for(const b of a.buffers)b.fill(0);a.buffers.length=0;}this.#active=null;}
 #value(status='unavailable',view=null,sample=null){const v={contract_version:1,status:status==='reported'?'observed':'unconfigured',observation:status==='reported'?structuredClone(sample):null,conversation_inventory:{status,view}};this.#issued.set(v,this.#epoch);return v;}
 assertCurrent(v){if(v.status==='observed'&&this.#issued.get(v)!==this.#epoch)throw Error('Inventory invalidated');return v;}
 async request(value){
  const q=parseConversationRequest(value),sample=this.observer.lastObservation;if(!same(q,sample))return this.#value();
  const token=this.io.acquire('conversation-inventory',this.reference(),'inspect');if(!token)return this.#value('busy');
  const deadline=this.now()+this.budgetMs;let timer,active;try{
   this.invalidate();this.beforeIO();const epoch=this.#epoch;active={token,buffers:[]};this.#active=active;
   const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1)throw Error('Inventory expired');
   const privateRequest={...q,budget_ms};let raw;
   try{raw=await Promise.race([this.observer.run('conversation-inventory',privateRequest),new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.io.owns(token)&&epoch===this.#epoch){this.invalidate();this.observer.cancel();}reject(Error('Inventory expired'));},Math.max(1,deadline-this.now()));})]);}finally{clearTimeout(timer);}
   const current=()=>this.#epoch===epoch&&this.io.owns(token)&&this.now()<deadline&&same(q,this.observer.lastObservation);
   if(!current())return this.#value();
   if(!raw||Object.keys(raw).sort().join()!=='contract_version,conversation_inventory_raw,observation,status'||Buffer.byteLength(JSON.stringify(raw))>16384)throw Error('Inventory transport refused');validateResult({contract_version:raw.contract_version,status:raw.status,observation:raw.observation});const r=raw.conversation_inventory_raw;
   if(!r||Object.keys(r).sort().join()!=='status,stdout_base64'||!['reported','unsupported','unavailable'].includes(r.status)||(r.status==='reported'?typeof r.stdout_base64!=='string':r.stdout_base64!==null))throw Error('Inventory transport refused');
   if(raw.status!=='observed'||!same(raw.observation,q))return this.#value();if(r.status!=='reported')return this.#value(r.status);
   const buffer=Buffer.from(r.stdout_base64,'base64');active.buffers.push(buffer);if(buffer.length>8192||buffer.toString('base64')!==r.stdout_base64)throw Error('Inventory report refused');
   // Raw envelope is decoded only inside the host; no owner/generation leaves it.
   const view=parseConversationRaw(buffer);if(!current())return this.#value();
   const result=this.#value('reported',view,raw.observation);parseConversationResult(result,q,validateResult);return this.assertCurrent(result);
  }catch(error){return this.#value(error instanceof ConversationUnsupported?'unsupported':'unavailable');}
  finally{clearTimeout(timer);if(active){for(const b of active.buffers)b.fill(0);active.buffers.length=0;}this.io.release(token);if(this.#active===active)this.#active=null;}
 }
}
