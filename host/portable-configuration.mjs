import {randomBytes,randomUUID} from 'node:crypto';
import {parsePortableRequest,portableContext,parsePortableResult,portableArtifactBytes,portableBase64,portableCanonical,PORTABLE_FILE} from './portable-configuration-protocol.mjs';
import {parsePortableReport,portableHash} from './portable-configuration-private.mjs';
import {validateResult} from './observation-protocol.mjs';
import {MaintenanceIO} from './maintenance-io.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
export class PortableConfigurationHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){if(!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Operation budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});}
 #dropArtifact(s){s?.artifactBytes?.fill(0);if(s){s.artifactBytes=null;s.artifact=null;s.applyBytes?.fill(0);s.applyBytes=null;}}

 invalidate(){this.#epoch++;for(const s of this.#records.values())if(s.pendingTerminal){s.pendingTerminal=false;s.state='unknown';}const active=this.#active;if(active){this.io.release(active.token);if(active.context.possible){active.context.state='unknown';this.#records.set(active.context.reference,active.context);}}this.#active=null;const s=this.#editor;this.#editor=null;if(s){if(s.possible){s.state='unknown';this.#records.set(s.reference,s);}else s.state='invalidated';clearTimeout(s.timer);if(active?.context!==s)this.#dropArtifact(s);}}
 dispose(){this.invalidate();for(const s of this.#records.values()){this.#dropArtifact(s);s.original?.fill(0);}this.#records.clear();}
 #expire(){if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline)this.invalidate();}
 #retained(){return [...this.#records.values()].filter(s=>!s.pendingTerminal).map(s=>({reference:s.reference,...s.identity,state:s.state==='unresolved'?'unresolved':'unknown'}));}
 #value(state,s=null,{summary=null,report=null,observed=false,file=null,reference=['none','exported','no-change','invalidated','capacity'].includes(state)?null:s?.reference??null}={}){const v={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,portable_configuration:{state,reference,summary:summary?structuredClone(summary):null,report,retained:this.#retained(),export_file:file?{name:PORTABLE_FILE,bytes_base64:file.toString('base64')}:null}};this.#issued.set(v,{epoch:this.#epoch,s});return v;}
 // Reserve a verified original until the adapter's final publication guard.
 assertCurrent(v,final=true){this.#expire();const issued=this.#issued.get(v);if(v.status==='observed'&&issued?.epoch!==this.#epoch)throw Error('Preferences invalidated');if(v.portable_configuration.state==='ready'&&(!this.#editor||v.portable_configuration.reference!==this.#editor.reference||this.#editor.state!=='ready'))throw Error('Preferences invalidated');if(final&&issued?.s?.pendingTerminal){issued.s.pendingTerminal=false;issued.s.possible=false;this.#records.delete(issued.s.reference);}return v;}

 #stale(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 #unknown(s){s.pendingTerminal=false;s.state='unknown';return this.#value('unknown',s);}
 async #owned(s,operation,handler){
  const token=this.io.acquire('portable-configuration',s.reference,operation);if(!token){if(s.state==='reading')this.#dropArtifact(s);return this.#value('busy',s.possible||s.state==='ready'?s:null);}
  const deadline=this.now()+this.budgetMs;let active,timer;
  try{if(operation!=='confirm')this.invalidate();this.beforeIO();const epoch=this.#epoch;active={token,context:s,operation};this.#active=active;timer=setTimeout(()=>{if(this.io.owns(token)){this.invalidate();this.observer.cancel();}},Math.max(1,deadline-this.now()));return await handler(token,epoch,deadline);}
  finally{clearTimeout(timer);this.io.release(token);if(this.#active===active)this.#active=null;if(s.state!=='ready')this.#dropArtifact(s);}
 }
 async #raw(selector,input,sample,deadline){
  const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1||input&&input.length>262144)throw Error('Operation expired');
  let q={selector,input_base64:input===null?null:input.toString('base64'),budget_ms,connection_id:sample.connection_id,boot_id:sample.boot_id};if(Buffer.byteLength(JSON.stringify(q))>360448)throw Error('Private input refused');let v;
  try{v=await this.observer.run('portable-configuration',q);}finally{q.input_base64=null;q=null;}
  if(this.now()>=deadline||!v||Object.keys(v).sort().join()!=='contract_version,observation,portable_configuration_raw,status')throw Error('Private transport refused');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const p=v.portable_configuration_raw;
  if(!p||Object.keys(p).sort().join()!=='status,stdout_base64'||p.status!=='reported'||v.status!=='observed'||!same(v.observation,sample)){const e=Error('Private transport refused');e.unsupported=p?.status==='unsupported';throw e;}
  const raw=Buffer.from(portableBase64(p.stdout_base64,selector==='export'?131072:16384));return raw;
 }
 async request(value){let q=parsePortableRequest(value);value=null;const context=portableContext(q);this.#expire();let result;
  if(q.action==='retained')result=this.#value('none');else if(q.action==='cancel')result=this.#cancel(q);else if(q.action==='confirm')result=await this.#confirm(q);else if(q.action==='status')result=await this.#status(q);else{const pending=this.#read(q);q=null;result=await pending;}q=null;parsePortableResult(result,context,validateResult);return this.assertCurrent(result,false);
 }
 #cancel(q){const s=this.#editor?.reference===q.reference?this.#editor:this.#records.get(q.reference);if(!s)return this.#value('unavailable',null,{reference:q.reference});const token=this.io.ownerFor('portable-configuration',s.reference);if(token&&this.#active?.token===token&&this.#active.context===s){this.invalidate();this.observer.cancel();return s.possible?this.#unknown(s):this.#value('not-dispatched',s);}if(this.#editor===s){this.invalidate();return this.#value('invalidated');}return this.#unknown(s);}
 async #read(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable');const operation=q.action;
  const s={reference:this.reference(),sample:structuredClone(sample),identity:{connection_id:sample.connection_id,boot_id:sample.boot_id},state:'reading',possible:false,artifactBytes:null,artifact:null};
  if(this.#records.has(s.reference))return this.#value('unavailable');
  if(operation==='prepare'){s.artifactBytes=Buffer.from(portableBase64(q.artifact_base64));s.artifact=portableArtifactBytes(s.artifactBytes);}q=null;
  return this.#owned(s,operation,async(token,epoch,deadline)=>{let raw,input,parsed;try{
   raw=await this.#raw(operation==='export'?'export':'inspect',null,s.sample,deadline);if(this.#stale(token,epoch))return this.#value('invalidated');parsed=parsePortableReport(raw,operation==='export'?'export':'inspect');raw.fill(0);raw=null;
   if(parsed.report.status!=='ok')return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'unavailable',null,{report:parsed.report.status==='busy'?null:parsed.report});
   if(this.#stale(token,epoch)||this.now()>=deadline){parsed.file?.fill(0);return this.#value('invalidated');}
   if(operation==='export'){try{return this.#value('exported',s,{summary:parsed.summary,report:parsed.report,observed:true,file:parsed.file});}finally{parsed.file.fill(0);}}
   const context={...parsed,operation:this.uuid(),artifact:s.artifact,artifact_sha256:portableHash(portableCanonical(s.artifact))};
   input=Buffer.from(JSON.stringify({portable_import_version:1,operation:context.operation,base_sha256:context.base_sha256,config_path_sha256:context.config_path_sha256,artifact:s.artifact}));
   raw=await this.#raw('prepare',input,s.sample,deadline);if(this.#stale(token,epoch))return this.#value('invalidated');parsed=parsePortableReport(raw,'prepare',context);
   if(parsed.report.status!=='ok')return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'not-dispatched',null,{report:parsed.report.status==='busy'?null:parsed.report});
   if(!parsed.intent)return this.#value('no-change',s,{summary:parsed.summary,report:parsed.report,observed:true});
   if(this.#records.size>=8)return this.#value('capacity');
   s.intent=parsed.intent;s.summary=parsed.summary;s.original=Buffer.from(raw);s.originalHash=portableHash(s.original);s.applyBytes=Buffer.from(JSON.stringify({intent:s.intent,artifact:s.artifact}));s.applyHash=portableHash(s.applyBytes);
   if(s.applyBytes.length>262144||this.#stale(token,epoch)||this.now()>=deadline)return this.#value('invalidated');s.state='ready';s.deadline=this.now()+120000;this.#editor=s;s.timer=setTimeout(()=>{if(this.#editor===s)this.invalidate();},120000);s.timer.unref?.();return this.#value('ready',s,{summary:s.summary,report:parsed.report,observed:true});
  }catch(e){return this.#value(e.unsupported?'unsupported':'unavailable');}finally{raw?.fill(0);input?.fill(0);if(s.state!=='ready')this.#dropArtifact(s);}});
 }
 #original(s){if(!s.original||portableHash(s.original)!==s.originalHash)throw Error('Original refused');return s;}
 async #confirm(q){
  const s=this.#editor;if(!s||s.state!=='ready'||s.reference!==q.reference||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'confirm',async(token,epoch,deadline)=>{let raw;try{
   this.#original(s);if(!s.applyBytes||portableHash(s.applyBytes)!==s.applyHash)throw Error('Original refused');
   if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline){this.#editor=null;s.state='invalidated';return this.#value('not-dispatched',s);}
   clearTimeout(s.timer);s.possible=true;s.state='unknown';this.#records.set(s.reference,s);
   raw=await this.#raw('apply',s.applyBytes,s.sample,deadline);if(this.#stale(token,epoch))return this.#unknown(s);const parsed=parsePortableReport(raw,'apply',s);if(this.#stale(token,epoch)||this.now()>=deadline)return this.#unknown(s);
   if(parsed.report.status==='ok'){s.pendingTerminal=true;s.state='verified';return this.#value('verified',s,{summary:s.summary,report:parsed.report,observed:true});}
   if(parsed.report.outcome==='not-dispatched'){s.possible=false;s.state='not-dispatched';this.#records.delete(s.reference);return this.#value('not-dispatched',s,{report:parsed.report});}
   return this.#value('unknown',s,{report:parsed.report});
  }catch{return s.possible?this.#unknown(s):this.#value('not-dispatched',s);}finally{if(this.#editor===s)this.#editor=null;raw?.fill(0);}});
 }
 async #status(q){
  const s=this.#records.get(q.reference);if(!s||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  return this.#owned(s,'status',async(token,epoch,deadline)=>{let raw,input;try{
   this.#original(s);input=Buffer.from(JSON.stringify({intent:s.intent}));raw=await this.#raw('status',input,s.sample,deadline);if(this.#stale(token,epoch))return this.#unknown(s);const parsed=parsePortableReport(raw,'status',s);if(this.#stale(token,epoch)||this.now()>=deadline)return this.#unknown(s);
   if(parsed.report.status!=='ok')return this.#value(parsed.report.status==='unsupported'?'unsupported':parsed.report.status==='busy'?'busy':'unavailable',s,{report:parsed.report.status==='busy'?null:parsed.report});
   if(parsed.report.outcome==='desired-file-observed'){s.pendingTerminal=true;s.state='desired-file-observed';return this.#value(s.state,s,{summary:s.summary,report:parsed.report,observed:true});}
   s.state='unresolved';return this.#value('unresolved',s,{summary:s.summary,report:parsed.report,observed:true});
  }catch{return this.#unknown(s);}finally{raw?.fill(0);input?.fill(0);}});
 }
}
