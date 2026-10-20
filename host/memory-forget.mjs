import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { parseForgetRequest, parseForgetReport, parseForgetResult } from './memory-forget-protocol.mjs';
import { validateResult } from './observation-protocol.mjs';
const terminal = new Set(['none','invalidated','unsupported','unavailable','busy','not-dispatched','acknowledged']);
const external = new Set(['observe','cancel','inspectOwned','inspectRuntime','personalization','memoryQuery','inspectMemory','inspectSavedMode','inspectSavedConfiguration']);
const sameTarget = (a,b) => a && b && a.connection_id===b.connection_id && a.boot_id===b.boot_id;
export class MemoryForgetHost {
  #slot=null;
  #epoch=0;
  constructor({observer, now=()=>performance.now(), uuid=randomUUID, reference=()=>randomBytes(32).toString('hex')}={}) {
    this.observer=observer; this.now=now; this.uuid=uuid; this.reference=reference;
  }
  wrap() {
    return new Proxy(this.observer,{get:(target,name)=>{
      const v=Reflect.get(target,name,target);
      if(typeof v!=='function') return v;
      return (...args)=>{ if(external.has(name)) this.invalidate(); return Reflect.apply(v,target,args); };
    }});
  }
  invalidate() {
    this.#epoch++;
    const s=this.#slot;
    if(!s) return;
    s.preview=null;
    if(s.claimed && !['acknowledged','not-dispatched'].includes(s.state)) { s.state='unknown'; s.report=null; }
    else if(['preparing','prepared'].includes(s.state)) { s.state='invalidated'; s.packet=null; s.report=null; }
  }
  #expire() { const s=this.#slot; if(s?.state==='prepared' && this.now()>=s.deadline) this.invalidate(); }
  #value(state, {reference=null,preview=null,acknowledgement=null,report=null,sample=null}={}) {
    return {contract_version:1,status:sample?'observed':'unconfigured',observation:sample?structuredClone(sample):null,forget:{state,reference,preview:preview?structuredClone(preview):null,acknowledgement:acknowledgement?{...acknowledgement}:null,report:report?{...report}:null}};
  }
  #snapshot() {
    this.#expire(); const s=this.#slot;
    if(!s) return this.#value('none');
    return this.#value(s.state,{reference:s.state==='preparing'?null:s.reference,preview:s.state==='prepared'?s.preview:null,acknowledgement:s.state==='acknowledged'?s.acknowledgement:null,report:s.report,sample:s.state==='prepared'?s.sample:null});
  }
  assertCurrent(value) {
    this.#expire();
    if (value.forget.state==='prepared') {
      const s=this.#slot;
      if (!s || s.state!=='prepared' || s.epoch!==this.#epoch || value.forget.reference!==s.reference || JSON.stringify(value.forget.preview)!==JSON.stringify(s.preview)) throw Error('Prepared response invalidated');
    }
    return value;
  }
  async #checked(value) {
    const slot=this.#slot, epoch=this.#epoch;
    await parseForgetResult(value,validateResult);
    // Public validation may itself await crypto; do not release a stale preview.
    if (slot?.state==='prepared' && this.now()>=slot.deadline) this.invalidate();
    return this.#slot===slot && this.#epoch===epoch ? value : this.#value(slot?.claimed?'unknown':'invalidated');
  }
  #stale(s,epoch) { return this.#slot!==s || this.#epoch!==epoch; }
  async #raw(selector,input,sample) {
    if(input.length>131072) throw Error('Private input refused');
    const v=await this.observer.run('memory-forget',{selector,input_base64:input.toString('base64'),connection_id:sample.connection_id,boot_id:sample.boot_id});
    validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});
    if(Object.keys(v).sort().join()!=='contract_version,forget_raw,observation,status' || v.status!=='observed' || !sameTarget(v.observation,sample)) throw Error('Private transport refused');
    const q=v.forget_raw;
    if(!q || Object.keys(q).sort().join()!=='status,stdout_base64' || q.status!=='reported' || typeof q.stdout_base64!=='string') { const error=Error('Private transport refused'); error.unsupported=q?.status==='unsupported'; throw error; }
    const raw=Buffer.from(q.stdout_base64,'base64');
    if(raw.length>262144 || raw.toString('base64')!==q.stdout_base64) throw Error('Private transport refused');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
    if(!text.endsWith('\n') || text.split('\n').length!==2) throw Error('Private transport refused');
    return {raw,report:JSON.parse(text),sample:v.observation};
  }
  async request(value) {
    const q=parseForgetRequest(value); this.#expire();
    if(q.action==='status') return this.#checked(this.#snapshot());
    if(q.action==='prepare') return this.#prepare(q);
    const s=this.#slot;
    if(!s || q.reference!==s.reference) return this.#checked(this.#value('unavailable'));
    if(q.action==='cancel') {
      this.invalidate(); this.observer.cancel(); return this.#checked(this.#snapshot());
    }
    if(q.action==='confirm') {
      if(s.state!=='prepared' || s.claimed || s.epoch!==this.#epoch || !s.packet || !sameTarget(this.observer.lastObservation,s.sample)) return this.#checked(this.#value('unavailable'));
      // No await can interleave this irreversible same-host claim.
      s.claimed=true; s.state='confirming'; s.preview=null; s.report=null;
      return this.#execute(s,'forget');
    }
    if(s.state==='acknowledged') return this.#checked(this.#snapshot());
    if(!s.claimed || !s.packet || !['unknown','unresolved'].includes(s.state) || !sameTarget(this.observer.lastObservation,s.sample)) return this.#checked(this.#value(s.claimed?'unresolved':'unavailable'));
    s.state='checking-receipt'; s.report=null;
    return this.#execute(s,'forget-receipt');
  }
  async #prepare(q) {
    if(this.#slot && !terminal.has(this.#slot.state)) return this.#checked(this.#value('busy'));
    const sample=this.observer.lastObservation;
    if(!sameTarget(sample,q)) return this.#checked(this.#value('unavailable'));
    const s={reference:this.reference(),operation:this.uuid(),key:structuredClone(q.key),sample:structuredClone(sample),epoch:this.#epoch,state:'preparing',claimed:false,packet:null,preview:null,report:null,acknowledgement:null};
    this.#slot=s; const epoch=this.#epoch;
    try {
      const input=Buffer.from(JSON.stringify({prepared_version:1,operation:s.operation,key:s.key}));
      const output=await this.#raw('prepare-forget',input,s.sample);
      const parsed=await parseForgetReport(output.report,'prepare-forget',{operation:s.operation,key:s.key,...s.sample});
      if(this.#stale(s,epoch)) return this.#checked(this.#value('invalidated'));
      if(!parsed.intent) { s.state=parsed.report.status==='invalid-input'?'unavailable':parsed.report.status; s.report=parsed.report; return this.#checked(this.#snapshot()); }
      const body=Buffer.from(JSON.stringify({intent:parsed.intent}));
      if(body.length>131072) throw Error('Private input refused');
      s.packet=Object.freeze({original:Buffer.from(output.raw),input:body,originalSha:createHash('sha256').update(output.raw).digest('hex'),inputSha:createHash('sha256').update(body).digest('hex'),previewSha:parsed.intent.expected[0].sha256});
      s.preview=parsed.preview; s.sample=structuredClone(output.sample); s.report=parsed.report; s.deadline=this.now()+120000; s.state='prepared';
      return this.#checked(this.#snapshot());
    } catch(error) {
      if(this.#stale(s,epoch)) return this.#checked(this.#value('invalidated'));
      s.state=error.unsupported?'unsupported':'unavailable'; s.packet=null; s.preview=null; s.report=null; return this.#checked(this.#snapshot());
    }
  }
  async #execute(s,selector) {
    const epoch=this.#epoch;
    try {
      if (createHash('sha256').update(s.packet.input).digest('hex')!==s.packet.inputSha || createHash('sha256').update(s.packet.original).digest('hex')!==s.packet.originalSha) throw Error('Original bytes refused');
      const output=await this.#raw(selector,s.packet.input,s.sample);
      const parsed=await parseForgetReport(output.report,selector,{operation:s.operation});
      if(this.#stale(s,epoch)) return this.#checked(this.#value('unknown'));
      s.report=parsed.report;
      if(parsed.acknowledgement) { s.state='acknowledged'; s.acknowledgement=parsed.acknowledgement; }
      else if(selector==='forget' && parsed.report.outcome==='not-dispatched') { s.state='not-dispatched'; s.packet=null; }
      else s.state=selector==='forget'?'unknown':'unresolved';
      return this.#checked(this.#snapshot());
    } catch {
      if(this.#stale(s,epoch)) return this.#checked(this.#value('unknown'));
      s.state=selector==='forget'?'unknown':'unresolved'; s.report=null; return this.#checked(this.#snapshot());
    }
  }
}
