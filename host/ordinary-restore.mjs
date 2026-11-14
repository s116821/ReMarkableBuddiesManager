import {randomBytes,randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {MaintenanceIO} from './maintenance-io.mjs';
import {restoreFamily} from './restore-family.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseRestoreRequest,parseRestoreResult,parseNotebookRestoreResult,restorePath} from './ordinary-restore-protocol.mjs';
import {restoreHash,parseRestoreRaw,parseNotebookRestoreRaw,RestoreUnsupported} from './ordinary-restore-private.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const handoffReply=(status,preview=null,cleanupPending=false)=>({status,preview,cleanupPending});
const releaseDestination=async stage=>{
 if(!stage)return false;
 try{return await stage.release()!==true;}catch{return true;}
};
export class OrdinaryRestoreHost{
 #family;#parseRaw;#parseResult;#disposed=false;
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 #destinationCleanups=new Set();#cleanupPending=false;#disposal;
 constructor({family='legacy',observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Ordinary restore budget refused');this.#family=restoreFamily(family);this.#parseRaw=this.#family.version===2?parseNotebookRestoreRaw:parseRestoreRaw;this.#parseResult=this.#family.version===2?parseNotebookRestoreResult:parseRestoreResult;Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});}
 #wipe(s){if(!s)return;clearTimeout(s.timer);if(s.packet){s.packet.original.fill(0);s.packet.input.fill(0);s.packet=null;}s.source=null;s.operation=null;s.preview=null;}
 #retireDestination(s){
  if(!s.destination||s.destinationBusy)return s.destinationCleanup;
  const stage=s.destination;s.destination=null;
  const pending=releaseDestination(stage).then(uncertain=>{this.#cleanupPending ||= uncertain;return uncertain;});
  s.destinationCleanup=pending;this.#destinationCleanups.add(pending);
  void pending.then(()=>this.#destinationCleanups.delete(pending));
  return pending;
 }
 #checkDestination(a,signal=a.controller.signal){
  const {s}=a,{connection_id,boot_id}=s.sample;
  return s.destination.assertOwned({signal,timeoutMs:Math.max(1,Math.floor(a.deadline-this.now())),
   connection_id,boot_id,files:s.sourceInventory,markerSha256:s.markerSha256});
 }
 #drop(s){this.#wipe(s);if(this.#editor===s)this.#editor=null;this.#records.delete(s.reference);s.ledger.clear();return this.#retireDestination(s);}
 #arm(s,deadline){clearTimeout(s.timer);s.deadline=deadline;s.timer=setTimeout(()=>{if(s.deadline!==deadline)return;if(this.#editor===s&&s.state==='ready'){this.#drop(s);this.#epoch++;}else if(this.#records.get(s.reference)===s)this.#wipe(s);},Math.max(1,deadline-this.now()));s.timer.unref?.();}
 #expire(){if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline){this.#drop(this.#editor);this.#epoch++;}for(const s of this.#records.values())if(s.packet&&this.now()>=s.deadline)this.#wipe(s);}
 invalidate(){
  this.#epoch++;
  const a=this.#active;
  if(a){
   if(a.controller)a.controller.abort();
   else{
    this.io.release(a.token);
    for(const b of a.buffers)b.fill(0);
    a.buffers.length=0;
   }
   a.s.ledger.set(a.invocation,'completed');
   if(a.operation==='confirm'&&a.s.possible){a.s.state='unknown';a.s.applyOutcome='unknown';this.#records.set(a.s.reference,a.s);}
  }
  if(!a?.controller)this.#active=null;
  if(this.#editor){
   const s=this.#editor;this.#editor=null;
   if(!s.possible&&!a?.controller)this.#drop(s);
  }
 }
 dispose(){
  if(this.#disposed)return this.#disposal;
  this.#disposed=true;
  const active=this.#active,owned=active&&this.io.owns(active.token);
  this.invalidate();
  if(owned&&!active.controller)this.observer.cancel();
  if(!active?.controller)for(const s of [...this.#records.values()])this.#drop(s);
  this.#disposal=Promise.resolve(active?.joined?.promise).then(async()=>{
   for(const s of [...this.#records.values()])this.#drop(s);
   await Promise.all(this.#destinationCleanups);
   return this.#cleanupPending;
  });
  return this.#disposal;
 }
 #rows(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,state:s.state,apply_outcome:s.applyOutcome,status_available:!!s.packet&&s.ledger.size<32&&this.now()<s.deadline}));}
 #lookup(ref){return this.#editor?.reference===ref?this.#editor:this.#records.get(ref);}
 #value(state,s=null,{report=null,preview=null,inspection=null,reference=s?.reference??null,applyOutcome=s?.applyOutcome??null}={}){const v={contract_version:1,status:report?'observed':'unconfigured',observation:report?structuredClone(s.sample):null,ordinary_restore:{state,reference,preview:preview?structuredClone(preview):null,inspection:inspection?{...inspection}:null,report:report?{...report}:null,apply_outcome:applyOutcome,retained:this.#rows()}};this.#issued.set(v,{epoch:this.#epoch,s,deadline:report?this.#active?.deadline:null});return v;}
 assertCurrent(v){if(this.#disposed)throw Error('Restore host disposed');this.#expire();const m=this.#issued.get(v),c=v.ordinary_restore;if(!m||m.epoch!==this.#epoch||m.deadline!==null&&m.deadline!==undefined&&this.now()>=m.deadline)throw Error('Ordinary restore invalidated');if(c.state==='ready'&&(this.#editor!==m.s||m.s.state!=='ready'||!m.s.packet))throw Error('Ordinary restore preview invalidated');return v;}
 #fallback(q,state='unavailable'){const s=q.action==='prepare'?null:this.#records.get(q.reference);if(state==='not-dispatched'&&s)state='unavailable';return this.#value(state,s,{reference:q.action==='prepare'?null:q.reference});}
 #current(a){return this.#active===a&&a.epoch===this.#epoch&&this.io.owns(a.token)&&!a.controller?.signal.aborted&&
  !a.sourceSignal?.aborted&&this.now()<a.deadline&&same(a.s.sample,this.observer.lastObservation);}
 #admission(s,invocation){return s.ledger.has(invocation)?'unavailable':s.ledger.size>=32?'capacity':null;}
 async #owned(s,q,handler,joined=false){const started=this.now(),token=this.io.acquire(this.#family.lane,s.reference??'prepare',q.action);if(!token)return this.#fallback(q,'busy');let a,timer;
  try{const refused=this.#admission(s,q.invocation);if(refused)return this.#fallback(q,refused);
   if(q.action==='prepare'){this.invalidate();s.reference=this.reference();s.operation=this.uuid();if(this.#lookup(s.reference))throw Error('Ordinary restore reference refused');}
   else if(q.action==='status')this.invalidate();
   this.beforeIO();s.ledger.set(q.invocation,'active');const deadline=Math.min(started+this.budgetMs,q.action==='prepare'?Infinity:s.deadline);a={s,token,invocation:q.invocation,operation:q.action,epoch:this.#epoch,deadline,buffers:[]};this.#active=a;if(q.action==='prepare')this.#editor=s;
   if(joined){
    a.controller=new AbortController();a.joined=Promise.withResolvers();
    const abort=()=>a.controller.abort();
    timer=setTimeout(abort,Math.max(1,deadline-this.now()));
    a.shorten=next=>{
     if(next<a.deadline){
      a.deadline=next;
      clearTimeout(timer);
      timer=setTimeout(abort,Math.max(1,a.deadline-this.now()));
     }
    };
    return await handler(a);
   }
   return await Promise.race([handler(a),new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.#active===a&&this.io.owns(token)&&a.epoch===this.#epoch){this.invalidate();this.observer.cancel();}reject(Error('Ordinary restore expired'));},Math.max(1,deadline-this.now()));})]);
  }finally{clearTimeout(timer);if(a){for(const b of a.buffers)b.fill(0);a.buffers.length=0;if(s.ledger.get(q.invocation)==='active')s.ledger.set(q.invocation,'completed');if(this.#active===a)this.#active=null;}this.io.release(token);a?.joined?.resolve();}
 }
 #envelope(a,selector,input){if(input.length>16384)throw Error('Ordinary restore input refused');const budget_ms=Math.min(12000,Math.floor(a.deadline-this.now()));if(budget_ms<1)throw Error('Ordinary restore expired');const operation=this.#family.selectors[selector];if(!operation)throw Error('Restore selector refused');const q={selector:operation,input_base64:input.toString('base64'),budget_ms,connection_id:a.s.sample.connection_id,boot_id:a.s.sample.boot_id};if(Buffer.byteLength(JSON.stringify(q))>24576)throw Error('Ordinary restore envelope refused');return q;}
 async #raw(a,selector,input){if(!this.#current(a))throw Error('Ordinary restore invalidated');const q=this.#envelope(a,selector,input);
  const signal=a.sourceSignal?AbortSignal.any([a.controller.signal,a.sourceSignal]):a.controller?.signal;
  const cancel=()=>this.observer.cancel();
  signal?.addEventListener('abort',cancel,{once:true});
  let v;try{v=await this.observer.run('ordinary-restore',q);}finally{signal?.removeEventListener('abort',cancel);q.input_base64=null;}if(!this.#current(a))throw Error('Ordinary restore invalidated');
  if(keys(v)!=='contract_version,observation,ordinary_restore_raw,status'||Buffer.byteLength(JSON.stringify(v))>24576)throw Error('Ordinary restore transport refused');validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const r=v.ordinary_restore_raw;if(keys(r)!=='status,stdout_base64'||!['reported','unsupported','unavailable'].includes(r.status)||(r.status==='reported'?typeof r.stdout_base64!=='string':r.stdout_base64!==null))throw Error('Ordinary restore transport refused');if(v.status!=='observed'||!same(v.observation,a.s.sample))throw Error('Ordinary restore identity refused');if(r.status==='unsupported')throw new RestoreUnsupported();if(r.status!=='reported')throw Error('Ordinary restore unavailable');const raw=Buffer.from(r.stdout_base64,'base64');a.buffers.push(raw);if(raw.length>16384||raw.toString('base64')!==r.stdout_base64)throw Error('Ordinary restore report refused');return raw;
 }
 #packet(s){const p=s.packet;if(!p||this.now()>=s.deadline||restoreHash(p.original)!==p.originalSha||restoreHash(p.input)!==p.inputSha)throw Error('Original restore unavailable');const parsed=this.#parseRaw(p.original,'prepare',{operation:s.operation,source:s.source});if(JSON.stringify({source:s.source,intent:parsed.intent})!==p.input.toString('utf8')||JSON.stringify(parsed.preview)!==JSON.stringify(s.preview))throw Error('Original restore refused');return {...p,intent:parsed.intent};}
 async request(value){if(this.#disposed)throw Error('Restore host disposed');const q=parseRestoreRequest(value);value=null;this.#expire();try{let v;if(q.action==='retained')v=this.#value('none');else if(q.action==='cancel')v=await this.#cancel(q);else if(q.action==='prepare')v=await this.#prepare(q);else v=await this.#use(q);this.#parseResult(v,q,validateResult);return this.assertCurrent(v);}finally{if(q.action==='prepare')q.source=null;}}
 #cancel(q){const s=this.#lookup(q.reference);if(!s||!same(s.sample,q))return this.#fallback(q);const entry=s.ledger.get(q.invocation),a=this.#active;
  if(entry==='active'&&a?.s===s&&a.invocation===q.invocation&&a.epoch===this.#epoch&&this.io.owns(a.token)){
   const possible=s.possible;this.invalidate();if(!a.controller)this.observer.cancel();
   const result=possible?this.#value(s.state,s):this.#value('not-dispatched',null,{reference:q.reference});
   return a.joined?a.joined.promise.then(()=>result):result;
  }
  if(s===this.#editor&&s.state==='ready'&&q.invocation===s.stageInvocation&&entry==='completed'){const cleanup=this.#drop(s);this.#epoch++;const result=this.#value('invalidated',null,{reference:q.reference});return cleanup?cleanup.then(()=>result):result;}
  if(entry!==undefined||s.ledger.size>=32)return this.#fallback(q);s.ledger.set(q.invocation,'fenced');return this.#records.has(s.reference)?this.#value(s.state,s):this.#value('not-dispatched',s);
 }
 #prepareState(q,sample){
  return {reference:null,sample:structuredClone(sample),source:q.source,operation:null,stageInvocation:q.invocation,
   state:'preparing',possible:false,applyOutcome:null,packet:null,preview:null,deadline:0,ledger:new Map()};
 }
 async #readPrepare(a,expectedArchive){
  const s=a.s,input=Buffer.from(JSON.stringify({restore_version:this.#family.version,operation:s.operation,source:s.source}));
  a.buffers.push(input);
  const raw=await this.#raw(a,'prepare',input),p=this.#parseRaw(raw,'prepare',{operation:s.operation,source:s.source});
  if(!this.#current(a))throw Error('Ordinary restore invalidated');
  if(p.intent){
   if(expectedArchive&&(p.intent.archive_sha256!==expectedArchive.sha256||
     p.preview.source.complete_media!==expectedArchive.completeMedia||p.preview.source.configuration_included)){
    throw Error('Original restore archive refused');
   }
   const packet=Buffer.from(JSON.stringify({source:s.source,intent:p.intent}));
   try{this.#envelope(a,'apply',packet);this.#envelope(a,'status',packet);}catch(e){packet.fill(0);throw e;}
   s.packet=Object.freeze({input:packet,original:Buffer.from(raw),inputSha:restoreHash(packet),originalSha:restoreHash(raw)});
   s.preview=p.preview;
  }
  return p.report;
 }
 #ready(s,report){
  s.state='ready';this.#arm(s,this.now()+120000);
  return this.#value('ready',s,{report,preview:s.preview});
 }
 async #prepare(q){const sample=this.observer.lastObservation;if(!same(sample,q))return this.#fallback(q);if(this.#records.size>=8)return this.#fallback(q,'capacity');const s=this.#prepareState(q,sample);
  try{return await this.#owned(s,q,async a=>{try{
    const report=await this.#readPrepare(a);
    if(s.packet)return this.#ready(s,report);
    this.#drop(s);return this.#value(['unsupported','busy'].includes(report.status)?report.status:'unavailable',s,{report,reference:null});
   }catch(e){if(this.#editor===s)this.#drop(s);return this.#fallback(q,this.#current(a)?e instanceof RestoreUnsupported?'unsupported':'unavailable':'invalidated');}});}catch{this.#wipe(s);return this.#fallback(q,'invalidated');}
 }
 // Host-only. A trusted stager joins all remote work and transfers an exact
 // destination handle with assertOwned and checked, one-shot release methods.
 async prepareHandoff(target,handoff,stageDestination){
  const sample=this.observer.lastObservation;
  if(this.#disposed||!same(sample,target))return handoffReply('invalidated');
  if(this.#family.version!==1||typeof stageDestination!=='function')return handoffReply('unavailable');
  if(this.#records.size>=8)return handoffReply('capacity');
  const q={action:'prepare',connection_id:sample.connection_id,boot_id:sample.boot_id,invocation:randomUUID()};
  const s=this.#prepareState(q,sample);
  try{
   const result=await this.#owned(s,q,async a=>{
    let report,received,cleanupPending=false;
    try{
     received=await handoff(async source=>{
      a.sourceSignal=source.signal;
      a.shorten(this.now()+source.timeoutMs);
      const signal=AbortSignal.any([source.signal,a.controller.signal]);
      const bounds=()=>({signal,timeoutMs:Math.max(1,Math.floor(a.deadline-this.now())),
       connection_id:sample.connection_id,boot_id:sample.boot_id});
      if(!this.#current(a))throw Error('Ordinary restore invalidated');
      try{s.destination=await stageDestination({...source,...bounds()});}
      catch(error){cleanupPending ||= error?.cleanupPending===true;throw error;}
      const root=s.destination?.root;
      if(!restorePath(root)||posix.normalize(root)!==root||typeof s.destination.assertOwned!=='function'||
          typeof s.destination.release!=='function')throw Error('Restore destination refused');
      s.source=posix.join(root,'data');
      if(!restorePath(s.source))throw Error('Restore destination refused');
      s.sourceInventory=source.files;
      s.markerSha256=source.inspection.markerSha256;
      if(!this.#current(a)||await this.#checkDestination(a,signal)!==true||!this.#current(a))throw Error('Restore destination refused');
      report=await this.#readPrepare(a,{sha256:source.components.data.sha256,completeMedia:source.inspection.completeMedia});
      if(!s.packet||await this.#checkDestination(a,signal)!==true||!this.#current(a))throw Error('Restore preview unavailable');
     });
     cleanupPending ||= received.cleanupPending===true;
     // The source handoff aborts its own signal during normal retirement.
     // Its returned status proves final source checks and joined release.
     a.sourceSignal=null;
     if(received.status==='handed-off'&&this.#current(a)&&s.packet){
      const preview=this.#ready(s,report);
      this.#parseResult(preview,q,validateResult);
      return handoffReply('ready',this.assertCurrent(preview),cleanupPending);
     }
    }catch(error){cleanupPending ||= error?.cleanupPending===true;}
    const current=this.#current(a);
    cleanupPending=(await this.#drop(s))===true||cleanupPending;
    return handoffReply(!current||received?.status==='invalidated'?'invalidated':'unavailable',null,cleanupPending);
   },true);
   return result.ordinary_restore?handoffReply(result.ordinary_restore.state):result;
  }catch{
   this.#drop(s);
   return handoffReply('invalidated',null,await s.destinationCleanup??false);
  }
 }
 async #use(q){const s=q.action==='confirm'?this.#editor:this.#records.get(q.reference);if(!s||s.reference!==q.reference||q.action==='confirm'&&s.state!=='ready'||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation)||!s.packet)return this.#fallback(q,q.action==='confirm'?'not-dispatched':'unavailable');const refused=this.#admission(s,q.invocation);if(refused)return this.#fallback(q,refused);
  const destination=q.action==='confirm'?s.destination:null;
  try{return await this.#owned(s,q,async a=>{try{const p=this.#packet(s);if(!this.#current(a))throw Error('Ordinary restore invalidated');
    if(destination){
     s.destinationBusy=true;
     if(s.destination!==destination||await this.#checkDestination(a)!==true||!this.#current(a))throw Error('Restore destination refused');
    }
    if(q.action==='confirm'){s.possible=true;s.state='unknown';s.applyOutcome='unknown';this.#editor=null;this.#records.set(s.reference,s);this.#arm(s,this.now()+1800000);}
    const selector=q.action==='confirm'?'apply':'status',raw=await this.#raw(a,selector,p.input),r=this.#parseRaw(raw,selector,{operation:s.operation,source:s.source,intent:p.intent,preview:s.preview});if(!this.#current(a))throw Error('Ordinary restore invalidated');
    if(r.report.status==='ok'&&r.inspection){if(q.action==='confirm')s.applyOutcome='restored';this.#drop(s);return this.#value(r.report.outcome,s,{report:r.report,inspection:r.inspection});}
    if(q.action==='confirm'){
     if(r.report.outcome==='not-dispatched'){s.applyOutcome='not-dispatched';this.#drop(s);return this.#value('not-dispatched',s,{report:r.report});}
     s.state=r.report.outcome;s.applyOutcome=r.report.outcome;return this.#value(s.state,s,{report:r.report});
    }
    if(r.report.status==='ok'){s.state='unresolved';return this.#value('unresolved',s,{report:r.report});}
    return this.#value(['unsupported','busy'].includes(r.report.status)?r.report.status:'unavailable',s,{report:r.report});
   }catch(e){if(q.action==='confirm'&&s.possible)return this.#value('unknown',s);if(q.action==='confirm'){if(this.#editor===s||destination)this.#drop(s);return this.#fallback(q,'not-dispatched');}return this.#fallback(q,e instanceof RestoreUnsupported?'unsupported':'unavailable');}
   finally{if(destination){s.destinationBusy=false;await this.#retireDestination(s);}}
  },!!destination);}catch{if(q.action==='confirm'&&s.possible)return this.#value('unknown',s);return this.#fallback(q,q.action==='confirm'?'not-dispatched':'unavailable');}
 }
}
