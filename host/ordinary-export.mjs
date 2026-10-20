import {randomUUID,createHash} from 'node:crypto';
import {parseExportRequest,exportResponseContext,parseExportResult,parseExportReport,EXPORT_CONFIG} from './ordinary-export-protocol.mjs';
import {validateResult} from './observation-protocol.mjs';
import {MaintenanceIO} from './maintenance-io.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class OrdinaryExportHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=randomUUID,budgetMs=13000}={}){if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Operation budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});}
 #drop(s){if(!s)return;clearTimeout(s.readyTimer);s.readyTimer=null;s.destination='';if(s.packet){s.packet.original.fill(0);s.packet.input.fill(0);s.packet=null;}}
 invalidate(){
  this.#epoch++;const active=this.#active;
  if(active){this.io.release(active.token);if(active.operation==='confirm'&&active.context.possible){active.context.state='unknown';active.context.report=null;this.#records.set(active.context.reference,active.context);}}this.#active=null;
  const s=this.#editor;if(s){if(s.possible){s.state='unknown';s.report=null;this.#records.set(s.reference,s);}else{this.#drop(s);s.state='invalidated';}this.#editor=null;}
 }
 #expire(){if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline)this.invalidate();}
 #retained(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,state:s.state==='unresolved'?'unresolved':'unknown'}));}
 #value(state,s=null,{summary=null,report=null,observed=false,reference=['none','invalidated','capacity'].includes(state)?null:s?.reference??null}={}){
  const v={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,ordinary_export:{state,reference,summary:summary?structuredClone(summary):null,report:report?{...report}:null,retained:this.#retained()}};this.#issued.set(v,this.#epoch);return v;
 }
 assertCurrent(v){this.#expire();if(v.status==='observed'&&this.#issued.get(v)!==this.#epoch)throw Error('Export invalidated');if(v.ordinary_export.state==='ready'&&(!this.#editor||this.#editor.state!=='ready'||v.ordinary_export.reference!==this.#editor.reference||JSON.stringify(v.ordinary_export.summary)!==JSON.stringify(this.#editor.summary)))throw Error('Preview invalidated');return v;}
 #stale(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 #uncertain(s){return this.#value(s.state==='unresolved'?'unresolved':'unknown',s,{report:s.state==='unresolved'?s.report:null});}
 async #owned(s,operation,handler){
  const token=this.io.acquire('ordinary-export',s.reference,operation);if(!token)return this.#value('busy',s);
  const deadline=this.now()+this.budgetMs;if(operation!=='confirm')this.invalidate();this.beforeIO();const epoch=this.#epoch,active={token,context:s,operation};this.#active=active;
  const timer=setTimeout(()=>{if(this.io.owns(token)){this.invalidate();this.observer.cancel();}},Math.max(1,deadline-this.now()));
  try{return await handler(token,epoch,deadline);}finally{clearTimeout(timer);this.io.release(token);if(this.#active===active)this.#active=null;}
 }
 #envelope(selector,input,sample,budget_ms){const q={selector,input_base64:input.toString('base64'),budget_ms,connection_id:sample.connection_id,boot_id:sample.boot_id};if(input.length>16384||Buffer.byteLength(JSON.stringify(q))>24576)throw Error('Private input refused');return q;}
 async #raw(selector,input,sample,deadline){
  const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1)throw Error('Operation expired');const q=this.#envelope(selector,input,sample,budget_ms);let v;
  try{v=await this.observer.run('ordinary-export',q);}finally{q.input_base64=null;input=null;}
  if(this.now()>=deadline)throw Error('Operation expired');
  if(!v||Object.keys(v).sort().join()!=='contract_version,export_raw,observation,status'||Buffer.byteLength(JSON.stringify(v))>24576)throw Error('Private transport refused');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const r=v.export_raw;
  if(!r||Object.keys(r).sort().join()!=='status,stdout_base64'||r.status!=='reported'||v.status!=='observed'||!same(v.observation,sample)){const e=Error('Private transport refused');e.unsupported=r?.status==='unsupported';throw e;}
  if(typeof r.stdout_base64!=='string')throw Error('Private report refused');const raw=Buffer.from(r.stdout_base64,'base64');
  try{if(raw.length>16384||raw.toString('base64')!==r.stdout_base64)throw Error('Private report refused');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(!text.endsWith('\n')||text.split('\n').length!==2)throw Error('Private report refused');const report=JSON.parse(text);if(this.now()>=deadline)throw Error('Operation expired');return {raw:Buffer.from(raw),report};}finally{raw.fill(0);}
 }
 #packet(s){const p=s.packet;if(!p||hash(p.original)!==p.originalSha||hash(p.input)!==p.inputSha)throw Error('Original packet refused');return p;}
 async request(value){let q=parseExportRequest(value);value=null;const context=exportResponseContext(q);this.#expire();let result;
  if(q.action==='retained')result=this.#value('none');else if(q.action==='cancel')result=this.#cancel(q);else if(q.action==='prepare'){const pending=this.#prepare(context,q.destination);q=null;result=await pending;}else if(q.action==='confirm')result=await this.#confirm(q);else result=await this.#status(q);
  q=null;parseExportResult(result,context,validateResult);return this.assertCurrent(result);
 }
 #cancel(q){const s=this.#editor?.reference===q.reference?this.#editor:this.#records.get(q.reference);if(!s)return this.#value('unavailable',null,{reference:q.reference});const token=this.io.ownerFor('ordinary-export',s.reference);
  if(token&&this.#active?.token===token&&this.#active.context===s){this.invalidate();this.observer.cancel();return s.possible?this.#uncertain(s):this.#value('not-dispatched',s);}
  if(s===this.#editor){this.invalidate();return this.#value('invalidated');}return this.#records.has(s.reference)?this.#uncertain(s):this.#value('invalidated');
 }
 async #prepare(q,destination){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable');
  if(this.#records.size>=8)return this.#value('capacity');
  const s={reference:this.reference(),sample:structuredClone(sample),state:'preparing',possible:false,packet:null,report:null,destination,summary:null};destination=null;
  if(this.#records.has(s.reference))return this.#value('unavailable');
  return this.#owned(s,'prepare',async(token,epoch,deadline)=>{
   this.#editor=s;let input=null,raw=null;
   try{const operation=this.uuid(),destination_path_sha256=hash('urn:remarkable-buddies:ordinary-export-path:v1:'+s.destination),config_path_sha256=hash('urn:remarkable-buddies:ordinary-export-config:v1:'+EXPORT_CONFIG);
    input=Buffer.from(JSON.stringify({export_version:1,operation,destination:s.destination}));raw=await this.#raw('prepare',input,s.sample,deadline);
    if(this.#stale(token,epoch))return this.#value('invalidated');const parsed=parseExportReport(raw.report,'prepare',{operation,destination_path_sha256,config_path_sha256});
    if(this.#stale(token,epoch)||this.now()>=deadline)return this.#value('invalidated');
    if(parsed.report.status!=='ok'){this.#editor=null;this.#drop(s);return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'unavailable',null,{report:parsed.report.status==='busy'?null:parsed.report});}
    const packet=Buffer.from(JSON.stringify({destination:s.destination,intent:parsed.intent}));
    try{this.#envelope('apply',packet,s.sample,12000);this.#envelope('status',packet,s.sample,12000);}catch{packet.fill(0);throw Error('Private packet refused');}
    if(this.#stale(token,epoch)||this.now()>=deadline){packet.fill(0);return this.#value('invalidated');}
    s.packet=Object.freeze({original:Buffer.from(raw.raw),input:packet,originalSha:hash(raw.raw),inputSha:hash(packet),intent:structuredClone(parsed.intent)});s.summary=parsed.summary;s.state='ready';s.deadline=this.now()+120000;
    s.readyTimer=setTimeout(()=>{if(this.#editor===s)this.invalidate();},120000);s.readyTimer.unref?.();return this.#value('ready',s,{summary:s.summary,report:parsed.report,observed:true});
   }catch(e){if(this.#editor===s)this.#editor=null;this.#drop(s);return this.#value(e.unsupported?'unsupported':'unavailable');}finally{input?.fill(0);raw?.raw.fill(0);if(s.state!=='ready'){if(this.#editor===s)this.#editor=null;this.#drop(s);}}
  });
 }
 async #confirm(q){
  const s=this.#editor;if(!s||s.state!=='ready'||s.reference!==q.reference||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'confirm',async(token,epoch,deadline)=>{
   let raw=null;
   try{const packet=this.#packet(s);if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){if(this.#editor===s)this.#editor=null;this.#drop(s);return this.#value('not-dispatched',s);}
    clearTimeout(s.readyTimer);s.readyTimer=null;s.possible=true;s.state='unknown';s.report=null;this.#records.set(s.reference,s);
    raw=await this.#raw('apply',packet.input,s.sample,deadline);if(this.#stale(token,epoch)||this.now()>=deadline)return this.#uncertain(s);
    const parsed=parseExportReport(raw.report,'apply',{intent:packet.intent,summary:s.summary});if(this.#stale(token,epoch)||this.now()>=deadline)return this.#uncertain(s);
    if(this.#editor===s)this.#editor=null;
    if(parsed.report.status==='ok'){this.#records.delete(s.reference);s.possible=false;s.state='verified';this.#drop(s);return this.#value('verified',s,{summary:parsed.summary,report:parsed.report,observed:true});}
    if(['not-dispatched','not-published'].includes(parsed.report.outcome)){this.#records.delete(s.reference);s.possible=false;this.#drop(s);return this.#value(parsed.report.outcome,s,{report:parsed.report});}
    s.report=parsed.report;return this.#value('unknown',s,{report:parsed.report});
   }catch{if(this.#editor===s)this.#editor=null;if(s.possible)return this.#uncertain(s);this.#drop(s);return this.#value('not-dispatched',s);}finally{raw?.raw.fill(0);}
  });
 }
 async #status(q){
  const s=this.#records.get(q.reference);if(!s||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'status',async(token,epoch,deadline)=>{let raw=null;
   try{const packet=this.#packet(s);raw=await this.#raw('status',packet.input,s.sample,deadline);if(this.#stale(token,epoch))return this.#uncertain(s);const parsed=parseExportReport(raw.report,'status',{intent:packet.intent,summary:s.summary});if(this.#stale(token,epoch)||this.now()>=deadline)return this.#uncertain(s);
    if(parsed.report.status!=='ok')return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'unavailable',s,{report:parsed.report.status==='busy'?null:parsed.report});
    if(parsed.report.outcome==='desired-archive-observed'){this.#records.delete(s.reference);s.possible=false;s.state='desired-archive-observed';this.#drop(s);return this.#value('desired-archive-observed',s,{summary:parsed.summary,report:parsed.report,observed:true});}
    s.state='unresolved';s.report=parsed.report;return this.#value('unresolved',s,{report:parsed.report,observed:true});
   }catch{return this.#uncertain(s);}finally{raw?.raw.fill(0);}
  });
 }
}
