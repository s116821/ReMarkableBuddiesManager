import {randomBytes,randomUUID} from 'node:crypto';
import {parsePortableRequest,portableContext,parsePortableResult,portableArtifactBytes,portableBase64,portableCanonical,PORTABLE_FILE} from './portable-configuration-protocol.mjs';
import {parsePortableReport,portableHash} from './portable-configuration-private.mjs';
import {validateResult} from './observation-protocol.mjs';
import {MaintenanceIO} from './maintenance-io.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
const MAX_ARTIFACT = 128 * 1024;
const BACKUP_MEMBER = 'portable-configuration.json';
const handoffReply = (status, preview = null, cleanupPending = false) => ({status, preview, cleanupPending});
export class PortableConfigurationHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 #disposed = false;
 #disposal;
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){if(!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Operation budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});}
 #clearInput(s) {
  s.artifactBytes?.fill(0);
  s.artifactBytes = null;
  s.artifact = null;
 }

 #dropArtifact(s) {
  this.#clearInput(s);
  s.applyBytes?.fill(0);
  s.applyBytes = null;
 }

 invalidate() {
  this.#epoch++;
  for (const s of this.#records.values()) {
   if (s.pendingTerminal) { s.pendingTerminal = false; s.state = 'unknown'; }
  }
  const active = this.#active;
  if (active?.controller) active.controller.abort();
  else {
   if (active) {
    this.io.release(active.token);
    if (active.context.possible) {
     active.context.state = 'unknown';
     this.#records.set(active.context.reference, active.context);
    }
   }
   this.#active = null;
  }
  const s = this.#editor;
  this.#editor = null;
  if (s) {
   clearTimeout(s.timer);
   if (s.possible) {
    s.state = 'unknown';
    this.#records.set(s.reference, s);
   } else {
    s.state = 'invalidated';
    s.original?.fill(0);
   }
   if (active?.context !== s) this.#dropArtifact(s);
   if (s.handoff) this.#releaseHandoff(s);
  }
 }

 dispose() {
  if (this.#disposal) return this.#disposal;
  this.#disposed = true;
  const joined = this.#active?.joined;
  const done = Promise.withResolvers();
  this.#disposal = done.promise;
  this.invalidate();
  const finish = () => {
   for (const s of this.#records.values()) { this.#dropArtifact(s); s.original?.fill(0); }
   this.#records.clear();
   done.resolve();
  };
  if (joined) void joined.promise.then(finish);
  else finish();
  return this.#disposal;
 }
 #expire(){if(this.#editor?.state==='ready'&&this.now()>=this.#editor.deadline)this.invalidate();}
 #retained(){return [...this.#records.values()].filter(s=>!s.pendingTerminal).map(s=>({reference:s.reference,...s.identity,state:s.state==='unresolved'?'unresolved':'unknown'}));}
 #value(state,s=null,{summary=null,report=null,observed=false,file=null,reference=['none','exported','no-change','invalidated','capacity'].includes(state)?null:s?.reference??null}={}){const v={contract_version:1,status:observed?'observed':'unconfigured',observation:observed?structuredClone(s.sample):null,portable_configuration:{state,reference,summary:summary?structuredClone(summary):null,report,retained:this.#retained(),export_file:file?{name:PORTABLE_FILE,bytes_base64:file.toString('base64')}:null}};this.#issued.set(v,{epoch:this.#epoch,s});return v;}
 // Reserve a verified original until the adapter's final publication guard.
 assertCurrent(v,final=true){if(this.#disposed)throw Error('Preferences host disposed');this.#expire();const issued=this.#issued.get(v);if(v.status==='observed'&&issued?.epoch!==this.#epoch)throw Error('Preferences invalidated');if(v.portable_configuration.state==='ready'&&(!this.#editor||v.portable_configuration.reference!==this.#editor.reference||this.#editor.state!=='ready'))throw Error('Preferences invalidated');if(final&&issued?.s?.pendingTerminal){issued.s.pendingTerminal=false;issued.s.possible=false;this.#records.delete(issued.s.reference);}return v;}

 discardHandoffPreview(issued) {
  const record = this.#issued.get(issued);
  const s = record?.s;
  if (!s?.handoff || s.handoffIssued !== issued || record.epoch !== this.#epoch || this.#editor !== s ||
      s.state !== 'ready' || s.possible || this.#active?.context === s) return false;
  this.#editor = null;
  this.#dropHandoffEditor(s);
  return true;
 }

 #dropHandoffEditor(s) {
  clearTimeout(s.timer);
  s.state = 'invalidated';
  s.original?.fill(0);
  this.#dropArtifact(s);
  this.#releaseHandoff(s);
 }

 #releaseHandoff(s) {
  s.releaseAttempt?.();
  s.releaseAttempt = null;
  s.handoffCurrent = null;
  s.handoffIssued = null;
 }

 #stale(token,epoch){return epoch!==this.#epoch||!this.io.owns(token);}
 #unknown(s){s.pendingTerminal=false;s.state='unknown';return this.#value('unknown',s);}
 async #owned(s,operation,handler){
  const token=this.io.acquire('portable-configuration',s.reference,operation);if(!token){if(s.state==='reading')this.#dropArtifact(s);return this.#value('busy',s.possible||s.state==='ready'?s:null);}
  const deadline=this.now()+this.budgetMs;let active,timer;
  try{if(operation!=='confirm')this.invalidate();this.beforeIO();const epoch=this.#epoch;active={token,context:s,operation};this.#active=active;timer=setTimeout(()=>{if(this.io.owns(token)){this.invalidate();this.observer.cancel();}},Math.max(1,deadline-this.now()));return await handler(token,epoch,deadline);}
  finally{clearTimeout(timer);this.io.release(token);if(this.#active===active)this.#active=null;if(s.state!=='ready')this.#dropArtifact(s);}
 }
 async #raw(selector,input,sample,deadline,signal,token){
  const budget_ms=Math.min(12000,Math.floor(deadline-this.now()));if(budget_ms<1||input&&input.length>262144)throw Error('Operation expired');
  let q={selector,input_base64:input===null?null:input.toString('base64'),budget_ms,connection_id:sample.connection_id,boot_id:sample.boot_id};if(Buffer.byteLength(JSON.stringify(q))>360448)throw Error('Private input refused');let v;
  const cancel = () => { if (this.io.owns(token)) this.observer.cancel(); };
  try {
   signal?.throwIfAborted();
   signal?.addEventListener('abort', cancel, {once: true});
   v = await this.observer.run('portable-configuration', q);
   signal?.throwIfAborted();
  } finally {
   signal?.removeEventListener('abort', cancel);
   q.input_base64 = null;
   q = null;
  }
  if(this.now()>=deadline||!v||Object.keys(v).sort().join()!=='contract_version,observation,portable_configuration_raw,status')throw Error('Private transport refused');
  validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});const p=v.portable_configuration_raw;
  if(!p||Object.keys(p).sort().join()!=='status,stdout_base64'||p.status!=='reported'||v.status!=='observed'||!same(v.observation,sample)){const e=Error('Private transport refused');e.unsupported=p?.status==='unsupported';throw e;}
  const raw=Buffer.from(portableBase64(p.stdout_base64,selector==='export'?131072:16384));return raw;
 }
 async request(value){if(this.#disposed)throw Error('Preferences host disposed');let q=parsePortableRequest(value);value=null;const context=portableContext(q);this.#expire();let result;
  if(q.action==='retained')result=this.#value('none');else if(q.action==='cancel')result=await this.#cancel(q);else if(q.action==='confirm')result=await this.#confirm(q);else if(q.action==='status')result=await this.#status(q);else{const pending=this.#read(q);q=null;result=await pending;}q=null;parsePortableResult(result,context,validateResult);return this.assertCurrent(result,false);
 }
 #cancel(q){
  const active = this.#active;
  if (active?.controller && active.context.reference === q.reference && this.io.owns(active.token)) {
   this.invalidate();
   return active.joined.promise.then(() => this.#value('not-dispatched', active.context));
  }
  const s=this.#editor?.reference===q.reference?this.#editor:this.#records.get(q.reference);if(!s)return this.#value('unavailable',null,{reference:q.reference});const token=this.io.ownerFor('portable-configuration',s.reference);if(token&&this.#active?.token===token&&this.#active.context===s){this.invalidate();this.observer.cancel();return s.possible?this.#unknown(s):this.#value('not-dispatched',s);}if(this.#editor===s){this.invalidate();return this.#value('invalidated');}return this.#unknown(s);}
 async #read(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#value('unavailable');const operation=q.action;
  const s={reference:this.reference(),sample:structuredClone(sample),identity:{connection_id:sample.connection_id,boot_id:sample.boot_id},state:'reading',possible:false,artifactBytes:null,artifact:null};
  if(this.#records.has(s.reference))return this.#value('unavailable');
  if(operation==='prepare'){s.artifactBytes=Buffer.from(portableBase64(q.artifact_base64));s.artifact=portableArtifactBytes(s.artifactBytes);}q=null;
  return this.#owned(s, operation, async (token, epoch, deadline) => {
   const current = () => !this.#stale(token, epoch) && this.now() < deadline;
   const read = (selector, input) => this.#raw(selector, input, s.sample, deadline);
   if (operation === 'prepare') {
    const prepared = await this.#prepare(s, current, read);
    const successful = prepared.state === 'ready' || prepared.state === 'no-change';
    const candidate = successful && !current() ? {state: 'invalidated'} : prepared;
    if (candidate.state !== 'ready') s.original?.fill(0);
    return this.#adopt(s, candidate);
   }
   let raw, parsed;
   try {
    raw = await read('export', null);
    if (!current()) return this.#value('invalidated');
    parsed = parsePortableReport(raw, 'export');
    if (parsed.report.status !== 'ok') {
     const {state, report} = this.#refusal(parsed.report, 'unavailable');
     return this.#value(state, null, {report});
    }
    if (!current()) return this.#value('invalidated');
    return this.#value('exported', s, {summary: parsed.summary, report: parsed.report, observed: true, file: parsed.file});
   } catch (error) {
    return this.#value(error?.unsupported ? 'unsupported' : 'unavailable');
   } finally {
    raw?.fill(0);
    parsed?.file?.fill(0);
   }
  });
 }
 #refusal(report, fallback) {
  if (report.status === 'busy') return {state: 'busy'};
  const state = report.status === 'unsupported' ? 'unsupported' : fallback;
  return {state, report};
 }

 async #prepare(s, current, read) {
  let raw, input;
  const {artifact} = s;
  try {
   if (!current()) return {state: 'invalidated'};
   raw = await read('inspect', null);
   if (!current()) return {state: 'invalidated'};
   const inspected = parsePortableReport(raw, 'inspect');
   raw.fill(0);
   raw = null;
   if (inspected.report.status !== 'ok') return this.#refusal(inspected.report, 'unavailable');
   const context = {...inspected, operation: this.uuid(), artifact,
    artifact_sha256: portableHash(portableCanonical(artifact))};
   input = Buffer.from(JSON.stringify({portable_import_version: 1, operation: context.operation,
    base_sha256: context.base_sha256, config_path_sha256: context.config_path_sha256, artifact}));
   if (!current()) return {state: 'invalidated'};
   raw = await read('prepare', input);
   if (!current()) return {state: 'invalidated'};
   const parsed = parsePortableReport(raw, 'prepare', context);
   if (parsed.report.status !== 'ok') return this.#refusal(parsed.report, 'not-dispatched');
   if (!parsed.intent) return {state: 'no-change', summary: parsed.summary, report: parsed.report};
   if (this.#records.size >= 8) return {state: 'capacity'};
   s.intent = parsed.intent;
   s.summary = parsed.summary;
   s.original = Buffer.from(raw);
   s.originalHash = portableHash(s.original);
   s.applyBytes = Buffer.from(JSON.stringify({intent: s.intent, artifact}));
   s.applyHash = portableHash(s.applyBytes);
   if (s.applyBytes.length > 262144 || !current()) return {state: 'invalidated'};
   return {state: 'ready', summary: parsed.summary, report: parsed.report};
  } catch (error) {
   return {state: error?.unsupported ? 'unsupported' : 'unavailable'};
  } finally {
   raw?.fill(0);
   input?.fill(0);
   this.#clearInput(s);
  }
 }

 #adopt(s, {state, summary, report}) {
  if (state === 'ready') {
   s.state = 'ready';
   s.deadline = this.now() + 120000;
   this.#editor = s;
   s.timer = setTimeout(() => { if (this.#editor === s) this.invalidate(); }, 120000);
   s.timer.unref?.();
  }
  if (state === 'ready' || state === 'no-change') {
   return this.#value(state, s, {summary, report, observed: true});
  }
  return this.#value(state, null, {report});
 }

 async #readBackupArtifact(s, source, current) {
  const members = source.files.filter(file => file.name === BACKUP_MEMBER);
  const {bytes, sha256} = source.components.preferences;
  const [member] = members;
  if (members.length !== 1 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARTIFACT ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
      member.bytes !== bytes || member.sha256 !== sha256) {
   throw Error('Backup preference identity refused');
  }
  s.artifactBytes = Buffer.alloc(bytes);
  let offset = 0;
  await source.readFile(BACKUP_MEMBER, chunk => {
   if (!current() || !Buffer.isBuffer(chunk) || chunk.length > bytes - offset) {
    throw Error('Backup preference read refused');
   }
   chunk.copy(s.artifactBytes, offset);
   offset += chunk.length;
  });
  if (!current() || offset !== bytes || portableHash(s.artifactBytes) !== sha256) {
   throw Error('Backup preference readback differs');
  }
  s.artifact = portableArtifactBytes(s.artifactBytes);
 }

 // Trusted host entry. The handoff owns the exact verified selection and its
 // reader. This owner holds the maintenance token until actual drain.
 async prepareHandoff(target, handoff, {signal: attemptSignal, current: attemptCurrent, releaseAttempt} = {}) {
  this.#expire();
  const sample = this.observer.lastObservation;
  if (this.#disposed || attemptSignal?.aborted || !same(sample, target)) return handoffReply('invalidated');
  if (typeof handoff !== 'function') return handoffReply('unavailable');
  if (this.#records.size >= 8) return handoffReply('capacity');
  const s = {reference: this.reference(), sample: structuredClone(sample),
   identity: {connection_id: sample.connection_id, boot_id: sample.boot_id}, state: 'reading',
   possible: false, artifactBytes: null, artifact: null};
  if (this.#records.has(s.reference) || this.#editor?.reference === s.reference) {
   return handoffReply('unavailable');
  }
  const token = this.io.acquire('portable-configuration', s.reference, 'prepare', {joined: true});
  if (!token) return handoffReply('busy');
  let deadline = this.now() + this.budgetMs;
  let active, timer, adopted = false, cleanupPending = false;
  try {
   this.invalidate();
   active = {token, context: s, operation: 'prepare', epoch: this.#epoch,
    controller: new AbortController(), joined: Promise.withResolvers()};
   this.#active = active;
   active.abortAttempt = () => active.controller.abort();
   attemptSignal?.addEventListener('abort', active.abortAttempt, {once: true});
   if (attemptSignal?.aborted) active.abortAttempt();
   this.beforeIO();
   const {signal} = active.controller;
   const current = () => !this.#disposed && this.#active === active && !signal.aborted &&
    !this.#stale(token, active.epoch) && this.now() < deadline &&
    same(s.sample, this.observer.lastObservation) && (attemptCurrent?.() ?? true);
   const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => active.controller.abort(), Math.max(1, deadline - this.now()));
   };
   arm();
   if (!current()) return handoffReply('invalidated');
   let candidate;
   const received = await handoff(async source => {
    if (!Number.isSafeInteger(source.timeoutMs) || source.timeoutMs <= 1) {
     active.controller.abort();
     return;
    }
    deadline = Math.min(deadline, this.now() + source.timeoutMs - 1);
    arm();
    const combined = AbortSignal.any([signal, source.signal]);
    const sourceCurrent = () => current() && !combined.aborted;
    if (!sourceCurrent()) return;
    try {
     await this.#readBackupArtifact(s, source, sourceCurrent);
     if (!sourceCurrent()) return;
     const read = (selector, input) => this.#raw(selector, input, s.sample, deadline, combined, token);
     candidate = await this.#prepare(s, sourceCurrent, read);
    } catch (error) {
     cleanupPending ||= error?.cleanupPending === true;
     throw error;
    } finally {
     this.#clearInput(s);
    }
   }, signal);
   cleanupPending ||= received?.cleanupPending === true;
   // Retirement aborts the source signal even on success. The final handoff
   // disposition carries the source's terminal currentness result.
   if (!current() || received?.status === 'invalidated') {
    return handoffReply('invalidated', null, cleanupPending);
   }
   if (cleanupPending || received?.status !== 'handed-off' || !candidate) {
    return handoffReply('unavailable', null, cleanupPending);
   }
   const {state} = candidate;
   if (state !== 'ready' && state !== 'no-change') return handoffReply(state);
   s.handoff = true;
   s.handoffCurrent = attemptCurrent;
   s.releaseAttempt = releaseAttempt;
   const preview = this.#adopt(s, candidate);
   parsePortableResult(preview, {action: 'prepare', ...s.identity}, validateResult);
   this.assertCurrent(preview);
   adopted = state === 'ready';
   if (adopted) s.handoffIssued = preview;
   return handoffReply(state, preview);
  } catch {
   const invalidated = active?.controller.signal.aborted || this.#disposed;
   return handoffReply(invalidated ? 'invalidated' : 'unavailable', null, cleanupPending);
  } finally {
   clearTimeout(timer);
   if (active?.abortAttempt) attemptSignal?.removeEventListener('abort', active.abortAttempt);
   if (!adopted) {
    if (this.#editor === s) {
     clearTimeout(s.timer);
     this.#editor = null;
    }
    this.#dropArtifact(s);
    s.original?.fill(0);
   }
   if (active && this.#active === active) this.#active = null;
   this.io.release(token);
   active?.joined.resolve();
  }
 }

 #original(s){if(!s.original||portableHash(s.original)!==s.originalHash)throw Error('Original refused');return s;}
 async #confirm(q){
  const s=this.#editor;if(!s||s.state!=='ready'||s.reference!==q.reference||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#value('unavailable',null,{reference:q.reference});
  if (s.handoffCurrent && !s.handoffCurrent()) {
   if (this.#editor === s) this.discardHandoffPreview(s.handoffIssued);
   return this.#value('not-dispatched', s);
  }
  return this.#owned(s,'confirm',async(token,epoch,deadline)=>{let raw;try{
   this.#original(s);if(!s.applyBytes||portableHash(s.applyBytes)!==s.applyHash)throw Error('Original refused');
   if(this.#stale(token,epoch)||this.now()>=deadline||this.now()>=s.deadline||
       (s.handoffCurrent && !s.handoffCurrent())){
     if(this.#editor===s)this.#editor=null;
     if (s.handoff) this.#dropHandoffEditor(s);
     else s.state='invalidated';
     return this.#value('not-dispatched',s);
    }
   clearTimeout(s.timer);s.possible=true;s.state='unknown';this.#records.set(s.reference,s);
    if (s.handoff) this.#releaseHandoff(s);
   raw=await this.#raw('apply',s.applyBytes,s.sample,deadline);if(this.#stale(token,epoch))return this.#unknown(s);const parsed=parsePortableReport(raw,'apply',s);if(this.#stale(token,epoch)||this.now()>=deadline)return this.#unknown(s);
   if(parsed.report.status==='ok'){s.pendingTerminal=true;s.state='verified';return this.#value('verified',s,{summary:s.summary,report:parsed.report,observed:true});}
   if(parsed.report.outcome==='not-dispatched'){s.possible=false;s.state='not-dispatched';this.#records.delete(s.reference);return this.#value('not-dispatched',s,{report:parsed.report});}
   return this.#value('unknown',s,{report:parsed.report});
  }catch{return s.possible?this.#unknown(s):this.#value('not-dispatched',s);}finally{
    if(this.#editor===s)this.#editor=null;
    if (s.handoff && !s.possible && s.state === 'ready') this.#dropHandoffEditor(s);
    raw?.fill(0);
   }});
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
