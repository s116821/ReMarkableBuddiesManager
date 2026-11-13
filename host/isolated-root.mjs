import {randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {DriveStore} from './drive-store.mjs';
import {MaintenanceIO} from './maintenance-io.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseIsolatedRootRequest,parseIsolatedRootResult} from './isolated-root-protocol.mjs';
import {prepareIsolatedRoot,parseIsolatedRootRaw,IsolatedRootUnsupported} from './isolated-root-private.mjs';
import {createIsolatedRootRecord,readIsolatedRootRecords,isolatedRootHash,isolatedRootIdentity} from './isolated-root-records.mjs';

const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class IsolatedRootHost {
 #editor=null;#records=new Map();#digest=null;#epoch=0;#active=null;#issued=new WeakMap();
 constructor({observer,store=new DriveStore(),io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),
  uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=45000}={}){
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>45000)throw Error('Operation budget refused');
  Object.assign(this,{observer,store,io,beforeIO,now,uuid,reference,budgetMs});
 }
 invalidate(){
  this.#epoch++;
  if(this.#active){this.io.release(this.#active.token);this.#active=null;}
  this.#editor?.entry?.input.fill(0);this.#editor=null;
 }
 #expire(){if(this.#editor&&this.now()>=this.#editor.deadline)this.invalidate();}
 #load(){
  const loaded=readIsolatedRootRecords(this.store.isolatedRootOperations()),next=new Map();
  for(const entry of loaded.entries){
   const prior=this.#records.get(entry.record.reference);
   if(prior&&!isDeepStrictEqual(prior.entry.record,entry.record))throw Error('Original custody changed');
   next.set(entry.record.reference,prior??{entry,state:'unknown'});
   if(prior)entry.input.fill(0);
  }
  for(const ref of this.#records.keys())if(!next.has(ref))throw Error('Original custody lost');
  this.#records=next;this.#digest=loaded.digest;
 }
 #retained(){return [...this.#records.values()].map(({entry,state})=>({reference:entry.record.reference,
  connection_id:entry.record.connection_id,boot_id:entry.record.boot_id,state,
  device:entry.view.device,backup:entry.view.backup,epoch:entry.view.epoch}));}
 #value(state,reference=null,{sample=null,preview=null,report=null}={}){
  const value={contract_version:1,status:sample?'observed':'unconfigured',observation:sample?structuredClone(sample):null,
   isolated_root_preparation:{state,reference,preview:structuredClone(preview),report:structuredClone(report),retained:this.#retained()}};
  this.#issued.set(value,this.#epoch);return value;
 }
 assertCurrent(value){
  this.#expire();const v=value.isolated_root_preparation;
  if(value.status==='observed'&&this.#issued.get(value)!==this.#epoch)throw Error('Isolated backup preparation invalidated');
  if(v.state==='ready'&&(!this.#editor||this.#editor.entry.record.reference!==v.reference||
   JSON.stringify(this.#editor.entry.view)!==JSON.stringify(v.preview)))throw Error('Isolated backup preview invalidated');
  return value;
 }
 #lost(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 #stale(token,epoch,deadline){return this.#lost(token,epoch)||this.now()>=deadline;}
 async #owned(reference,operation,wait_id,deadline,handler){
  const token=this.io.acquire('isolated-root-preparation',reference,operation);
  if(!token)return this.#value('busy',reference);
  let timer;
  try{
   if(operation==='begin'||operation==='retry')this.invalidate();
   this.beforeIO();const epoch=this.#epoch;
   this.#active={token,reference,wait_id};
   return await Promise.race([handler(token,epoch,deadline),new Promise(resolve=>{
    timer=setTimeout(()=>{
     if(this.#lost(token,epoch)){resolve(this.#value('invalidated'));return;}
     this.invalidate();this.observer.cancel();
     const retained=this.#records.get(reference);
     resolve(retained?this.#value(retained.state,reference):this.#value('invalidated'));
    },Math.max(1,deadline-this.now()));
   })]);
  }finally{
   clearTimeout(timer);this.io.release(token);if(this.#active?.token===token)this.#active=null;
  }
 }
 async #raw(selector,input,sample,deadline){
  const budget_ms=Math.min(selector==='inspect'?12000:45000,Math.floor(deadline-this.now()));
  if(budget_ms<1)throw Error('Isolated backup preparation expired');
  const request={selector,input_base64:input===null?null:input.toString('base64'),budget_ms,
   connection_id:sample.connection_id,boot_id:sample.boot_id};
  let value;
  try{value=await this.observer.run('local-mode-choice',request);}finally{request.input_base64=null;}
  if(this.now()>=deadline||keys(value)!=='contract_version,local_mode_raw,observation,status'||Buffer.byteLength(JSON.stringify(value))>24576)throw Error('Private transport refused');
  validateResult({contract_version:value.contract_version,status:value.status,observation:value.observation});
  const result=value.local_mode_raw;
  if(keys(result)!=='status,stdout_base64'||result.status!=='reported'||value.status!=='observed'||
   !same(value.observation,sample)||!same(this.observer.lastObservation,sample)||typeof result.stdout_base64!=='string')throw Error('Private transport refused');
  const raw=Buffer.from(result.stdout_base64,'base64');
  if(raw.length<1||raw.length>16384||raw.toString('base64')!==result.stdout_base64)throw Error('Private transport refused');
  return raw;
 }
 async request(value){
  const q=parseIsolatedRootRequest(value),deadline=this.now()+this.budgetMs;this.#expire();let result;
  if(q.action==='cancel')result=this.#cancel(q);
  else{
   try{this.#load();}catch{
    const active=this.#active&&this.io.owns(this.#active.token);
    this.invalidate();if(active)this.observer.cancel();result=this.#value('storage-unavailable');
   }
   if(!result){
    if(q.action==='retained')result=this.#value('none');
    else if(q.action==='begin')result=await this.#begin(q,deadline);
    else result=await this.#dispatch(q,deadline);
   }
  }
  parseIsolatedRootResult(result,q,validateResult);return this.assertCurrent(result);
 }
 #cancel(q){
  if(this.#active?.reference===q.reference&&this.#active.wait_id===q.wait_id&&this.io.owns(this.#active.token)){
   this.invalidate();this.observer.cancel();
  }else if(this.#editor?.entry.record.reference===q.reference&&this.#editor.wait_id===q.wait_id)this.invalidate();
  const retained=this.#records.get(q.reference);
  return retained?this.#value(retained.state,q.reference):this.#value('invalidated');
 }
 async #begin(q,deadline){
  const sample=structuredClone(this.observer.lastObservation);
  if(!same(sample,q))return this.#value('unavailable');
  const reference=this.reference();
  return this.#owned(reference,'begin',q.wait_id,deadline,async(token,epoch,deadline)=>{
   let raw;
   try{
    raw=await this.#raw('inspect',null,sample,deadline);
    if(this.#stale(token,epoch,deadline))return this.#value('invalidated');
    const original=prepareIsolatedRoot(raw,this.uuid()),entry=createIsolatedRootRecord(reference,sample,original);
    const retained=[...this.#records.values()].find(s=>isolatedRootIdentity(s.entry.record)===isolatedRootIdentity(entry.record));
    if(retained){entry.input.fill(0);return this.#value(retained.state,retained.entry.record.reference);}
    if(this.#records.size>=8){entry.input.fill(0);return this.#value('capacity');}
    if(this.#records.has(reference)){entry.input.fill(0);return this.#value('unavailable');}
    this.#editor={entry,sample,wait_id:q.wait_id,deadline:this.now()+120000};
    return this.#value('ready',reference,{sample,preview:entry.view});
   }catch{return this.#value(this.#lost(token,epoch)?'invalidated':'unavailable');}finally{raw?.fill(0);}
  });
 }
 async #dispatch(q,deadline){
  let retained=this.#records.get(q.reference);
  if(q.action==='prepare'&&retained)return this.#value(retained.state,q.reference);
  const editor=this.#editor,entry=q.action==='retry'?retained?.entry:editor?.entry;
  if(!entry||entry.record.reference!==q.reference||!same(entry.record,q)||!same(entry.record,this.observer.lastObservation)||
   q.action==='prepare'&&this.now()>=editor.deadline)return this.#value('unavailable',q.reference);
  const sample=structuredClone(this.observer.lastObservation);
  return this.#owned(q.reference,q.action,q.wait_id,deadline,async(token,epoch,deadline)=>{
   let input,raw;
   try{
    if(this.#stale(token,epoch,deadline))return this.#value('invalidated');
    if(q.action==='prepare'){
     this.#editor=null;
     const saved=this.store.appendIsolatedRootOperation(entry.record,this.#digest);
     if(keys(saved)!=='committed,digest'||saved.committed!==true||typeof saved.digest!=='string')throw Error('Original not saved');
     this.#load();retained=this.#records.get(q.reference);
     if(!retained||saved.digest!==this.#digest||!isDeepStrictEqual(retained.entry.record,entry.record))throw Error('Original not confirmed');
    }
    // A synchronous store write may consume the budget; never send afterward.
    if(this.#lost(token,epoch))return this.#value('invalidated');
    if(this.now()>=deadline||!same(entry.record,this.observer.lastObservation))return this.#value(retained?.state??'unknown',q.reference);
    input=Buffer.from(retained.entry.input);
    if(isolatedRootHash(input)!==retained.entry.record.input_sha256)throw Error('Original input changed');
    retained.state='unknown';
    raw=await this.#raw('provision-isolated-backup',input,sample,deadline);
    if(this.#stale(token,epoch,deadline))return this.#value('invalidated');
    const report=parseIsolatedRootRaw(raw,retained.entry.original);
    retained.state=report.result?.outcome==='root-verified'?'verified':'unknown';
    return this.#value(retained.state,q.reference,{sample,report});
   }catch(error){
    if(this.#lost(token,epoch))return this.#value('invalidated');
    const original=this.#records.get(q.reference);
    if(original)return this.#value(original.state,q.reference);
    return this.#value(error instanceof IsolatedRootUnsupported?'unsupported':'storage-unavailable');
   }finally{input?.fill(0);raw?.fill(0);if(q.action==='prepare')entry.input.fill(0);}
  });
 }
 dispose(){this.invalidate();for(const value of this.#records.values())value.entry.input.fill(0);this.#records.clear();}
}
