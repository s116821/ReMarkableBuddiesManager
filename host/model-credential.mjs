import {strictJson} from './strict-json.mjs';
import { randomBytes,randomUUID } from 'node:crypto';
import {parseModelCredentialRequest,parseModelCredentialResult,parseModelCredentialChange,modelCredentialContext} from './model-credential-protocol.mjs';
import {parseModelCredentialReport,hash,CONFIG} from './model-credential-private.mjs';
import { validateResult } from './observation-protocol.mjs';
import { MaintenanceIO } from './maintenance-io.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class ModelCredentialHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Operation budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});
 }
 invalidate(){
  this.#epoch++;const active=this.#active;if(active){for(const b of active.buffers)b.fill(0);active.buffers.length=0;this.io.release(active.token);if(active.operation==='save'&&active.context.possible){active.context.state='unknown';active.context.report=null;this.#records.set(active.context.reference,active.context);}}this.#active=null;
  const s=this.#editor;if(s){if(s.possible){if(s.state!=='unresolved')s.state='unknown';s.report=null;this.#records.set(s.reference,s);}else{s.state='invalidated';this.#purge(s);}this.#editor=null;}
 }
 #purge(s){clearTimeout(s.readyTimer);s.readyTimer=null;clearTimeout(s.expiryTimer);s.expiryTimer=null;const p=s.packet;if(p){p.original.fill(0);p.input.fill(0);}s.packet=null;s.binding=null;}
 #expire(){
  if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline)this.invalidate();
  for(const s of this.#records.values())if(s.packet&&this.now()>=s.originalDeadline){
   const active=this.#active;if(active?.context===s){this.invalidate();this.observer.cancel();}this.#purge(s);
  }
 }
 #retained(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,state:s.state==='unresolved'?'unresolved':'unknown',status_available:!!s.packet}));}
 #value(state,s=null,{current=null,report=null,observed=false,reference=state==='none'||state==='invalidated'||state==='capacity'?null:s?.reference??null}={}){
  const value={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,model_credential:{state,reference,current:current?structuredClone(current):null,report:report?{...report}:null,retained:this.#retained()}};
  this.#issued.set(value,this.#epoch);return value;
 }
 assertCurrent(value){
  this.#expire();if(value.status==='observed'&&this.#issued.get(value)!==this.#epoch)throw Error('Credential reference invalidated');
  if(value.model_credential.state==='ready'&&(!this.#editor||this.#editor.state!=='ready'||value.model_credential.reference!==this.#editor.reference||JSON.stringify(value.model_credential.current)!==JSON.stringify(this.#editor.current)))throw Error('Editor invalidated');return value;
 }
 #stale(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 #uncertain(s){return this.#value('unknown',s);}
 async #owned(s,operation,handler){
  const token=this.io.acquire('model-credential',s.reference,operation);if(!token)return this.#value('busy',s);
  const deadline=Math.min(this.now()+this.budgetMs,operation==='status'?s.originalDeadline:Infinity);if(operation!=='save')this.invalidate();this.beforeIO();const epoch=this.#epoch,active={token,context:s,operation,buffers:[]};this.#active=active;
  const timer=setTimeout(()=>{if(this.io.owns(token)){this.invalidate();this.observer.cancel();}},Math.max(1,deadline-this.now()));
  try{return await handler(token,epoch,deadline);}finally{for(const buffer of active.buffers)buffer.fill(0);active.buffers.length=0;clearTimeout(timer);this.io.release(token);if(this.#active===active)this.#active=null;}
 }
 async #raw(selector,input,sample,deadline){
  const buffers=this.#active?.buffers;
  if(input!==null&&input.length>16384)throw Error('Private input refused');
  const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1)throw Error('Operation expired');
  const request={selector,input_base64:input===null?null:input.toString('base64'),budget_ms,connection_id:sample.connection_id,boot_id:sample.boot_id};if(Buffer.byteLength(JSON.stringify(request))>24576)throw Error('Private envelope refused');let v;
  let timer;try{v=await Promise.race([this.observer.run('model-credential',request),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operation expired')),Math.max(1,deadline-this.now()));})]);}finally{clearTimeout(timer);request.input_base64=null;input=null;}
  if(this.now()>=deadline)throw Error('Operation expired');
  if(!v||Object.keys(v).sort().join()!=='contract_version,model_credential_raw,observation,status'||Buffer.byteLength(JSON.stringify(v))>24576)throw Error('Private transport refused');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const q=v.model_credential_raw;
  if(!q||Object.keys(q).sort().join()!=='status,stdout_base64'||q.status!=='reported'||v.status!=='observed'||!same(v.observation,sample)){const e=Error('Private transport refused');e.unsupported=q?.status==='unsupported';throw e;}
  if(typeof q.stdout_base64!=='string')throw Error('Private transport refused');const raw=Buffer.from(q.stdout_base64,'base64');buffers?.push(raw);if(raw.length>16384||raw.toString('base64')!==q.stdout_base64)throw Error('Private report refused');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw),report=JSON.parse(text);strictJson(raw);if(!text.endsWith('\n')||text.split('\n').length!==2)throw Error('Private report framing refused');if(this.now()>=deadline)throw Error('Operation expired');return {raw,report,sample:v.observation};
 }
 #packet(s){const p=s.packet;if(!p||hash(p.original)!==p.originalSha||hash(p.input)!==p.inputSha||JSON.stringify({intent:p.intent})!==p.input.toString('utf8'))throw Error('Original packet refused');return p;}
 async request(value){
  let q=parseModelCredentialRequest(value);value=null;const context=modelCredentialContext(q);this.#expire();let result;
  if(q.action==='retained')result=this.#value('none');
  else if(q.action==='cancel')result=this.#cancel(q);
  else if(q.action==='begin')result=await this.#begin(q);
  else if(q.action==='save'){let change=parseModelCredentialChange(q.change);q=null;const pending=this.#save(context,change);change=null;result=await pending;}
  else result=await this.#status(q);
  q=null;parseModelCredentialResult(result,context,validateResult);return this.assertCurrent(result);
 }
 #cancel(q){
  const s=this.#editor?.reference===q.reference?this.#editor:this.#records.get(q.reference);if(!s)return this.#value('unavailable',null,{reference:q.reference});
  const token=this.io.ownerFor('model-credential',s.reference);
  if(token&&this.#active?.token===token&&this.#active.context===s){this.invalidate();this.observer.cancel();return s.possible?this.#uncertain(s):this.#value('not-dispatched',s);}
  if(s===this.#editor&&s.state==='ready'){this.#purge(s);this.#editor=null;s.state='invalidated';this.#epoch++;return this.#value('invalidated');}
  return this.#records.has(s.reference)?this.#uncertain(s):this.#value('invalidated');
 }
 async #begin(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable');if(this.#records.size>=8)return this.#value('capacity');
  const s={reference:this.reference(),sample:structuredClone(sample),state:'inspecting',possible:false,packet:null,report:null,deadline:this.now()+120000};
  if(this.#records.has(s.reference))return this.#value('unavailable');
  return this.#owned(s,'begin',async(token,epoch,deadline)=>{
   this.#editor=s;
   try{
    const raw=await this.#raw('inspect',null,s.sample,deadline);if(this.#stale(token,epoch))return this.#value('invalidated');const parsed=parseModelCredentialReport(raw.report,'inspect');if(parsed.report.status==='ok'&&parsed.binding.config_path_sha256!==hash('urn:remarkable-buddies:model-credential-config-path:v1:'+CONFIG))throw Error('Original path refused');if(this.#stale(token,epoch)||this.now()>=deadline){if(this.#editor===s)this.#editor=null;return this.#value('invalidated');}
    if(parsed.report.status!=='ok'){this.#editor=null;return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'unavailable',null,{report:parsed.report});}
    Object.assign(s,{state:'ready',current:parsed.current,binding:parsed.binding});s.readyTimer=setTimeout(()=>this.#expire(),Math.max(1,s.deadline-this.now()));s.readyTimer.unref?.();return this.#value('ready',s,{current:s.current,report:parsed.report,observed:true});
   }catch(e){if(this.#stale(token,epoch))return this.#value('invalidated');this.#editor=null;return this.#value(e.unsupported?'unsupported':'unavailable');}
  });
 }
 async #save(q,change){
  let prepareInput=null,applyInput=null,s=null;
  try{
   s=this.#editor;if(!s||s.state!=='ready'||s.reference!==q.reference||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
   if(this.#records.size>=8){this.#editor=null;s.state='invalidated';this.#epoch++;return this.#value('capacity');}
   return await this.#owned(s,'save',async(token,epoch,deadline)=>{
    clearTimeout(s.readyTimer);s.readyTimer=null;s.state='preparing';const operation=this.uuid();
    try{
     prepareInput=Buffer.from(JSON.stringify({credential_version:1,operation,base:s.binding,change}));this.#active.buffers.push(prepareInput);
     const raw=await this.#raw('prepare',prepareInput,s.sample,Math.min(deadline,s.deadline));prepareInput.fill(0);prepareInput=null;
     if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s);}
     const prepared=parseModelCredentialReport(raw.report,'prepare',{base:s.binding,operation,change});
     if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s);}
     if(prepared.report.status!=='ok'){if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s,{report:prepared.report});}
     if(!prepared.intent){if(this.#editor===s)this.#editor=null;return this.#value('no-change',s,{current:prepared.current,report:prepared.report,observed:true});}
     // All retained fingerprints/intent are confidential. Raw CHANGE is never retained.
     const statusInput=Buffer.from(JSON.stringify({intent:prepared.intent}));s.packet=Object.freeze({original:Buffer.from(raw.raw),input:statusInput,originalSha:hash(raw.raw),inputSha:hash(statusInput),intent:structuredClone(prepared.intent)});
     applyInput=Buffer.from(JSON.stringify({intent:prepared.intent,change}));this.#active.buffers.push(applyInput);if(applyInput.length>16384||statusInput.length>16384||[applyInput,statusInput].some(input=>Buffer.byteLength(JSON.stringify({selector:'status',input_base64:input.toString('base64'),budget_ms:12000,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id}))>24576))throw Error('Original packet refused');
     if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){this.#purge(s);if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s);}
     s.originalDeadline=this.now()+1800000;s.possible=true;s.state='unknown';this.#records.set(s.reference,s);s.expiryTimer=setTimeout(()=>this.#expire(),1800000);s.expiryTimer.unref?.();
     const output=await this.#raw('apply',applyInput,s.sample,deadline);applyInput.fill(0);applyInput=null;
     this.#expire();if(this.#stale(token,epoch)||this.now()>=deadline||!s.packet)return this.#uncertain(s);
     const applied=parseModelCredentialReport(output.report,'apply',{intent:this.#packet(s).intent});
     this.#expire();if(this.#stale(token,epoch)||this.now()>=deadline||!s.packet)return this.#uncertain(s);
     if(this.#editor===s)this.#editor=null;
     if(applied.report.status==='ok'){this.#records.delete(s.reference);s.possible=false;this.#purge(s);s.state='verified';return this.#value('verified',s,{current:applied.current,report:applied.report,observed:true});}
     if(applied.report.outcome==='not-dispatched'){this.#records.delete(s.reference);s.possible=false;this.#purge(s);s.state='not-dispatched';return this.#value('not-dispatched',s,{report:applied.report});}
     s.report=applied.report;return this.#value('unknown',s,{report:applied.report});
    }catch{
     if(this.#editor===s)this.#editor=null;if(s.possible){s.state='unknown';return this.#uncertain(s);}this.#purge(s);return this.#value('not-dispatched',s);
    }
   });
  }finally{
   prepareInput?.fill(0);applyInput?.fill(0);prepareInput=null;applyInput=null;
   if(change&&'value'in change)change.value='';if(s&&s.state!=='ready')s.binding=null;
   if(change)for(const key of Object.keys(change))delete change[key];change=null;
  }
 }
 async #status(q){
  const s=this.#records.get(q.reference);if(!s||!s.packet||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'status',async(token,epoch,deadline)=>{
   try{
    const raw=await this.#raw('status',this.#packet(s).input,s.sample,deadline);this.#expire();if(this.#stale(token,epoch)||!s.packet)return this.#uncertain(s);
    const parsed=parseModelCredentialReport(raw.report,'status',{intent:this.#packet(s).intent});this.#expire();if(this.#stale(token,epoch)||this.now()>=deadline||!s.packet)return this.#uncertain(s);
    if(parsed.report.status!=='ok')return this.#value(parsed.report.status==='busy'?'busy':'unavailable',s,{report:parsed.report});
    if(parsed.report.outcome==='desired-file-observed'){this.#records.delete(s.reference);s.possible=false;this.#purge(s);return this.#value('desired-file-observed',s,{current:parsed.current,report:parsed.report,observed:true});}
    s.state='unresolved';return this.#value('unresolved',s,{current:parsed.current,report:parsed.report,observed:true});
   }catch{this.#expire();return this.#uncertain(s);}
  });
 }
}
