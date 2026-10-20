const keys = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join() : '';
const bytes = v => new TextEncoder().encode(v).length;
const uuid = v => typeof v === 'string' && v.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const text = (v, max) => typeof v === 'string' && v.isWellFormed() && !v.includes('\0') && v.trim().length > 0 && bytes(v) <= max;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const statuses = ['ok', 'partial', 'busy', 'unavailable', 'unsupported', 'conflict', 'invalid-input', 'failed'];
const refuse = () => { throw new Error('Memory inspection response refused'); };
function key(v) {
  if (keys(v) !== 'fact,profile,scope' || !uuid(v.profile) || !uuid(v.fact) || keys(v.scope) !== 'kind' || v.scope.kind !== 'global') refuse();
  return { profile: v.profile, scope: { kind: 'global' }, fact: v.fact };
}
export function parseMemoryInspectionRequest(v) {
  if (keys(v) !== 'boot_id,connection_id,key' || !uuid(v.boot_id) || typeof v.connection_id !== 'string' || v.connection_id.length !== 64 || /[^a-f0-9]/.test(v.connection_id)) refuse();
  key(v.key);
  if (bytes(JSON.stringify(v)) > 1024) refuse();
  return v;
}
export async function memoryRecordId(v) {
  const canonical = JSON.stringify(key(v));
  const prefix = Uint8Array.from('6ba7b8119dad11d180b400c04fd430c8'.match(/../g), h => Number.parseInt(h, 16));
  const name = new TextEncoder().encode('urn:remarkable-buddies:subject-memory:v1:' + canonical);
  const data = new Uint8Array(prefix.length + name.length); data.set(prefix); data.set(name, prefix.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
  const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function fact(v, requested) {
  const fields = keys(v);
  if (fields !== 'claim,confidence_basis_points,expires_ms,key,observed_ms,provenance,subject,tags,value' && fields !== 'claim,confidence_basis_points,key,observed_ms,provenance,subject,tags,value') refuse();
  if (JSON.stringify(key(v.key)) !== JSON.stringify(key(requested)) || !text(v.claim, 128) || /[\x00-\x1f\x7f-\x9f]/.test(v.claim) ||
      v.claim !== v.claim.split(/[\t\n\v\f\r ]+/).filter(Boolean).join(' ').replace(/[A-Z]/g, c => c.toLowerCase()) ||
      !text(v.value, 4096) || !text(v.subject, 128) || !Array.isArray(v.tags) || v.tags.length > 16 || !v.tags.every(t => text(t, 64)) ||
      !integer(v.confidence_basis_points) || v.confidence_basis_points > 10000 || !integer(v.observed_ms) ||
      (v.expires_ms !== undefined && v.expires_ms !== null && (!integer(v.expires_ms) || v.expires_ms <= v.observed_ms))) refuse();
  const p = v.provenance;
  if (keys(p) !== 'basis,conversation,description,source,turn' || !['user-confirmed', 'source-assertion', 'inferred'].includes(p.basis) || !text(p.description, 512) ||
      ![p.conversation, p.turn, p.source].every(v => v === null || uuid(v)) || (p.turn !== null && p.conversation === null)) refuse();
  // Fresh supported values only; an omitted optional expiry stays omitted.
  return { key: key(v.key), claim: v.claim, value: v.value, subject: v.subject, tags: [...v.tags], provenance: { basis: p.basis, description: p.description, conversation: p.conversation, turn: p.turn, source: p.source }, confidence_basis_points: v.confidence_basis_points, observed_ms: v.observed_ms, ...(v.expires_ms === undefined ? {} : { expires_ms: v.expires_ms }) };
}
function head(v, requested, record) {
  if (keys(v) !== 'actor,fact,kind,operation,parents,record,revision' || v.record !== record || ![v.revision, v.operation, v.actor].every(uuid) ||
      !Array.isArray(v.parents) || v.parents.length > 4096 || !v.parents.every(uuid) || new Set(v.parents).size !== v.parents.length || v.parents.includes(v.revision)) refuse();
  if (v.kind === 'tombstone') { if (v.fact !== null) refuse(); }
  else if (v.kind === 'value') fact(v.fact, requested);
  else refuse();
}
export async function parseMemoryInspectionView(v, request) {
  parseMemoryInspectionRequest(request);
  if (keys(v) !== 'heads,incomplete,status' || !statuses.includes(v.status) || typeof v.incomplete !== 'boolean' || bytes(JSON.stringify(v)) > 262144) refuse();
  if (v.status !== 'ok') { if (v.heads !== null) refuse(); return v; }
  if (v.incomplete || !Array.isArray(v.heads) || v.heads.length > 4096) refuse();
  const record = await memoryRecordId(request.key);
  v.heads.forEach(h => head(h, request.key, record));
  if (new Set(v.heads.map(h => h.revision)).size !== v.heads.length) refuse();
  return v;
}
export async function parseMemoryInspectionReport(v, request) {
  parseMemoryInspectionRequest(request);
  if (v?.report_version !== 1) throw new Error('Memory inspection report version unsupported');
  if (keys(v) !== 'data,incomplete,operation,report_version,status' || v.operation !== 'inspect' || !statuses.includes(v.status) || typeof v.incomplete !== 'boolean' || bytes(JSON.stringify(v)) + 1 > 262144) refuse();
  if (v.status !== 'ok') {
    if (v.data !== null) refuse();
    return { status: v.status, incomplete: v.incomplete, heads: null };
  }
  if (v.incomplete || !Array.isArray(v.data) || v.data.length > 4096) refuse();
  const record = await memoryRecordId(request.key);
  const heads = v.data.map(e => {
    if (keys(e) !== 'actor_id,domain_schema_version,envelope_version,kind,media_descriptors,namespace,operation_id,parents,payload,record_id,revision_id' ||
        e.envelope_version !== 1 || e.domain_schema_version !== 1 || e.namespace !== 'subject-memory' || !Array.isArray(e.media_descriptors) || e.media_descriptors.length !== 0) refuse();
    const h = { record: e.record_id, revision: e.revision_id, parents: e.parents, operation: e.operation_id, actor: e.actor_id, kind: e.kind, fact: e.payload };
    head(h, request.key, record);
    return { ...h, parents: [...h.parents], fact: h.kind === 'value' ? fact(h.fact, request.key) : null };
  });
  return parseMemoryInspectionView({ status: v.status, incomplete: v.incomplete, heads }, request);
}
function observation(v, request, validate) {
  parseMemoryInspectionRequest(request);
  if (keys(v) !== 'contract_version,memory_inspection,observation,status' || bytes(JSON.stringify(v)) > 278528) refuse();
  validate({ contract_version: v.contract_version, status: v.status, observation: v.observation });
  if (v.status === 'observed' && (v.observation.connection_id !== request.connection_id || v.observation.boot_id !== request.boot_id)) refuse();
}
export async function parseMemoryInspectionResult(v, request, validate) {
  observation(v, request, validate);
  if (bytes(JSON.stringify(v)) > 270336) refuse();
  const q = v.memory_inspection;
  if (keys(q) !== 'status,view' || !['reported', 'unsupported', 'unavailable'].includes(q.status)) refuse();
  if (q.status === 'reported') { if (v.status !== 'observed') refuse(); await parseMemoryInspectionView(q.view, request); }
  else if (q.view !== null) refuse();
  return v;
}
export async function reduceMemoryInspectionResult(v, request, validate) {
  observation(v, request, validate);
  const q = v.memory_inspection;
  if (keys(q) !== 'report,status' || !['reported', 'unsupported', 'unavailable'].includes(q.status)) refuse();
  let status = q.status, view = null;
  if (status === 'reported') {
    if (v.status !== 'observed') refuse();
    try { view = await parseMemoryInspectionReport(q.report, request); }
    catch (e) { if (e.message !== 'Memory inspection report version unsupported') throw e; status = 'unsupported'; }
  } else if (q.report !== null) refuse();
  return parseMemoryInspectionResult({ contract_version: v.contract_version, status: v.status, observation: v.observation, memory_inspection: { status, view } }, request, validate);
}
