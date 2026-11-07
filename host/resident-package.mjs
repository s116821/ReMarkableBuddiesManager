import {randomBytes} from 'node:crypto';
import {MaintenanceIO} from './maintenance-io.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseResidentPackageRequest,parseResidentPackageResult,packageCurrent,packageKeys} from './resident-package-protocol.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
// Only independently qualified source bindings may populate this registry.
const qualifiedPackages=Object.freeze([]);
export const admitResidentPackage=(sample,operation)=>(sample.firmware_conflict?null:qualifiedPackages.find(b=>b.operation===operation&&b.model===sample.model&&b.architecture===sample.architecture&&b.firmware===sample.firmware))??null;
export function parseResidentPackageRaw(v){
 if(Buffer.byteLength(JSON.stringify(v))>262144||packageKeys(v)!=='context,current,retained,state'||!['ready','unknown','continuable','completed'].includes(v.state)||!Array.isArray(v.retained)||v.retained.length>8)throw Error('Private package response refused');
 const context=c=>{if(packageKeys(c)!=='activation,operation_id,proof_sha256'||!basicUuid(c.activation)||!basicDigest(c.proof_sha256)||c.operation_id!==null&&!basicUuid(c.operation_id))throw Error('Private package context refused');};
 if(v.context!==null)context(v.context);
 for(const r of v.retained){if(packageKeys(r)!=='activation,boot_id,operation,operation_id,proof_sha256'||!['disable','remove','replace'].includes(r.operation)||!basicUuid(r.boot_id))throw Error('Retained package refused');if(!basicUuid(r.operation_id))throw Error('Retained operation identity refused');context({activation:r.activation,proof_sha256:r.proof_sha256,operation_id:r.operation_id});}
 if(v.state!=='unknown'&&(v.current===null||v.context===null))throw Error('Missing package proof');return v;
}
export class ResidentPackageHost{
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),reference=()=>randomBytes(32).toString('hex'),budgetMs=13000,admit=admitResidentPackage}={}){if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Package budget refused');Object.assign(this,{observer,io,beforeIO,now,reference,budgetMs,admit});}
 invalidate(reason='session-changed'){this.#epoch++;this.#editor=null;const a=this.#active;if(a){if(a.mutation){a.s.state='unknown';a.s.reason=reason;a.s.current=null;}this.io.release(a.token);}this.#active=null;}
 #rows(){return [...this.#records.values()].map(s=>({reference:s.reference,operation:s.operation,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,state:s.state,reason:s.reason}));}
 #value(state,q={},s=null,current=null,reason=null){const v={contract_version:1,status:current?'observed':'unconfigured',observation:current?structuredClone(s.sample):null,resident_package:{state,operation:s?.operation??q.operation??null,reference:q.reference??s?.reference??null,invocation:q.invocation??null,reason,current,retained:this.#rows()}};this.#issued.set(v,this.#epoch);return v;}
 assertCurrent(v){if(this.#issued.get(v)!==this.#epoch||v.status==='observed'&&!same(v.observation,this.observer.lastObservation))throw Error('Package response invalidated');return v;}
 #lookup(ref){return this.#editor?.reference===ref?this.#editor:this.#records.get(ref);}
 #original(q,s){return same(s.sample,this.observer.lastObservation)?this.#value(s.state,q,s,s.current,s.reason):this.#value('unavailable',q,s,null,'session-changed');}
 #unknown(s,reason='recovery-pending'){s.state='unknown';s.reason=reason;s.current=null;}
 #hold(s){if(!this.io.fence(s.sample.connection_id,'resident-package',s.reference)||!this.io.reserve('resident-package',s.reference))throw Error('Package reservation refused');}
 #terminal(s){if(s.state==='completed'){this.io.clearFence(s.sample.connection_id,'resident-package',s.reference);this.io.settle('resident-package',s.reference);}}
 #current(a){return this.#active===a&&a.epoch===this.#epoch&&this.io.owns(a.token)&&this.now()<a.deadline&&same(a.s.sample,this.observer.lastObservation);}
 async #call(a,selector,invocation){
  const q={selector,operation:a.s.operation,connection_id:a.s.sample.connection_id,boot_id:a.s.sample.boot_id,budget_ms:Math.min(12000,Math.floor(a.deadline-this.now())),policy_id:a.s.binding.id,expected:selector==='review'?null:a.s.context,invocation};
  if(q.budget_ms<1||!this.#current(a)||Buffer.byteLength(JSON.stringify(q))>4096)throw Error('Package call expired');
  const v=await this.observer.run('resident-package',q);if(!this.#current(a)||packageKeys(v)!=='contract_version,observation,resident_package_raw,status'||Buffer.byteLength(JSON.stringify(v))>262144)throw Error('Package call invalidated');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});
  if(v.status!=='observed'||!same(v.observation,a.s.sample))throw Error('Package observation refused');
  const raw=parseResidentPackageRaw(v.resident_package_raw);if(raw.current!==null){packageCurrent(raw.current,a.s.operation);if(raw.current.installed_version!==a.s.binding.installed_version||raw.current.candidate_version!==(a.s.operation==='replace'?a.s.binding.candidate_version:null))throw Error('Package display/policy drift');}
  if(selector!=='review'&&raw.context&&raw.context.operation_id!==a.s.context.operation_id)throw Error('Original operation drift');
  if(raw.state==='completed'&&raw.current.outcome!==({disable:'disabled',remove:'removed',replace:'replaced'})[a.s.operation]||raw.state==='continuable'&&!['prepared','disabled'].includes(raw.current.outcome)||raw.state==='ready'&&raw.current.outcome!=='ready')throw Error('Package terminal proof refused');return raw;
 }
 async request(input){const q=parseResidentPackageRequest(input);let v;
  if(q.action==='retained')v=this.#value('none');
  else if(q.action==='cancel'){
   const s=this.#lookup(q.reference),a=this.#active;
   if(a&&a.s===s&&a.invocation===q.invocation&&this.io.owns(a.token)){this.invalidate('cancelled');this.observer.cancel();}
   else if(s&&this.#editor===s&&(q.invocation===null||q.invocation===s.reviewInvocation)){this.#editor=null;this.#epoch++;}
   if(s&&q.invocation!==null){if(s.ledger.size>=32&&!s.ledger.has(q.invocation))throw Error('Package capacity refused');s.ledger.add(q.invocation);}
   v=s&&this.#records.has(s.reference)?this.#original(q,s):this.#value('invalidated',q,s);
  }else v=await this.#request(q);
  parseResidentPackageResult(v,q,validateResult);return this.assertCurrent(v);
 }
 async #request(q){
  let s=q.action==='begin'?null:this.#lookup(q.reference);
  const sample=this.observer.lastObservation;
  if(!same(sample,q)||s&&!same(s.sample,q))return this.#value('unavailable',q,s,null,'session-changed');
  if(q.action==='begin'){
   if(this.#records.size>=8)return this.#value('unavailable',q,null,null,'capacity');
   if(!this.io.maySubmit(q.connection_id,'resident-package',null))return this.#value('busy',q,null,null,'busy');
   const binding=this.admit(sample,q.operation);if(!binding||q.operation==='replace'&&!binding.candidate_version)return this.#value('unavailable',q,null,null,binding?'candidate-unavailable':'lifecycle-unqualified');
   if(!basicDigest(binding.id))throw Error('Invalid host qualification');
   const reference=this.reference();if(!basicDigest(reference)||this.#lookup(reference))throw Error('Package reference collision');
   s={reference,operation:q.operation,sample:structuredClone(sample),binding:structuredClone(binding),ledger:new Set(),state:'unknown',reason:'recovery-pending',current:null,context:null,reviewInvocation:null,continuation:false};
  }else if(!s)return this.#value('unavailable',q,null,null,'unavailable');
  if(['confirm','resume'].includes(q.action)&&[...this.#records.values()].some(r=>r.reference!==s.reference&&r.sample.connection_id===s.sample.connection_id&&r.state!=='completed'))return this.#value('unavailable',q,s,null,'recovery-pending');
  if(q.action==='confirm'&&(s!==this.#editor||this.now()>=s.deadline))return this.#value('expired',q,s,null,'expired');
  if(q.action==='resume'&&s.state!=='continuable'||q.action==='refresh'&&!this.#records.has(s.reference))return this.#value('unavailable',q,s,null,'unavailable');
  if(q.action==='confirm'&&s.reviewInvocation!==null&&s.reviewInvocation!==q.invocation)return this.#value('invalidated',q,s,null,'cancelled');
  if(q.invocation&&s.ledger.has(q.invocation))return this.#value('invalidated',q,s,null,'cancelled');
  if(s.ledger.size>=32)return this.#value('unavailable',q,s,null,'capacity');
  const token=this.io.acquire('resident-package',s.reference,q.action);if(!token)return this.#value('busy',q,s,null,'busy');
  let a,timer;try{
   this.#epoch++;this.#editor=null;this.beforeIO();if(q.invocation)s.ledger.add(q.invocation);
   a={s,token,epoch:this.#epoch,invocation:q.invocation??null,mutation:q.action==='confirm',deadline:this.now()+this.budgetMs};this.#active=a;
   if(a.mutation){if(!s.continuation)s.context={...s.context,operation_id:q.invocation};this.#hold(s);this.#unknown(s);this.#records.set(s.reference,s);}
   const selector=q.action==='begin'?'review':q.action==='refresh'?'observe':q.action==='resume'?'review-continuation':s.continuation?'continue':'execute';
   const raw=await Promise.race([this.#call(a,selector,q.invocation??crypto.randomUUID()),new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.#active===a&&a.epoch===this.#epoch&&this.io.owns(a.token)){this.invalidate('expired');this.observer.cancel();}reject(Error('Package deadline'));},Math.max(1,a.deadline-this.now()));})]);
   if(!this.#current(a))throw Error('Package invalidated');
   if(q.action==='begin'&&raw.retained.length){
    for(const r of raw.retained){const ref=this.reference();if(this.#records.size>=8||!basicDigest(ref)||this.#lookup(ref))throw Error('Retained capacity');const original={...s,reference:ref,operation:r.operation,sample:{...s.sample,boot_id:r.boot_id},context:{activation:r.activation,proof_sha256:r.proof_sha256,operation_id:r.operation_id},ledger:new Set(),state:'unknown',reason:'recovery-pending',current:null};this.#records.set(ref,original);this.#hold(original);}
    return this.#value('unavailable',q,s,null,'recovery-pending');
   }
   s.context=raw.context??s.context;
   if(q.action==='begin'||q.action==='resume'){
    if(raw.state!==(q.action==='begin'?'ready':'continuable'))throw Error('Package review not ready');
    s.deadline=this.now()+120000;s.reviewInvocation=q.action==='resume'?crypto.randomUUID():null;s.continuation=q.action==='resume';s.reviewCurrent=raw.current;this.#editor=s;
    return this.#value('ready',q.action==='resume'?{...q,invocation:s.reviewInvocation}:q,s,raw.current);
   }
   if(!['unknown','continuable','completed'].includes(raw.state))throw Error('Package proof state');
   s.state=raw.state;s.current=raw.current;s.reason=s.state==='completed'?null:s.state==='continuable'?'continuation-required':'recovery-pending';this.#terminal(s);
   return this.#original(q,s);
  }catch{
   if(a?.mutation)this.#unknown(s);
   return this.#records.has(s.reference)?this.#original(q,s):this.#value('unavailable',q,s,null,'invalid-response');
  }finally{clearTimeout(timer);if(this.#active===a)this.#active=null;this.io.release(token);}
 }
}
