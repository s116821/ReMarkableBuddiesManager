import {randomBytes} from 'node:crypto';
import {MaintenanceIO} from './maintenance-io.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseStorageInitializationRequest,parseStorageInitializationResult} from './storage-initialization-protocol.mjs';
import {parseStorageInitializationRaw} from './storage-initialization-private.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
export class StorageInitializationHost{
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Storage preparation budget refused');Object.assign(this,{observer,io,beforeIO,now,reference,budgetMs});}
 #expire(){if(this.#editor&&this.now()>=this.#editor.deadline){this.#editor=null;this.#epoch++;}}
 invalidate(reason='session-changed'){
  this.#epoch++;this.#editor=null;const a=this.#active;
  if(a){if(a.operation==='confirm'&&a.s.possible&&a.s.outcome!=='prepared'){a.s.outcome='unknown';a.s.reason=reason;}a.s.ledger.set(a.invocation,'completed');for(const b of a.buffers)b.fill(0);a.buffers.length=0;this.io.release(a.token);}this.#active=null;
 }
 #rows(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,outcome:s.outcome,reason:s.reason}));}
 #lookup(ref){return this.#editor?.reference===ref?this.#editor:this.#records.get(ref);}
 #value(state,q={},s=null,current=null,reason=null){const observed=state==='ready'||current!==null;const v={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,storage_initialization:{state,reference:q.reference??s?.reference??null,invocation:q.invocation??null,current:current?{...current}:null,reason,retained:this.#rows()}};this.#issued.set(v,{epoch:this.#epoch,s,deadline:current?this.#active?.deadline:null});return v;}
 assertCurrent(v){this.#expire();const w=this.#issued.get(v),s=v.storage_initialization;if(!w||w.epoch!==this.#epoch||w.deadline!=null&&this.now()>=w.deadline)throw Error('Storage preparation invalidated');if(s.state==='ready'&&(this.#editor!==w.s||this.now()>=w.s.deadline)||v.status==='observed'&&!same(w.s.sample,this.observer.lastObservation))throw Error('Storage preparation invalidated');return v;}
 #original(q,s,reason=s.reason){return this.#value(s.outcome,q,s,null,reason);}
 async request(value){const q=parseStorageInitializationRequest(value);this.#expire();let v;
  if(q.action==='retained')v=this.#value('none');
  else if(q.action==='begin')v=this.#begin(q);
  else if(q.action==='cancel')v=this.#cancel(q);
  else v=await this.#use(q);
  parseStorageInitializationResult(v,q,validateResult);return this.assertCurrent(v);
 }
 #begin(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable',q,null,null,'session-changed');
  // Deliberately connection-only: a reboot must not erase unresolved initialization.
  const unknown=[...this.#records.values()].find(s=>s.outcome==='unknown'&&s.sample.connection_id===q.connection_id);if(unknown)return this.#original(q,unknown);
  if(this.#records.size>=8)return this.#value('capacity',q,null,null,'capacity');
  const token=this.io.acquire('storage-initialization','review','begin');if(!token)return this.#value('busy',q,null,null,'busy');
  try{const reference=this.reference();if(this.#lookup(reference))return this.#value('unavailable',q,null,null,'unavailable');this.invalidate();this.beforeIO();const s={reference,sample:structuredClone(sample),deadline:this.now()+120000,ledger:new Map(),possible:false,outcome:null,reason:null};this.#editor=s;return this.#value('ready',q,s);}finally{this.io.release(token);}
 }
 #cancel(q){
  const s=this.#lookup(q.reference);if(!s)return this.#value('unavailable',q,null,null,'unavailable');
  if(q.invocation===null){if(s===this.#editor){this.#editor=null;this.#epoch++;return this.#value('invalidated',q);}return this.#records.has(s.reference)?this.#original(q,s):this.#value('invalidated',q);}
  const entry=s.ledger.get(q.invocation),a=this.#active;
  if(entry==='active'&&a?.s===s&&a.invocation===q.invocation&&a.epoch===this.#epoch&&this.io.owns(a.token)){this.invalidate('cancelled');this.observer.cancel();return this.#records.has(s.reference)?this.#original(q,s):this.#value('invalidated',q);}
  if(entry===undefined){if(s.ledger.size>=32)return this.#value('capacity',q,s,null,'capacity');s.ledger.set(q.invocation,'fenced');}
  return this.#records.has(s.reference)?this.#original(q,s):this.#value('invalidated',q);
 }
 #current(a){return this.#active===a&&a.epoch===this.#epoch&&this.io.owns(a.token)&&this.now()<a.deadline&&same(a.s.sample,this.observer.lastObservation);}
 async #raw(a){
  const budget_ms=Math.min(12000,Math.floor(a.deadline-this.now()));if(budget_ms<1||!this.#current(a))throw Error('Storage preparation expired');
  const selector=a.operation==='confirm'?'initialize':'inspect';const q={connection_id:a.s.sample.connection_id,boot_id:a.s.sample.boot_id,selector,budget_ms};
  const v=await this.observer.run('storage-initialization',q);if(!this.#current(a))throw Error('Storage preparation invalidated');
  if(keys(v)!=='contract_version,observation,status,storage_initialization_raw'||Buffer.byteLength(JSON.stringify(v))>24576)throw Error('Storage preparation envelope refused');validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const r=v.storage_initialization_raw;
  if(keys(r)!=='status,stdout_base64'||!['reported','unsupported','unavailable'].includes(r.status)||(r.status==='reported'?typeof r.stdout_base64!=='string':r.stdout_base64!==null)||v.status!=='observed'||!same(v.observation,a.s.sample))throw Error('Storage preparation transport refused');
  if(r.status!=='reported'){const e=Error('Storage preparation unavailable');e.reason=r.status;throw e;}
  const raw=Buffer.from(r.stdout_base64,'base64');a.buffers.push(raw);if(raw.length>16384||raw.toString('base64')!==r.stdout_base64)throw Error('Storage preparation raw refused');return parseStorageInitializationRaw(raw,selector);
 }
 async #use(q){
  const s=this.#lookup(q.reference);if(!s||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',q,null,null,'session-changed');
  if(q.action==='confirm'&&this.#records.has(s.reference))return this.#original(q,s);
  if(q.action==='confirm'&&s!==this.#editor||q.action==='refresh'&&!this.#records.has(s.reference))return this.#value('unavailable',q,null,null,'unavailable');
  if(s.ledger.has(q.invocation))return this.#value('invalidated',q,s,null,'cancelled');if(s.ledger.size>=32)return this.#value('capacity',q,s,null,'capacity');
  if(q.action==='confirm'&&this.#records.size>=8)return this.#value('capacity',q,s,null,'capacity');
  const started=this.now(),token=this.io.acquire('storage-initialization',s.reference,q.action);if(!token)return this.#value('busy',q,s,null,'busy');let a,timer;
  try{
   this.#epoch++;if(q.action==='refresh')this.#editor=null;this.beforeIO();s.ledger.set(q.invocation,'active');a={s,token,epoch:this.#epoch,invocation:q.invocation,operation:q.action,deadline:started+this.budgetMs,buffers:[]};this.#active=a;
   if(q.action==='confirm'){if(this.now()>=s.deadline||this.now()>=a.deadline)return this.#value('expired',q,s,null,'expired');s.possible=true;s.outcome='unknown';s.reason='unavailable';this.#editor=null;this.#records.set(s.reference,s);}
   try{
    const parsed=await Promise.race([this.#raw(a),new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.#active===a&&a.epoch===this.#epoch&&this.io.owns(token)){this.invalidate('expired');this.observer.cancel();}reject(Error('Storage preparation expired'));},Math.max(1,a.deadline-this.now()));})]);
    if(!this.#current(a))return this.#records.has(s.reference)?this.#original(q,s):this.#value('invalidated',q);
    if(q.action==='confirm'&&parsed.current){s.outcome='prepared';s.reason=null;}
    else if(q.action==='confirm')s.reason=parsed.reason;
    return this.#value(s.outcome,q,s,parsed.current,parsed.reason);
   }catch(e){const reason=e.reason??(this.now()>=a.deadline?'expired':'invalid-response');if(q.action==='confirm'&&s.outcome==='unknown'&&this.#current(a))s.reason=reason;return this.#original(q,s,reason);}
  }finally{clearTimeout(timer);if(a){for(const b of a.buffers)b.fill(0);a.buffers.length=0;if(s.ledger.get(q.invocation)==='active')s.ledger.set(q.invocation,'completed');if(this.#active===a)this.#active=null;}this.io.release(token);}
 }
}
