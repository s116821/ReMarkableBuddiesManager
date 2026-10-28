// Closed safe companion projection. Host-held paths and response history are not grants.
import { strictJson } from './strict-json.mjs';
import { basicDigest, basicUuid } from './basic-settings-protocol.mjs';
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === fields.split(' ').sort().join();
const refuse = () => { throw Error('Archive operation refused'); };
const size = v => new TextEncoder().encode(JSON.stringify(v)).length;
const outcomes = ['not-dispatched', 'exported', 'partial-media', 'unknown'];
const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 4096;
export function archivePath(v) { return typeof v === 'string' && v.isWellFormed() && v.startsWith('/') && v !== '/' && !v.includes('\0') && new TextEncoder().encode(v).length <= 4096; }
export function archiveSummary(v) {
  if (!exact(v, 'format manifests objects selected_scopes selection_receipts complete_media configuration_included') || ![1, 2, 3].includes(v.format) || !['manifests', 'objects', 'selected_scopes', 'selection_receipts'].every(k => count(v[k])) || typeof v.complete_media !== 'boolean' || typeof v.configuration_included !== 'boolean') refuse();
  if (v.format === 2 ? v.selected_scopes < 1 || v.configuration_included : v.selected_scopes !== 0 || v.selection_receipts !== 0) refuse();
  return { ...v };
}
export function parseArchiveRequest(v) {
  if (v?.action === 'retained') { if (!exact(v, 'action')) refuse(); return v; }
  if (!['inspect', 'prepare-export', 'confirm-export', 'check-export', 'cancel'].includes(v?.action) || !basicDigest(v.connection_id) || !basicUuid(v.boot_id) || !basicUuid(v.invocation)) refuse();
  if (['inspect', 'prepare-export'].includes(v.action)) {
    if (!exact(v, 'action connection_id boot_id invocation path') || !archivePath(v.path) || size(v) > 16384) refuse();
  } else if (!exact(v, 'action connection_id boot_id invocation reference') || !(basicDigest(v.reference) || v.action === 'cancel' && v.reference === null) || size(v) > 512) refuse();
  return v;
}
export function archiveResponseContext(q, expectedOriginal = null) {
  const { action, connection_id, boot_id, invocation, reference } = q;
  return Object.freeze({ action, connection_id, boot_id, invocation, reference, ...(action === 'check-export' ? { expected_original_outcome: expectedOriginal } : {}) });
}
const allowed = {
  inspect: ['inspected', 'partial-media', 'unsupported', 'unavailable', 'busy', 'invalid-input', 'invalidated'],
  'prepare-export': ['ready', 'unsupported', 'unavailable', 'busy', 'capacity', 'invalid-input', 'invalidated'],
  'confirm-export': ['exported', 'partial-media', 'not-dispatched', 'unknown', 'unavailable', 'busy', 'invalidated'],
  'check-export': ['archive-observed', 'incomplete-media-observed', 'unresolved', 'unsupported', 'unavailable', 'busy', 'invalidated'],
  cancel: ['not-dispatched', 'unknown', 'invalidated', 'unavailable'], retained: ['idle']
};
export function parseArchiveResult(v, q, validate) {
  if (!exact(v, 'contract_version status observation selected_archive') || size(v) > 8192) refuse();
  validate({ contract_version: v.contract_version, status: v.status, observation: v.observation });
  if (v.status === 'observed' && (v.observation.connection_id !== q.connection_id || v.observation.boot_id !== q.boot_id)) refuse();
  const c = v.selected_archive;
  if (!exact(c, 'state reference invocation summary original_outcome check_outcome retained') || !allowed[q.action]?.includes(c.state) || c.reference !== null && !basicDigest(c.reference) || c.invocation !== (q.action === 'retained' ? null : q.invocation) || c.original_outcome !== null && !outcomes.includes(c.original_outcome) || c.check_outcome !== null && !['archive-observed', 'incomplete-media-observed', 'unresolved'].includes(c.check_outcome)) refuse();
  if (!Array.isArray(c.retained) || c.retained.length > 8) refuse();
  const seen = new Set();
  for (const row of c.retained) {
    if (!exact(row, 'reference connection_id boot_id original_outcome expired') || !basicDigest(row.reference) || !basicDigest(row.connection_id) || !basicUuid(row.boot_id) || !outcomes.includes(row.original_outcome) || typeof row.expired !== 'boolean' || seen.has(row.reference)) refuse();
    seen.add(row.reference);
  }
  const row = c.retained.find(r => r.reference === c.reference);
  if (c.original_outcome !== null && (!row || row.original_outcome !== c.original_outcome || row.connection_id !== q.connection_id || row.boot_id !== q.boot_id)) refuse();
  if (q.action === 'check-export' && c.original_outcome !== null && (!outcomes.includes(q.expected_original_outcome) || c.original_outcome !== q.expected_original_outcome || row?.original_outcome !== q.expected_original_outcome || row?.reference !== q.reference || row?.connection_id !== q.connection_id || row?.boot_id !== q.boot_id)) refuse();
  if (q.reference && c.reference !== q.reference && !(c.reference === null && ['invalidated', 'unavailable'].includes(c.state))) refuse();
  const summaries = ['inspected', 'exported', 'partial-media', 'archive-observed', 'incomplete-media-observed'];
  if (summaries.includes(c.state)) {
    const summary = archiveSummary(c.summary);
    if (!c.reference || v.status !== 'observed' || summary.complete_media !== !['partial-media', 'incomplete-media-observed'].includes(c.state) || q.action === 'confirm-export' && summary.format !== 2) refuse();
  } else if (c.summary !== null) refuse();
  if (q.action === 'inspect' && (c.original_outcome !== null || c.check_outcome !== null)) refuse();
  if (q.action === 'prepare-export' && (c.original_outcome !== null || c.check_outcome !== null || c.state === 'ready' && !c.reference)) refuse();
  if (q.action === 'confirm-export' && ['exported', 'partial-media', 'unknown', 'not-dispatched'].includes(c.state) && c.original_outcome !== c.state) refuse();
  if (q.action === 'check-export' && ['archive-observed', 'incomplete-media-observed', 'unresolved'].includes(c.state) && (c.check_outcome !== c.state || c.original_outcome === null)) refuse();
  if (q.action !== 'check-export' && c.check_outcome !== null) refuse();
  if (q.action === 'check-export' && !['archive-observed', 'incomplete-media-observed', 'unresolved'].includes(c.state) && c.check_outcome !== null) refuse();
  if (q.action === 'cancel' && (c.state === 'unknown' ? c.original_outcome !== 'unknown' : c.original_outcome !== null)) refuse();
  if (q.action === 'retained' && (c.reference !== null || c.summary !== null || c.original_outcome !== null || c.check_outcome !== null || v.status !== 'unconfigured')) refuse();
  return v;
}
export function parseArchiveJson(raw) {
  if (raw.byteLength > 8192 || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).startsWith('\ufeff')) refuse();
  return strictJson(raw);
}
