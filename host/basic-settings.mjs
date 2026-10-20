import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { parseBasicSettingsRequest,parseBasicSettingsReport,parseBasicSettingsResult,parseBasicChanges } from './basic-settings-protocol.mjs';
import { validateResult } from './observation-protocol.mjs';
import { MaintenanceIO } from './maintenance-io.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class BasicSettingsHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Operation budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});
 }
 invalidate(){
  this.#epoch++;const active=this.#active;if(active){this.io.release(active.token);if(active.operation==='save'&&active.context.possible){active.context.state='unknown';active.context.report=null;this.#records.set(active.context.reference,active.context);}}this.#active=null;
  const s=this.#editor;if(s){if(s.possible){s.state='unknown';s.report=null;this.#records.set(s.reference,s);}else{s.state='invalidated';s.packet=null;}this.#editor=null;}
 }
 #expire(){if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline)this.invalidate();}
 #retained(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,state:s.state==='unresolved'?'unresolved':'unknown'}));}
 #value(state,s=null,{current=null,report=null,observed=false,reference=state==='none'||state==='invalidated'||state==='capacity'?null:s?.reference??null}={}){
  const value={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,basic_settings:{state,reference,current:current?structuredClone(current):null,report:report?{...report}:null,retained:this.#retained()}};
  this.#issued.set(value,this.#epoch);return value;
 }
 assertCurrent(value){
  this.#expire();if(value.status==='observed'&&this.#issued.get(value)!==this.#epoch)throw Error('Basic settings invalidated');
  if(value.basic_settings.state==='ready'&&(!this.#editor||this.#editor.state!=='ready'||value.basic_settings.reference!==this.#editor.reference||JSON.stringify(value.basic_settings.current)!==JSON.stringify(this.#editor.current)))throw Error('Editor invalidated');return value;
 }
 #stale(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 #uncertain(s){return this.#value(s.state==='unresolved'?'unresolved':'unknown',s);}
 async #owned(s,operation,handler){
  const token=this.io.acquire('basic',s.reference,operation);if(!token)return this.#value('busy',s);
  const deadline=this.now()+this.budgetMs;if(operation!=='save')this.invalidate();this.beforeIO();const epoch=this.#epoch,active={token,context:s,operation};this.#active=active;
  const timer=setTimeout(()=>{if(this.io.owns(token)){this.invalidate();this.observer.cancel();}},Math.max(1,deadline-this.now()));
  try{return await handler(token,epoch,deadline);}finally{clearTimeout(timer);this.io.release(token);if(this.#active===active)this.#active=null;}
 }
 async #raw(selector,input,sample,deadline){
  if(input!==null&&input.length>16384)throw Error('Private input refused');
  const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1)throw Error('Operation expired');
  const v=await this.observer.run('basic-settings',{selector,input_base64:input===null?null:input.toString('base64'),budget_ms,connection_id:sample.connection_id,boot_id:sample.boot_id});
  if(this.now()>=deadline)throw Error('Operation expired');
  if(!v||Object.keys(v).sort().join()!=='basic_raw,contract_version,observation,status'||Buffer.byteLength(JSON.stringify(v))>24576)throw Error('Private transport refused');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const q=v.basic_raw;
  if(!q||Object.keys(q).sort().join()!=='status,stdout_base64'||q.status!=='reported'||v.status!=='observed'||!same(v.observation,sample)){const e=Error('Private transport refused');e.unsupported=q?.status==='unsupported';throw e;}
  if(typeof q.stdout_base64!=='string')throw Error('Private transport refused');const raw=Buffer.from(q.stdout_base64,'base64');if(raw.length>16384||raw.toString('base64')!==q.stdout_base64)throw Error('Private report refused');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(raw),report=JSON.parse(text);if(!text.endsWith('\n')||text.split('\n').length!==2)throw Error('Private report framing refused');if(this.now()>=deadline)throw Error('Operation expired');return {raw,report,sample:v.observation};
 }
 #packet(s){const p=s.packet;if(!p||hash(p.original)!==p.originalSha||hash(p.input)!==p.inputSha)throw Error('Original packet refused');return p;}
 async request(value){
  const q=parseBasicSettingsRequest(value);this.#expire();let result;
  if(q.action==='retained')result=this.#value('none');
  else if(q.action==='cancel')result=this.#cancel(q);
  else if(q.action==='begin')result=await this.#begin(q);
  else if(q.action==='save')result=await this.#save(q);
  else result=await this.#status(q);
  parseBasicSettingsResult(result,q,validateResult);return this.assertCurrent(result);
 }
 #cancel(q){
  const s=this.#editor?.reference===q.reference?this.#editor:this.#records.get(q.reference);if(!s)return this.#value('unavailable',null,{reference:q.reference});
  const token=this.io.ownerFor('basic',s.reference);
  if(token&&this.#active?.token===token&&this.#active.context===s){this.invalidate();this.observer.cancel();return s.possible?this.#uncertain(s):this.#value('not-dispatched',s);}
  if(s===this.#editor&&s.state==='ready'){this.#editor=null;s.state='invalidated';this.#epoch++;return this.#value('invalidated');}
  return this.#records.has(s.reference)?this.#uncertain(s):this.#value('invalidated');
 }
 async #begin(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable');
  const s={reference:this.reference(),sample:structuredClone(sample),state:'inspecting',possible:false,packet:null,report:null};
  if(this.#records.has(s.reference))return this.#value('unavailable');
  return this.#owned(s,'begin',async(token,epoch,deadline)=>{
   this.#editor=s;
   try{
    const raw=await this.#raw('inspect',null,s.sample,deadline);if(this.#stale(token,epoch))return this.#value('invalidated');const parsed=parseBasicSettingsReport(raw.report,'inspect');if(this.#stale(token,epoch)||this.now()>=deadline){if(this.#editor===s)this.#editor=null;return this.#value('invalidated');}
    if(parsed.report.status!=='ok'){this.#editor=null;return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'unavailable',null,{report:parsed.report});}
    Object.assign(s,{state:'ready',current:parsed.current,base_sha256:parsed.base_sha256,config_path_sha256:parsed.config_path_sha256,deadline:this.now()+120000});return this.#value('ready',s,{current:s.current,report:parsed.report,observed:true});
   }catch(e){if(this.#stale(token,epoch))return this.#value('invalidated');this.#editor=null;return this.#value(e.unsupported?'unsupported':'unavailable');}
  });
 }
 async #save(q){
  const s=this.#editor;if(!s||s.state!=='ready'||s.reference!==q.reference||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  if(this.#records.size>=8){this.#editor=null;s.state='invalidated';this.#epoch++;return this.#value('capacity');}
  const changes=parseBasicChanges(q.changes);
  return this.#owned(s,'save',async(token,epoch,deadline)=>{
   s.state='preparing';const operation=this.uuid();
   try{
    const input=Buffer.from(JSON.stringify({basic_version:1,operation,base_sha256:s.base_sha256,config_path_sha256:s.config_path_sha256,changes}));
    const raw=await this.#raw('prepare',input,s.sample,Math.min(deadline,s.deadline));
    if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s);}
    const prepared=parseBasicSettingsReport(raw.report,'prepare',{...s,operation,changes});
    if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s);}
    if(prepared.report.status!=='ok'){if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s,{report:prepared.report});}
    if(!prepared.intent){if(this.#editor===s)this.#editor=null;return this.#value('no-change',s,{current:prepared.current,report:prepared.report,observed:true});}
    const packet=Buffer.from(JSON.stringify({intent:prepared.intent}));s.packet=Object.freeze({original:Buffer.from(raw.raw),input:packet,originalSha:hash(raw.raw),inputSha:hash(packet),intent:structuredClone(prepared.intent)});s.after=structuredClone(prepared.after);
    if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){s.packet=null;if(this.#editor===s)this.#editor=null;return this.#value('not-dispatched',s);}
    // One irreversible same-host claim; exact original bytes are retained first.
    s.possible=true;s.state='unknown';this.#records.set(s.reference,s);
    const output=await this.#raw('apply',this.#packet(s).input,s.sample,deadline);
    if(this.#stale(token,epoch)||this.now()>=deadline)return this.#uncertain(s);
    const applied=parseBasicSettingsReport(output.report,'apply',{intent:s.packet.intent,after:s.after});
    if(this.#stale(token,epoch)||this.now()>=deadline)return this.#uncertain(s);
    if(this.#editor===s)this.#editor=null;
    if(applied.report.status==='ok'){this.#records.delete(s.reference);s.state='verified';return this.#value('verified',s,{current:applied.current,report:applied.report,observed:true});}
    if(applied.report.outcome==='not-dispatched'){this.#records.delete(s.reference);s.possible=false;s.packet=null;s.state='not-dispatched';return this.#value('not-dispatched',s,{report:applied.report});}
    s.report=applied.report;return this.#value('unknown',s,{report:applied.report});
   }catch{
    if(this.#editor===s)this.#editor=null;if(s.possible){s.state='unknown';return this.#uncertain(s);}s.packet=null;return this.#value('not-dispatched',s);
   }
  });
 }
 async #status(q){
  const s=this.#records.get(q.reference);if(!s||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'status',async(token,epoch,deadline)=>{
   try{
    const raw=await this.#raw('status',this.#packet(s).input,s.sample,deadline);if(this.#stale(token,epoch))return this.#uncertain(s);
    const parsed=parseBasicSettingsReport(raw.report,'status',{intent:s.packet.intent,after:s.after});if(this.#stale(token,epoch)||this.now()>=deadline)return this.#uncertain(s);
    if(parsed.report.status!=='ok')return this.#value(s.state,s,{report:parsed.report});
    if(parsed.report.outcome==='desired-file-observed'){this.#records.delete(s.reference);return this.#value('desired-file-observed',s,{current:parsed.current,report:parsed.report,observed:true});}
    s.state='unresolved';return this.#value('unresolved',s,{current:parsed.current,report:parsed.report,observed:true});
   }catch{return this.#uncertain(s);}
  });
 }
}
