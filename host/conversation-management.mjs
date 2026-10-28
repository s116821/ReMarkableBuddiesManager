import {randomBytes,randomUUID} from 'node:crypto';
import {MaintenanceIO} from './maintenance-io.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseManagementRequest,parseManagementResult} from './conversation-management-protocol.mjs';
import {managementHash,parseManagementRaw,ManagementUnsupported} from './conversation-management-private.mjs';
const same=(a,b)=>a&&b&&a.connection_id===b.connection_id&&a.boot_id===b.boot_id;
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
export class ConversationManagementHost {
 #editor=null;#records=new Map();#active=null;#epoch=0;#issued=new WeakMap();
 constructor({observer,io=new MaintenanceIO(),beforeIO=()=>{},now=()=>performance.now(),uuid=randomUUID,reference=()=>randomBytes(32).toString('hex'),budgetMs=13000}={}){
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>13000)throw Error('Conversation management budget refused');Object.assign(this,{observer,io,beforeIO,now,uuid,reference,budgetMs});
 }
 #wipe(s){if(!s)return;clearTimeout(s.timer);if(s.packet){s.packet.original.fill(0);s.packet.input.fill(0);s.packet=null;}}
 #drop(s){this.#wipe(s);if(this.#editor===s)this.#editor=null;this.#records.delete(s.reference);s.ledger.clear();}
 #arm(s,deadline){clearTimeout(s.timer);s.deadline=deadline;s.timer=setTimeout(()=>{if(s.deadline!==deadline)return;if(this.#editor===s&&['inspected','ready'].includes(s.state)){this.#drop(s);this.#epoch++;}else if(this.#records.get(s.reference)===s)this.#wipe(s);},Math.max(1,deadline-this.now()));s.timer.unref?.();}
 #expire(){if(['inspected','ready'].includes(this.#editor?.state)&&this.now()>=this.#editor.deadline){this.#drop(this.#editor);this.#epoch++;}for(const s of this.#records.values())if(s.packet&&this.now()>=s.deadline)this.#wipe(s);}
 invalidate(){
  this.#epoch++;const a=this.#active;if(a){this.io.release(a.token);a.s.ledger.set(a.invocation,'completed');if(a.operation==='confirm'&&a.s.possible){a.s.state='unknown';this.#records.set(a.s.reference,a.s);}for(const b of a.buffers)b.fill(0);a.buffers.length=0;}this.#active=null;
  if(this.#editor){const s=this.#editor;this.#editor=null;if(!s.possible)this.#drop(s);}
 }
 #rows(){return [...this.#records.values()].map(s=>({reference:s.reference,connection_id:s.sample.connection_id,boot_id:s.sample.boot_id,conversation:s.conversation,state:s.state,status_available:!!s.packet&&s.ledger.size<32&&this.now()<s.deadline}));}
 #value(state,s=null,{report=null,preview=null,reference=s?.reference??null}={}){
  const v={contract_version:1,status:report?'observed':'unconfigured',observation:report?structuredClone(s.sample):null,conversation_management:{state,reference,preview:preview?{...preview}:null,report:report?{...report}:null,retained:this.#rows()}};
  this.#issued.set(v,{epoch:this.#epoch,s,deadline:report?this.#active?.deadline:null});return v;
 }
 assertCurrent(v){this.#expire();const m=this.#issued.get(v),c=v.conversation_management;if(!m||m.epoch!==this.#epoch||m.deadline!==null&&m.deadline!==undefined&&this.now()>=m.deadline)throw Error('Conversation management invalidated');if(['inspected','ready'].includes(c.state)&&(this.#editor!==m.s||m.s.state!==c.state||c.state==='ready'&&!m.s.packet))throw Error('Conversation management preview invalidated');return v;}
 #lookup(ref){return this.#editor?.reference===ref?this.#editor:this.#records.get(ref);}
 #fallback(q,state='unavailable'){return this.#value(state,null,{reference:q.action==='inspect'?null:q.reference});}
 #current(a){return this.#active===a&&a.epoch===this.#epoch&&this.io.owns(a.token)&&this.now()<a.deadline&&same(a.s.sample,this.observer.lastObservation);}
 #preserved(s){return this.#value('unknown',s);}
 #admission(s,invocation){if(s.ledger.has(invocation))return 'unavailable';return s.ledger.size>=32?'capacity':null;}
 async #owned(s,q,handler){
  const started=this.now();const token=this.io.acquire('conversation-management',s.reference,q.action);if(!token)return this.#fallback(q,'busy');
  let a,timer;
  try{
   // No ledger, grant, timer or peer changes occur until the real owner is held.
   const refused=this.#admission(s,q.invocation);if(refused)return this.#fallback(q,q.action==='confirm'&&refused==='unavailable'?'not-dispatched':refused);
   if(['inspect','status'].includes(q.action))this.invalidate();
   this.beforeIO();s.ledger.set(q.invocation,'active');
   const deadline=Math.min(started+this.budgetMs,q.action==='inspect'?Infinity:s.deadline);
   a={s,token,invocation:q.invocation,operation:q.action,epoch:this.#epoch,deadline,buffers:[]};this.#active=a;
   if(q.action==='confirm'){s.state='confirming';}
   if(q.action==='inspect')this.#editor=s;
   return await Promise.race([handler(a),new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.#active===a&&this.io.owns(token)&&a.epoch===this.#epoch){this.invalidate();this.observer.cancel();}reject(Error('Conversation management expired'));},Math.max(1,deadline-this.now()));})]);
  }finally{
   clearTimeout(timer);if(a){for(const b of a.buffers)b.fill(0);a.buffers.length=0;if(s.ledger.get(q.invocation)==='active')s.ledger.set(q.invocation,'completed');if(this.#active===a)this.#active=null;}this.io.release(token);
  }
 }
 async #raw(a,selector,input){
  if(!this.#current(a)||input.length>16384)throw Error('Conversation management unavailable');const budget_ms=Math.min(12000,Math.floor(a.deadline-this.now()));if(budget_ms<1)throw Error('Conversation management expired');
  const q={selector,input_base64:input.toString('base64'),budget_ms,connection_id:a.s.sample.connection_id,boot_id:a.s.sample.boot_id};if(Buffer.byteLength(JSON.stringify(q))>24576)throw Error('Conversation management request refused');let v;
  try{v=await this.observer.run('conversation-management',q);}finally{q.input_base64=null;}
  if(!this.#current(a))throw Error('Conversation management invalidated');
  if(keys(v)!=='contract_version,conversation_management_raw,observation,status'||Buffer.byteLength(JSON.stringify(v))>49152)throw Error('Conversation management transport refused');validateResult({contract_version:v.contract_version,status:v.status,observation:v.observation});
  const r=v.conversation_management_raw;if(keys(r)!=='status,stdout_base64'||!['reported','unsupported','unavailable'].includes(r.status)||(r.status==='reported'?typeof r.stdout_base64!=='string':r.stdout_base64!==null))throw Error('Conversation management transport refused');
  if(v.status!=='observed'||!same(v.observation,a.s.sample))throw Error('Conversation management identity refused');if(r.status==='unsupported')throw new ManagementUnsupported();if(r.status!=='reported')throw Error('Conversation management unavailable');
  const raw=Buffer.from(r.stdout_base64,'base64');a.buffers.push(raw);if(raw.length>32768||raw.toString('base64')!==r.stdout_base64)throw Error('Conversation management report refused');return raw;
 }
 #packet(s){const p=s.packet;if(!p||this.now()>=s.deadline||managementHash(p.original)!==p.originalSha||managementHash(p.input)!==p.inputSha)throw Error('Original conversation management unavailable');const parsed=parseManagementRaw(p.original,'prepare',{operation:s.operation,conversation:s.conversation});if(JSON.stringify({intent:parsed.intent})!==p.input.toString('utf8'))throw Error('Original conversation management refused');return {...p,intent:parsed.intent};}
 async request(value){const q=parseManagementRequest(value);value=null;this.#expire();let v;
  if(q.action==='retained')v=this.#value('none');else if(q.action==='cancel')v=this.#cancel(q);else if(q.action==='inspect')v=await this.#inspect(q);else if(q.action==='prepare')v=await this.#prepare(q);else v=await this.#use(q);
  parseManagementResult(v,q,validateResult);return this.assertCurrent(v);
 }
 #cancel(q){
  const s=this.#lookup(q.reference);if(!s)return this.#fallback(q);const entry=s.ledger.get(q.invocation),a=this.#active;
  if(entry==='active'&&a?.s===s&&a.invocation===q.invocation&&a.epoch===this.#epoch&&this.io.owns(a.token)){
   const possible=s.possible,state=s.state;this.invalidate();this.observer.cancel();
   if(possible){s.state=['unchanged','unresolved'].includes(state)?state:'unknown';return this.#value(s.state,s);}return this.#value('not-dispatched',null,{reference:q.reference});
  }
  if(s===this.#editor&&['inspected','ready'].includes(s.state)&&q.invocation===s.stageInvocation&&entry==='completed'){this.#drop(s);this.#epoch++;return this.#value('invalidated',null,{reference:q.reference});}
  if(entry!==undefined)return this.#fallback(q);
  if(s.ledger.size>=32)return this.#fallback(q);s.ledger.set(q.invocation,'fenced');return this.#value('not-dispatched',s);
 }
 async #inspect(q){
  const sample=this.observer.lastObservation;if(!same(sample,q))return this.#fallback(q);
  if(this.#records.size>=8||[...this.#records.values()].some(s=>s.conversation===q.conversation))return this.#fallback(q,'capacity');
  const s={reference:this.reference(),sample:structuredClone(sample),conversation:q.conversation,operation:null,stageInvocation:q.invocation,state:'inspecting',possible:false,packet:null,deadline:0,ledger:new Map()};
  if(this.#lookup(s.reference))return this.#fallback(q);
  try{return await this.#owned(s,q,async a=>{
   try{
    const input=Buffer.from(JSON.stringify({request_version:1,conversation:s.conversation}));a.buffers.push(input);
    const raw=await this.#raw(a,'inspect',input),p=parseManagementRaw(raw,'inspect',{conversation:s.conversation});
    if(p.preview){s.state='inspected';this.#arm(s,this.now()+120000);return this.#value('inspected',s,{report:p.report,preview:p.preview});}
    this.#drop(s);return this.#value(['unsupported','busy'].includes(p.report.status)?p.report.status:'unavailable',s,{report:p.report,reference:null});
   }catch(e){if(this.#editor===s)this.#drop(s);return this.#fallback(q,this.#current(a)?e instanceof ManagementUnsupported?'unsupported':'unavailable':'invalidated');}
  });}catch{return this.#fallback(q,'invalidated');}
 }
 async #prepare(q){
  const s=this.#editor;if(!s||s.reference!==q.reference||s.state!=='inspected'||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation))return this.#fallback(q,'invalidated');
  if(this.#records.size>=8||[...this.#records.values()].some(r=>r.conversation===s.conversation))return this.#fallback(q,'capacity');
  try{return await this.#owned(s,q,async a=>{
   try{
    s.state='preparing';s.operation=this.uuid();s.stageInvocation=q.invocation;
    const input=Buffer.from(JSON.stringify({request_version:1,operation:s.operation,conversation:s.conversation}));a.buffers.push(input);
    const raw=await this.#raw(a,'prepare',input),p=parseManagementRaw(raw,'prepare',{operation:s.operation,conversation:s.conversation});
    if(p.intent){const input=Buffer.from(JSON.stringify({intent:p.intent})),original=Buffer.from(raw);s.packet=Object.freeze({input,original,inputSha:managementHash(input),originalSha:managementHash(original)});s.state='ready';this.#arm(s,this.now()+120000);return this.#value('ready',s,{report:p.report,preview:p.preview});}
    this.#drop(s);return this.#value(['unsupported','busy'].includes(p.report.status)?p.report.status:'unavailable',s,{report:p.report});
   }catch(e){if(this.#editor===s)this.#drop(s);return this.#fallback(q,this.#current(a)?e instanceof ManagementUnsupported?'unsupported':'unavailable':'invalidated');}
  });}catch{return this.#fallback(q,'invalidated');}
 }
 async #use(q){
  const s=q.action==='confirm'?this.#editor:this.#records.get(q.reference);
  if(!s||s.reference!==q.reference||q.action==='confirm'&&s.state!=='ready'||!same(s.sample,q)||!same(s.sample,this.observer.lastObservation)||!s.packet)return this.#fallback(q,q.action==='confirm'?'not-dispatched':'unavailable');
  const refused=this.#admission(s,q.invocation);if(refused)return this.#fallback(q,q.action==='confirm'&&refused==='unavailable'?'not-dispatched':refused);
  try{return await this.#owned(s,q,async a=>{
   try{
    const p=this.#packet(s);if(!this.#current(a))throw Error('Conversation management invalidated');
    if(q.action==='confirm'){
     // This is the sole point of possible mutation: retain the exact original first.
     s.possible=true;s.state='unknown';this.#editor=null;this.#records.set(s.reference,s);this.#arm(s,this.now()+1800000);
    }
    const raw=await this.#raw(a,q.action==='confirm'?'apply':'status',p.input),r=parseManagementRaw(raw,q.action==='confirm'?'apply':'status',{conversation:s.conversation,intent:p.intent});if(!this.#current(a))throw Error('Conversation management invalidated');
    if(r.report.status==='acknowledged'){this.#drop(s);return this.#value('acknowledged',s,{report:r.report});}
    if(r.report.possible_effect){s.state=r.report.status==='unresolved'?'unresolved':'unknown';return this.#value(s.state,s,{report:r.report});}
    if(q.action==='confirm'){this.#drop(s);return this.#value('not-dispatched',s,{report:r.report});}
    if(['unchanged','unresolved'].includes(r.report.status)){s.state=r.report.status;return this.#value(s.state,s,{report:r.report});}
    return this.#value(['unsupported','busy'].includes(r.report.status)?r.report.status:'unavailable',s,{report:r.report});
   }catch(e){if(q.action==='confirm'&&s.possible)return this.#preserved(s);if(q.action==='confirm'){if(this.#editor===s)this.#drop(s);return this.#fallback(q,'not-dispatched');}return this.#fallback(q,e instanceof ManagementUnsupported?'unsupported':'unavailable');}
  });}catch{if(q.action==='confirm'&&s.possible)return this.#preserved(s);return this.#fallback(q,q.action==='confirm'?'not-dispatched':'unavailable');}
 }
}
