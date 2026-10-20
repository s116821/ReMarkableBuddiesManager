import { memoryRecordId, parseMemoryFact, parseMemoryInspectionRequest, parseMemoryInspectionReport } from './memory-inspection.mjs';
const keys = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join() : '';
export const uuid = v => typeof v === 'string' && v.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
export const digest = v => typeof v === 'string' && v.length === 64 && !/[^a-f0-9]/.test(v);
const bytes = v => new TextEncoder().encode(v).length;
const refuse = () => { throw Error('Memory forget response refused'); };
const canonicalKey = k => { parseMemoryInspectionRequest({ connection_id: 'a'.repeat(64), boot_id: '11111111-1111-4111-8111-111111111111', key: k }); return { profile: k.profile, scope: { kind: 'global' }, fact: k.fact }; };
const sameKey = (a,b) => JSON.stringify(canonicalKey(a)) === JSON.stringify(canonicalKey(b));
export function parseForgetRequest(v) {
  if (!v || bytes(JSON.stringify(v)) > 2048) refuse();
  if (v.action === 'status') { if (keys(v) !== 'action') refuse(); }
  else if (v.action === 'prepare') {
    if (keys(v) !== 'action,boot_id,connection_id,key') refuse();
    parseMemoryInspectionRequest({ connection_id: v.connection_id, boot_id: v.boot_id, key: v.key });
  } else if (['confirm','receipt','cancel'].includes(v.action)) { if (keys(v) !== 'action,reference' || !digest(v.reference)) refuse(); }
  else refuse();
  return v;
}
export const sortValue = v => Array.isArray(v) ? v.map(sortValue) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortValue(v[k])])) : v;
export function canonicalEnvelope(e) {
  return JSON.stringify(Object.fromEntries('envelope_version namespace domain_schema_version record_id revision_id parents operation_id actor_id kind payload media_descriptors'.split(' ').map(k => [k, k === 'parents' ? [...e.parents].sort() : k === 'payload' ? sortValue(e.payload) : e[k]])));
}
export async function sha256(value) { return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2,'0')).join(''); }
function binding(b, key) {
  if (keys(b) !== 'actor,config_sha256,domain,mode,store_generation' || !digest(b.config_sha256) || !uuid(b.actor) || !uuid(b.store_generation) || keys(b.mode) !== 'actor,sha256' || !uuid(b.mode.actor) || !digest(b.mode.sha256)) refuse();
  const d = b.domain;
  if (d?.kind === 'local') { if (keys(d) !== 'kind') refuse(); return; }
  if (keys(d) !== 'identity,kind,pins' || d.kind !== 'selected' || keys(d.identity) !== 'binding_sha256,group,profile' || !uuid(d.identity.group) || d.identity.profile !== key.profile || !digest(d.identity.binding_sha256) || !Array.isArray(d.pins) || d.pins.length < 1 || d.pins.length > 65) refuse();
  let prior = '';
  for (const p of d.pins) {
    if (keys(p) !== 'accepted_base_sha256,aggregate_generation,head_sha256,scope,selection_sha256,store_generation' || !uuid(p.store_generation) || !uuid(p.aggregate_generation) || ![p.accepted_base_sha256,p.head_sha256,p.selection_sha256].every(digest) || keys(p.scope) !== 'binding_sha256,group,key_sha256' || p.scope.group !== d.identity.group || p.scope.binding_sha256 !== d.identity.binding_sha256 || !digest(p.scope.key_sha256) || p.scope.key_sha256 <= prior) refuse();
    prior = p.scope.key_sha256;
  }
}
export async function parseForgetReport(r, selector, context) {
  if (keys(r) !== 'data,incomplete,operation,report_version,status' || r.report_version !== 1 || r.operation !== selector || typeof r.incomplete !== 'boolean' || bytes(JSON.stringify(r))+1 > 262144) refuse();
  const d = r.data;
  if (selector === 'prepare-forget') {
    if (r.status !== 'ok') {
      if (d !== null || ![['invalid-input',false],['unavailable',false],['busy',false],['unsupported',false],['unavailable',true]].some(([s,i]) => s===r.status && i===r.incomplete)) refuse();
      return { report: { selector, status:r.status, incomplete:r.incomplete, outcome:null }, preview:null, intent:null };
    }
    if (r.incomplete || keys(d) !== 'intent,preview,schema_version' || d.schema_version !== 1) refuse();
    const i = d.intent;
    if (keys(i) !== 'binding,expected,key,operation,prepared_version' || i.prepared_version !== 1 || i.operation !== context.operation || !uuid(i.operation) || !sameKey(i.key,context.key) || !Array.isArray(i.expected) || i.expected.length !== 1 || keys(i.expected[0]) !== 'revision,sha256' || !uuid(i.expected[0].revision) || !digest(i.expected[0].sha256)) refuse();
    binding(i.binding,i.key);
    const observed = await parseMemoryInspectionReport({ report_version:1,operation:'inspect',status:'ok',incomplete:false,data:[d.preview] }, { connection_id:context.connection_id,boot_id:context.boot_id,key:context.key });
    if (d.preview.kind !== 'value' || i.expected[0].revision !== d.preview.revision_id || !Object.hasOwn(d.preview.payload,'expires_ms') || JSON.stringify(sortValue(parseMemoryFact(d.preview.payload,i.key))) !== JSON.stringify(sortValue(d.preview.payload)) || await sha256(canonicalEnvelope(d.preview)) !== i.expected[0].sha256) refuse();
    const h = observed.heads[0];
    return { report:{selector,status:'ok',incomplete:false,outcome:null}, intent:i, preview:{key:canonicalKey(i.key),head:{record:h.record,revision:h.revision,fact:h.fact},scope:{kind:i.binding.domain.kind,group:i.binding.domain.kind==='selected'?i.binding.domain.identity.group:null}} };
  }
  if (!['forget','forget-receipt'].includes(selector)) refuse();
  if (r.status === 'ok') {
    if (r.incomplete || keys(d) !== 'operation,outcome,schema_version,transaction' || d.schema_version !== 1 || d.outcome !== 'acknowledged' || d.operation !== context.operation || !uuid(d.operation) || !uuid(d.transaction)) refuse();
    return { report:{selector,status:'ok',incomplete:false,outcome:d.outcome}, acknowledgement:{operation:d.operation,transaction:d.transaction} };
  }
  if (selector === 'forget-receipt' && r.status === 'invalid-input' && !r.incomplete && d === null) return { report:{selector,status:r.status,incomplete:false,outcome:null} };
  if (keys(d) !== 'outcome,schema_version' || d.schema_version !== 1) refuse();
  const row = [r.status,r.incomplete,d.outcome].join('|');
  const allowed = selector === 'forget' ? ['invalid-input|false|not-dispatched','unavailable|false|not-dispatched','busy|false|not-dispatched','unsupported|false|not-dispatched','conflict|false|not-dispatched','unavailable|true|not-dispatched','unavailable|true|unknown'] : ['unavailable|false|unresolved','busy|false|unresolved','unsupported|false|unresolved','unavailable|true|unresolved'];
  if (!allowed.includes(row)) refuse();
  return { report:{selector,status:r.status,incomplete:r.incomplete,outcome:d.outcome} };
}
export async function parseForgetResult(v, validate) {
  if (keys(v) !== 'contract_version,forget,observation,status' || bytes(JSON.stringify(v)) > 65536) refuse();
  validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
  const q=v.forget;
  if (keys(q) !== 'acknowledgement,preview,reference,report,state' || !['none','preparing','prepared','confirming','checking-receipt','invalidated','busy','unsupported','unavailable','not-dispatched','unknown','unresolved','acknowledged'].includes(q.state) || !(q.reference===null||digest(q.reference))) refuse();
  if (q.state==='prepared') {
    const p=q.preview;
    if (!digest(q.reference) || v.status!=='observed' || keys(p)!=='head,key,scope' || keys(p.head)!=='fact,record,revision' || !uuid(p.head.revision) || p.head.record!==await memoryRecordId(p.key) || !sameKey(p.head.fact.key,p.key) || keys(p.scope)!=='group,kind' || !['local','selected'].includes(p.scope.kind) || (p.scope.kind==='local'?p.scope.group!==null:!uuid(p.scope.group))) refuse();
    if (!Object.hasOwn(p.head.fact,'expires_ms')) refuse();
    parseMemoryFact(p.head.fact,p.key);
  } else if (q.preview!==null) refuse();
  if (q.state==='acknowledged') { if (keys(q.acknowledgement)!=='operation,transaction' || !uuid(q.acknowledgement.operation) || !uuid(q.acknowledgement.transaction)) refuse(); }
  else if (q.acknowledgement!==null) refuse();
  if (q.report!==null) {
    const r=q.report;
    if (keys(r)!=='incomplete,outcome,selector,status' || typeof r.incomplete!=='boolean') refuse();
    if (r.selector==='prepare-forget') {
      if (r.outcome!==null || !(r.status==='ok'&&!r.incomplete) && ![['invalid-input',false],['unavailable',false],['busy',false],['unsupported',false],['unavailable',true]].some(([s,i])=>r.status===s&&r.incomplete===i)) refuse();
    } else {
      const data=r.outcome===null?null:r.outcome==='acknowledged'?{schema_version:1,outcome:r.outcome,...q.acknowledgement}:{schema_version:1,outcome:r.outcome};
      await parseForgetReport({report_version:1,operation:r.selector,status:r.status,incomplete:r.incomplete,data},r.selector,{operation:q.acknowledgement?.operation});
    }
    if (q.state==='prepared'&&(r.selector!=='prepare-forget'||r.status!=='ok') || q.state==='acknowledged'&&r.outcome!=='acknowledged' || q.state==='not-dispatched'&&(r.selector!=='forget'||r.outcome!=='not-dispatched') || q.state==='unresolved'&&r.selector!=='forget-receipt') refuse();
  } else if (['prepared','acknowledged','not-dispatched'].includes(q.state)) refuse();
  return v;
}
