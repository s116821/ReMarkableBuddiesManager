const keys = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join() : '';
const bytes = v => new TextEncoder().encode(v).length;
const text = (v, limit, blank = false) => typeof v === 'string' && v.isWellFormed() && !v.includes('\0') && bytes(v) <= limit && (blank || v.trim().length > 0);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const integer = v => Number.isSafeInteger(v) && v >= 0;
const refuse = () => { throw new Error('Memory query response refused'); };
export const validMemoryText = v => text(v, 2048);
export function parseMemoryRequest(v) {
  if (keys(v) !== 'boot_id,connection_id,text' || !uuid(v.boot_id) || typeof v.connection_id !== 'string' || !/^[a-f0-9]{64}$/.test(v.connection_id) || !validMemoryText(v.text)) throw new Error('Memory query input refused');
  return v;
}
function fact(v) {
  if (keys(v) !== 'fact,record,revision' || !uuid(v.record) || !uuid(v.revision)) refuse();
  const f = v.fact;
  if (keys(f) !== 'claim,confidence_basis_points,expires_ms,key,observed_ms,provenance,subject,tags,value' ||
      keys(f.key) !== 'fact,profile,scope' || !uuid(f.key.fact) || !uuid(f.key.profile) || keys(f.key.scope) !== 'kind' || f.key.scope.kind !== 'global' ||
      !text(f.claim, 128) || !text(f.subject, 128) || !text(f.value, 4096) || !Array.isArray(f.tags) || f.tags.length > 16 || !f.tags.every(v => text(v, 64)) ||
      !integer(f.confidence_basis_points) || f.confidence_basis_points > 10000 || !integer(f.observed_ms) || (f.expires_ms !== null && (!integer(f.expires_ms) || f.expires_ms <= f.observed_ms))) refuse();
  const p = f.provenance;
  if (keys(p) !== 'basis,conversation,description,source,turn' || !['user-confirmed', 'source-assertion', 'inferred'].includes(p.basis) || !text(p.description, 512) ||
      ![p.conversation, p.turn, p.source].every(v => v === null || uuid(v)) || (p.turn !== null && p.conversation === null)) refuse();
}
export function parseMemoryReport(v) {
  if (!v || v.report_version !== 1) throw new Error('Memory query report version unsupported');
  if (keys(v) !== 'data,incomplete,operation,report_version,status' || v.operation !== 'query' || typeof v.incomplete !== 'boolean' ||
      !['ok', 'partial', 'busy', 'unavailable', 'unsupported', 'conflict', 'invalid-input', 'failed'].includes(v.status) || bytes(JSON.stringify(v)) > 131072) refuse();
  if (v.data === null) { if (['ok', 'partial'].includes(v.status)) refuse(); return v; }
  if (v.status === 'conflict') {
    if (keys(v.data) !== 'current_heads' || !Array.isArray(v.data.current_heads) || v.data.current_heads.length > 4096 || !v.data.current_heads.every(uuid)) refuse();
    return v;
  }
  if (!['ok', 'partial', 'unavailable'].includes(v.status) || keys(v.data) !== 'context,diagnostics,query_status') refuse();
  const d = v.data, q = d.query_status, c = d.context, diagnostics = d.diagnostics;
  if (!['disabled', 'complete-empty', 'complete', 'partial', 'unavailable'].includes(q) ||
      v.status !== (q === 'partial' ? 'partial' : q === 'unavailable' ? 'unavailable' : 'ok') || v.incomplete !== ['partial', 'unavailable'].includes(q)) refuse();
  if (keys(diagnostics) !== 'budget_omitted,conflicted_keys,contradicted_claims,expired,snapshot_unavailable,suppressed,unsupported' ||
      typeof diagnostics.snapshot_unavailable !== 'boolean' || !Object.entries(diagnostics).every(([k, n]) => k === 'snapshot_unavailable' || integer(n))) refuse();
  if (['complete', 'complete-empty'].includes(q) && (diagnostics.snapshot_unavailable ||
      ['conflicted_keys', 'contradicted_claims', 'unsupported', 'budget_omitted'].some(k => diagnostics[k] > 0))) refuse();
  if (keys(c) !== 'facts,kind,provenance_authority' || c.kind !== 'associative-memory-data' || c.provenance_authority !== 'author-asserted-not-source-verified' ||
      !Array.isArray(c.facts) || c.facts.length > 8 || bytes(JSON.stringify(c)) > 8192 ||
      (['disabled', 'complete-empty', 'unavailable'].includes(q) && c.facts.length !== 0) || (q === 'complete' && c.facts.length === 0)) refuse();
  c.facts.forEach(fact);
  if (new Set(c.facts.map(f => f.record)).size !== c.facts.length || new Set(c.facts.map(f => f.fact.key.profile)).size > 1) refuse();
  return v;
}
export function parseMemoryResult(v, request, validateObservation) {
  parseMemoryRequest(request);
  if (keys(v) !== 'contract_version,memory_query,observation,status') refuse();
  validateObservation({ contract_version: v.contract_version, status: v.status, observation: v.observation });
  const q = v.memory_query;
  if (keys(q) !== 'report,status' || !['reported', 'unsupported', 'unavailable'].includes(q.status)) refuse();
  if (v.status === 'observed' && (v.observation.connection_id !== request.connection_id || v.observation.boot_id !== request.boot_id)) refuse();
  if (q.status === 'reported') { if (v.status !== 'observed') refuse(); parseMemoryReport(q.report); }
  else if (q.report !== null) refuse();
  return v;
}
