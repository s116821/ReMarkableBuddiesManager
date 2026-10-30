// Explicit private user content projection. Raw producer payloads stay host-only.
import { strictJson } from './strict-json.mjs';
export const hwExact = (v, k) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === k.split(' ').sort().join();
export const hwUuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
export const hwDigest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const hwInt = v => Number.isSafeInteger(v) && v >= 0;
export const hwText = (v, n) => typeof v === 'string' && v.isWellFormed() && v.trim().length > 0 && new TextEncoder().encode(v).length <= n && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v);
export function hwRefuse() { throw Error('Handwriting record refused'); }
// Producer u64s use decimal integers. Inspect tokens before Number conversion can
// round an underflow/fraction into an apparently safe integer. JSON grammar,
// duplicate keys and depth remain owned by the shared strict decoder.
export function handwritingJson(raw) { const value = strictJson(raw), text = new TextDecoder('utf-8', { fatal: true }).decode(raw); const outside = text.replace(/"(?:\\.|[^"\\])*"/gs, ' '); for (const token of outside.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g))
    if (!/^(0|[1-9]\d*)$/.test(token[0]))
        hwRefuse(); return value; }
export function hwScalars(v, depth = 0) { if (depth > 32)
    hwRefuse(); if (typeof v === 'number' && !hwInt(v) || typeof v === 'string' && !v.isWellFormed())
    hwRefuse(); if (v && typeof v === 'object')
    for (const x of Object.values(v))
        hwScalars(x, depth + 1); }
export async function hwV5(name) { const n = Uint8Array.from('6ba7b8119dad11d180b400c04fd430c8'.match(/../g), s => parseInt(s, 16)), text = new TextEncoder().encode(name), all = new Uint8Array(n.length + text.length); all.set(n); all.set(text, n.length); const b = new Uint8Array(await crypto.subtle.digest('SHA-1', all)).slice(0, 16); b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128; const h = Array.from(b, n => n.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
export const handwritingRecordId = (profile, correction) => hwV5(`urn:rmb:handwriting-correction:v1:${profile}:${correction}`);
export function hwValue(v) { if (!hwExact(v, 'kind profile correction original_text corrected_text confirmed_ms provenance sample width height') || v.kind !== 'confirmed-correction' || !hwUuid(v.profile) || !hwUuid(v.correction) || !hwText(v.original_text, 4096) || !hwText(v.corrected_text, 4096) || !hwInt(v.confirmed_ms) || v.confirmed_ms === 0)
    hwRefuse(); const p = v.provenance, s = v.sample; if (!hwExact(p, 'kind description source') || p.kind !== 'caller-confirmed-sample' || !hwText(p.description, 512) || !(p.source === null || Array.isArray(p.source) && p.source.length === 3 && p.source.every(hwUuid)))
    hwRefuse(); if (!hwExact(s, 'sha256 bytes media_type') || !hwDigest(s.sha256) || !hwInt(s.bytes) || s.bytes < 1 || s.bytes > 524288 || s.media_type !== 'image/png' || ![v.width, v.height].every(n => hwInt(n) && n >= 1 && n <= 2048) || v.width * v.height > 4194304)
    hwRefuse(); }
export function parseHandwritingRequest(v) { if (v?.action === 'retained') {
    if (!hwExact(v, 'action'))
        hwRefuse();
    return v;
} if (!hwDigest(v?.connection_id) || !hwUuid(v.boot_id) || !hwUuid(v.invocation))
    hwRefuse(); const c = 'action connection_id boot_id invocation'; if (v.action === 'query') {
    if (!hwExact(v, c + ' profile query_text') || !hwUuid(v.profile) || !(v.query_text === null || hwText(v.query_text, 2048)))
        hwRefuse();
}
else if (['inspect', 'prepare-remove'].includes(v.action)) {
    if (!hwExact(v, c + ' profile correction') || !hwUuid(v.profile) || !hwUuid(v.correction))
        hwRefuse();
}
else if (['confirm-remove', 'check-remove', 'cancel'].includes(v.action)) {
    if (!hwExact(v, c + ' reference') || !(hwDigest(v.reference) || v.action === 'cancel' && v.reference === null))
        hwRefuse();
}
else
    hwRefuse(); if (new TextEncoder().encode(JSON.stringify(v)).length > (v.action === 'query' ? 16384 : 1024))
    hwRefuse(); return v; }
export function handwritingContext(q, original = null) { return Object.freeze({ ...q, expected_original_outcome: original }); }
const states = { query: ['queried', 'partial', 'busy', 'unsupported', 'unavailable', 'invalidated'], inspect: ['inspected', 'partial', 'busy', 'unsupported', 'unavailable', 'invalidated'], 'prepare-remove': ['prepared', 'not-removable', 'busy', 'unsupported', 'unavailable', 'invalidated', 'capacity'], 'confirm-remove': ['removal-observed', 'historical-removal-observed', 'not-dispatched', 'unknown', 'busy', 'unavailable', 'invalidated'], 'check-remove': ['historical-removal-observed', 'unresolved', 'busy', 'unsupported', 'unavailable', 'invalidated', 'expired'], cancel: ['not-dispatched', 'unknown', 'invalidated', 'unavailable'], retained: ['idle'] };
const outcomes = ['not-dispatched', 'unknown', 'removal-observed', 'historical-removal-observed'];
export async function parseHandwritingResult(v, q, validate) {
    if (!hwExact(v, 'contract_version status observation handwriting_records') || new TextEncoder().encode(JSON.stringify(v)).length > 270336)
        hwRefuse();
    hwScalars(v);
    validate({ contract_version: v.contract_version, status: v.status, observation: v.observation });
    if (v.status === 'observed' && (v.observation.connection_id !== q.connection_id || v.observation.boot_id !== q.boot_id))
        hwRefuse();
    const c = v.handwriting_records;
    if (!hwExact(c, 'state reference invocation view original_outcome check_outcome diagnostics retained') || !states[q.action]?.includes(c.state) || c.invocation !== (q.action === 'retained' ? null : q.invocation) || !(c.reference === null || hwDigest(c.reference)) || !(c.original_outcome === null || outcomes.includes(c.original_outcome)) || !(c.check_outcome === null || ['historical-removal-observed', 'unresolved'].includes(c.check_outcome)))
        hwRefuse();
    if (!Array.isArray(c.retained) || c.retained.length > 8 || new Set(c.retained.map(r => r.reference)).size !== c.retained.length)
        hwRefuse();
    for (const r of c.retained)
        if (!hwExact(r, 'reference connection_id boot_id original_outcome expired') || !hwDigest(r.reference) || !hwDigest(r.connection_id) || !hwUuid(r.boot_id) || !outcomes.includes(r.original_outcome) || typeof r.expired !== 'boolean')
            hwRefuse();
    const row = c.retained.find(r => r.reference === c.reference);
    if (c.original_outcome !== null && (!row || row.original_outcome !== c.original_outcome || row.connection_id !== q.connection_id || row.boot_id !== q.boot_id))
        hwRefuse();
    if (q.reference && c.reference !== q.reference && !(c.reference === null && ['invalidated', 'unavailable'].includes(c.state)))
        hwRefuse();
    if (q.action === 'check-remove' && c.original_outcome !== null && (c.reference !== q.reference || c.original_outcome !== q.expected_original_outcome || row?.original_outcome !== q.expected_original_outcome))
        hwRefuse();
    if (c.diagnostics !== null) {
        const d = c.diagnostics;
        if (!hwExact(d, 'status failure scanned matched omitted conflicted unsupported missing_media') || !['complete', 'complete-empty', 'partial', 'busy', 'unavailable', 'unsupported', 'invalid-input', 'conflict', 'failed'].includes(d.status) || !(d.failure === null || failureCodes.includes(d.failure)) || !['scanned', 'matched', 'omitted', 'conflicted', 'unsupported', 'missing_media'].every(k => hwInt(d[k])))
            hwRefuse();
    }
    const withView = ['queried', 'inspected', 'partial', 'prepared'];
    if (withView.includes(c.state)) {
        if (v.status !== 'observed' || !c.diagnostics)
            hwRefuse();
        const w = c.view;
        if (!hwExact(w, 'kind profile correction heads partial') || !hwUuid(w.profile) || w.profile !== q.profile || w.kind !== (c.state === 'prepared' ? 'confirmation' : q.action === 'query' ? 'query' : 'inspect') || w.correction !== (q.action === 'query' ? null : q.correction) || typeof w.partial !== 'boolean' || w.partial !== (c.state === 'partial') || !Array.isArray(w.heads) || w.heads.length > (q.action === 'query' ? 8 : 16))
            hwRefuse();
        if (c.diagnostics.status !== (w.partial ? 'partial' : w.heads.length ? 'complete' : 'complete-empty'))
            hwRefuse();
        if (!w.partial && ['omitted', 'conflicted', 'unsupported', 'missing_media'].some(k => c.diagnostics[k] > 0))
            hwRefuse();
        const seen = new Set();
        for (const h of w.heads) {
            if (!hwExact(h, 'record revision parents state conflicted content sample_availability') || !hwUuid(h.record) || !hwUuid(h.revision) || !Array.isArray(h.parents) || h.parents.length > 4096 || !h.parents.every(hwUuid) || new Set(h.parents).size !== h.parents.length || h.parents.includes(h.revision) || typeof h.conflicted !== 'boolean' || !['value', 'tombstone', 'unsupported'].includes(h.state) || !['available', 'unavailable', 'not-examined', 'not-applicable'].includes(h.sample_availability) || seen.has(h.record + ':' + h.revision))
                hwRefuse();
            seen.add(h.record + ':' + h.revision);
            if (!w.partial && (h.state === 'unsupported' || h.state === 'value' && h.sample_availability !== 'available'))
                hwRefuse();
            if (h.state === 'value') {
                if (!hwExact(h.content, 'correction original_text corrected_text confirmed_ms provenance sample width height'))
                    hwRefuse();
                hwValue({ kind: 'confirmed-correction', profile: w.profile, ...h.content });
                if (h.record !== await handwritingRecordId(w.profile, h.content.correction) || w.correction !== null && h.content.correction !== w.correction || h.sample_availability === 'not-applicable')
                    hwRefuse();
            }
            else if (h.content !== null || h.sample_availability !== (h.state === 'tombstone' ? 'not-applicable' : 'not-examined'))
                hwRefuse();
            if (q.action === 'query' ? (h.state !== 'value' || h.conflicted || h.sample_availability !== 'available') : (h.record !== await handwritingRecordId(w.profile, w.correction) || h.conflicted !== (w.heads.length > 1)))
                hwRefuse();
        }
        if (q.action === 'query' && w.heads.length === 0 && !w.partial && c.diagnostics.matched !== 0)
            hwRefuse();
        if (q.action === 'query' && (new Set(w.heads.map(h => h.record)).size !== w.heads.length || w.heads.some((h, i) => i > 0 && w.heads[i - 1].record >= h.record)))
            hwRefuse();
        if (c.state === 'prepared' && (!c.reference || w.heads.length !== 1 || w.heads[0].state !== 'value' || w.heads[0].conflicted || w.heads[0].sample_availability !== 'available'))
            hwRefuse();
    }
    else if (c.view !== null)
        hwRefuse();
    if (['removal-observed', 'historical-removal-observed'].includes(c.state) && (v.status !== 'observed' || c.diagnostics !== null && (c.diagnostics.status !== 'complete' || c.diagnostics.failure !== null)))
        hwRefuse();
    if (['query', 'inspect', 'prepare-remove'].includes(q.action) && (c.original_outcome !== null || c.check_outcome !== null))
        hwRefuse();
    if (c.state === 'not-removable' && (v.status !== 'observed' || !c.diagnostics || c.reference !== null))
        hwRefuse();
    if (q.action === 'confirm-remove' && outcomes.includes(c.state) && !(c.state === 'not-dispatched' && c.original_outcome === null) && c.original_outcome !== c.state)
        hwRefuse();
    if (q.action === 'check-remove' && ['historical-removal-observed', 'unresolved'].includes(c.state)) {
        if (c.check_outcome !== c.state || c.original_outcome === null)
            hwRefuse();
    }
    else if (c.check_outcome !== null)
        hwRefuse();
    if (q.action === 'cancel' && (c.state === 'unknown' ? c.original_outcome !== 'unknown' : c.original_outcome !== null))
        hwRefuse();
    if (q.action === 'retained' && (v.status !== 'unconfigured' || [c.reference, c.invocation, c.view, c.original_outcome, c.check_outcome, c.diagnostics].some(x => x !== null)))
        hwRefuse();
    return v;
}
export const failureCodes = ['invalid-json', 'invalid-version', 'invalid-identity', 'invalid-confirmation', 'invalid-text', 'invalid-provenance', 'invalid-sample', 'input-limit', 'image-limit', 'invalid-budget', 'output-limit', 'unsupported-mode', 'unsupported-record', 'store-unavailable', 'ownership-busy', 'heads-conflict', 'operation-conflict', 'immutable-change', 'media-unavailable', 'commit-unknown', 'storage-failure'];
export function parseHandwritingJson(raw) { if (raw.length > 270336 || raw[0] === 239 && raw[1] === 187 && raw[2] === 191)
    hwRefuse(); return handwritingJson(raw); }
