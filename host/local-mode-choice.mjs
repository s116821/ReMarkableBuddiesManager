import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {strictJson} from './strict-json.mjs';
import {parseLocalModeRequest,parseLocalModeOriginal,parseLocalModeReport,parseLocalModeResult} from './local-mode-choice-protocol.mjs';
import {validateResult} from './observation-protocol.mjs';
import {MaintenanceIO} from './maintenance-io.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class LocalModeChoiceHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Operation budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});
 }
 invalidate(){
  this.#epoch++;const active=this.#active;
  if(active){this.io.release(active.token);if(active.operation==='choose'&&active.context.possible){active.context.state='unknown';active.context.receipt=null;}}
  this.#active=null;
  if(this.#editor){const s=this.#editor;if(!s.possible){s.state='invalidated';s.packet?.input.fill(0);s.packet?.original.fill(0);s.packet=null;}this.#editor=null;}
 }
 #expire(){if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline)this.invalidate();}
 #retained(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,state:s.state}));}
 #value(state,s=null,{current=null,observed=false,reference=['none','invalidated','capacity'].includes(state)?null:s?.reference??null}={}){
  let receipt=state==='acknowledged'?s.receipt:null;
  if(receipt&&current)receipt={...receipt,historical:current.kind!=='local-only'||current.epoch!==receipt.epoch};
  const v={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,local_mode_choice:{state,reference,current:current?structuredClone(current):null,receipt:receipt?{...receipt}:null,retained:this.#retained()}};
  this.#issued.set(v,this.#epoch);return v;
 }
 assertCurrent(v){
  this.#expire();if(v.status==='observed'&&this.#issued.get(v)!==this.#epoch)throw Error('Local-only choice invalidated');
  if(v.local_mode_choice.state==='ready'&&(!this.#editor||this.#editor.state!=='ready'||v.local_mode_choice.reference!==this.#editor.reference||JSON.stringify(v.local_mode_choice.current)!==JSON.stringify(this.#editor.current)))throw Error('Local-only preview invalidated');return v;
 }
 #stale(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 async #owned(s,operation,handler){
  const token=this.io.acquire('local-mode-choice',s.reference,operation);if(!token)return this.#value('busy',s);
  const deadline=this.now()+this.budgetMs;if(operation!=='choose')this.invalidate();this.beforeIO();const epoch=this.#epoch,active={token,context:s,operation,buffers:[]};this.#active=active;
  const timer=setTimeout(()=>{if(this.io.owns(token)){this.invalidate();this.observer.cancel();}},Math.max(1,deadline-this.now()));
  try{return await handler(token,epoch,deadline);}finally{for(const b of active.buffers)b.fill(0);clearTimeout(timer);this.io.release(token);if(this.#active===active)this.#active=null;}
 }
 async #raw(selector,input,sample,deadline){
  const buffers=this.#active?.buffers;
  const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1||input!==null&&input.length>16384)throw Error('Private operation refused');
  const request={selector,input_base64:input===null?null:input.toString('base64'),budget_ms,connection_id:sample.connection_id,boot_id:sample.boot_id},active=this.#active;let v,timer;
  try{v=await Promise.race([this.observer.run('local-mode-choice',request),new Promise((_,reject)=>{timer=setTimeout(()=>{if(active&&this.io.owns(active.token)){this.invalidate();this.observer.cancel();}reject(Error('Private operation expired'));},Math.max(1,deadline-this.now()));})]);}finally{clearTimeout(timer);request.input_base64=null;}
  if(this.now()>=deadline||!v||Object.keys(v).sort().join()!=='contract_version,local_mode_raw,observation,status'||Buffer.byteLength(JSON.stringify(v))>24576)throw Error('Private transport refused');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const q=v.local_mode_raw;
  if(!q||Object.keys(q).sort().join()!=='status,stdout_base64'||q.status!=='reported'||v.status!=='observed'||!same(v.observation,sample)){const e=Error('Private transport refused');e.unsupported=q?.status==='unsupported';throw e;}
  if(typeof q.stdout_base64!=='string')throw Error('Private output refused');const raw=Buffer.from(q.stdout_base64,'base64');buffers?.push(raw);
  if(raw.length>16384||raw.toString('base64')!==q.stdout_base64)throw Error('Private output refused');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(text.charCodeAt(0)===0xfeff||!text.endsWith('\n')||text.split('\n').length!==2)throw Error('Private framing refused');return {raw,report:strictJson(raw)};
 }
 async request(value){
  const q=parseLocalModeRequest(value);this.#expire();let v;
  if(q.action==='retained')v=this.#value('none');
  else if(q.action==='begin')v=await this.#begin(q);
  else if(q.action==='choose')v=await this.#choose(q);
  else if(q.action==='refresh')v=await this.#refresh(q);
  else v=this.#cancel(q);
  parseLocalModeResult(v,q,validateResult);return this.assertCurrent(v);
 }
 #cancel(q){
  const s=this.#editor?.reference===q.reference?this.#editor:this.#records.get(q.reference);if(!s)return this.#value('unavailable',null,{reference:q.reference});
  const active=this.#active;if(active?.context===s&&this.io.owns(active.token)){this.invalidate();this.observer.cancel();return this.#value(s.possible?s.state:'invalidated',s);}
  if(s===this.#editor){this.invalidate();return this.#value('invalidated');}
  return this.#value(s.state,s);
 }
 async #begin(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable');
  const unresolved=[...this.#records.values()].find(s=>s.state==='unknown'&&s.sample.connection_id===q.connection_id);if(unresolved)return this.#value('unknown',unresolved);
  if(this.#records.size>=8)return this.#value('capacity');
  const s={reference:this.reference(),sample:structuredClone(sample),state:'inspecting',possible:false,packet:null,receipt:null};
  if(this.#records.has(s.reference))return this.#value('unavailable');
  return this.#owned(s,'begin',async(token,epoch,deadline)=>{
   this.#editor=s;
   try{
    const raw=await this.#raw('inspect',null,s.sample,deadline);if(this.#stale(token,epoch))return this.#value('invalidated');const parsed=parseLocalModeReport(raw.report,'inspect');
    if(parsed.status!=='ok'||parsed.incomplete){this.#editor=null;return this.#value(parsed.status==='busy'?'busy':parsed.status==='unsupported'?'unsupported':'unavailable');}
    const original=parseLocalModeOriginal({operation:this.uuid(),expected:parsed.token,choice:{kind:'local-only'}}),input=Buffer.from(JSON.stringify(original));
    s.packet=Object.freeze({original:Buffer.from(raw.raw),input,originalSha:hash(raw.raw),inputSha:hash(input),intent:original,request_sha256:hash(JSON.stringify([original.expected.actor,original.expected.sha256,original.choice]))});
    s.current=parsed.current;s.state='ready';s.deadline=this.now()+120000;return this.#value('ready',s,{current:s.current,observed:true});
   }catch(error){if(this.#stale(token,epoch))return this.#value('invalidated');this.invalidate();return this.#value(error.unsupported?'unsupported':'unavailable');}
  });
 }
 async #choose(q){
  const s=this.#editor,record=this.#records.get(q.reference);
  if(record)return same(record.sample,q)&&same(record.sample,this.observer.lastObservation)?this.#value(record.state,record):this.#value('unavailable',null,{reference:q.reference});
  if(!s||s.state!=='ready'||s.reference!==q.reference||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  if(this.#records.size>=8)return this.#value('capacity');
  return this.#owned(s,'choose',async(token,epoch,deadline)=>{
   try{
    const p=s.packet;if(!p||hash(p.original)!==p.originalSha||hash(p.input)!==p.inputSha||this.#stale(token,epoch)||this.now()>=s.deadline||this.now()>=deadline){this.invalidate();return this.#value('invalidated');}
    s.state='unknown';s.possible=true;this.#records.set(s.reference,s);this.#editor=null;
    const raw=await this.#raw('choose',p.input,s.sample,Math.min(deadline,s.deadline));if(this.#stale(token,epoch))return this.#value('unknown',s);
    const parsed=parseLocalModeReport(raw.report,'choose',{original:p.intent,request_sha256:p.request_sha256});
    if(parsed.status==='ok'&&!parsed.incomplete&&parsed.receipt){s.state='acknowledged';s.receipt=parsed.receipt;return this.#value('acknowledged',s,{current:parsed.current,observed:true});}
    if(!parsed.incomplete&&['invalid-input','busy','conflict'].includes(parsed.status)||parsed.status==='unsupported'&&!parsed.incomplete&&parsed.current===null){s.state='refused';return this.#value('refused',s);}
    return this.#value('unknown',s);
   }catch{return this.#value(s.possible?'unknown':'invalidated',s);}
  });
 }
 async #refresh(q){
  const s=this.#records.get(q.reference);if(!s||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'refresh',async(token,epoch,deadline)=>{
   try{const raw=await this.#raw('inspect',null,s.sample,deadline);if(this.#stale(token,epoch))return this.#value(s.state,s);const parsed=parseLocalModeReport(raw.report,'inspect');return this.#value(s.state,s,parsed.status==='ok'&&!parsed.incomplete?{current:parsed.current,observed:true}:{});}catch{return this.#value(s.state,s);}
  });
 }
 dispose(){this.invalidate();for(const s of this.#records.values()){s.packet?.input.fill(0);s.packet?.original.fill(0);}this.#records.clear();}
}
