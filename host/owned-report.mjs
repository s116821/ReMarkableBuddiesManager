// Versioned CLI data contract, independent of Git-tag application versions.
export const STORAGE_KINDS = ['structural', 'record-metadata', 'media-object', 'unclassified-object', 'retained-generation', 'cache', 'diagnostics', 'staging'];
export const DOMAINS = ['conversation', 'source', 'export-association', 'subject-memory', 'handwriting'];
export const ISSUE_CODES = ['configuration-unavailable', 'invalid-paths', 'missing-owner', 'invalid-owner', 'missing-current', 'missing-lock', 'busy-writer', 'lock-unavailable', 'lock-unsupported', 'lease-identity-changed', 'unsupported-generation', 'missing-entry', 'unreadable-entry', 'unsafe-entry', 'unexpected-entry', 'entry-limit', 'metadata-limit', 'byte-count-overflow', 'invalid-metadata', 'invalid-reference', 'missing-object', 'uninspected-reference', 'omitted-media', 'size-mismatch', 'inconsistent-reference', 'state-changed', 'state-unverifiable', 'cache-unavailable', 'cache-owner-mismatch'];
export const REPORT_STATUSES = ['complete', 'partial', 'unavailable', 'unsupported', 'busy'];
export const DOMAIN_FIELDS = ['observed_record_files', 'observed_record_bytes', 'declared_media_bytes', 'present_referenced_media_bytes', 'missing_references', 'uninspected_references', 'size_mismatched_references', 'omitted_references'];
const fields = ['report_version', 'status', 'owner_actor', 'current_generation', 'observed_files', 'observed_apparent_bytes', 'complete_apparent_bytes', 'storage', 'observed_domains', 'domain_accounting_complete', 'cache_inspected', 'shared_media_files', 'shared_media_apparent_bytes', 'issues', 'byte_basis', 'reference_totals_additive', 'media_content_verified', 'logical_liveness_evaluated', 'credentials_inspected', 'native_documents_inspected', 'lease_identity_check', 'excluded_scopes'];
const feedbackDomains = [...DOMAINS, 'unassociated-feedback'];
const feedbackFields = [...fields, 'current_generation_format', 'retained_generation_formats'];
const fail = () => { throw new Error('Invalid owned-data report'); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join() === [...keys].sort().join();
const count = v => Number.isSafeInteger(v) && v >= 0;
const uuid = v => v === null || (typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v));
export function parseOwnedReport(value) {
  if (!object(value)) fail();
  if (value.report_version !== 1 && value.report_version !== 2) throw new Error('Unsupported owned-data report');
  const feedback = value.report_version === 2;
  const json = JSON.stringify(value);
  // Keep the released report1 branch unchanged; report2 has its own closed wire.
  const size = feedback ? new TextEncoder().encode(json).byteLength : json.length;
  if (size > 32768 || !exact(value, feedback ? feedbackFields : fields) || !REPORT_STATUSES.includes(value.status)) fail();
  if (feedback) {
    if (![null, 1, 2, 3].includes(value.current_generation_format)) fail();
    const formats = value.retained_generation_formats;
    if (!Array.isArray(formats) || formats.length > 3 || formats.some((format, i) => ![1, 2, 3].includes(format) || (i > 0 && formats[i - 1] >= format))) fail();
    if (value.status === 'complete' && (value.current_generation_format !== 3 || !exact(value.observed_domains, feedbackDomains))) fail();
  }
  for (const key of ['observed_files', 'observed_apparent_bytes', 'shared_media_files', 'shared_media_apparent_bytes']) if (!count(value[key])) fail();
  if (!uuid(value.owner_actor) || !uuid(value.current_generation)) fail();
  if (value.complete_apparent_bytes !== null && (!count(value.complete_apparent_bytes) || value.status !== 'complete' || value.complete_apparent_bytes !== value.observed_apparent_bytes)) fail();
  if (value.status === 'complete' && value.complete_apparent_bytes === null) fail();
  for (const key of ['domain_accounting_complete', 'cache_inspected']) if (typeof value[key] !== 'boolean') fail();
  for (const key of ['reference_totals_additive', 'media_content_verified', 'logical_liveness_evaluated', 'credentials_inspected', 'native_documents_inspected']) if (value[key] !== false) fail();
  if (value.byte_basis !== 'apparent-file-length-per-owned-path; data-and-cache-only; no-allocated-or-reclaimable-claim' || !['device-inode', 'metadata-bracket; no-stable-file-id-guarantee'].includes(value.lease_identity_check)) fail();
  if (!Array.isArray(value.excluded_scopes) || value.excluded_scopes.join() !== 'credentials,native-documents,legacy-cache,external-transient-diagnostics') fail();
  if (!object(value.storage) || !object(value.observed_domains) || !object(value.issues)) fail();
  for (const [key, usage] of Object.entries(value.storage)) if (!STORAGE_KINDS.includes(key) || !exact(usage, ['files', 'apparent_bytes']) || !Object.values(usage).every(count)) fail();
  for (const [key, usage] of Object.entries(value.observed_domains)) if (!(feedback ? feedbackDomains : DOMAINS).includes(key) || !exact(usage, DOMAIN_FIELDS) || !Object.values(usage).every(count)) fail();
  for (const [key, n] of Object.entries(value.issues)) if (!ISSUE_CODES.includes(key) || !count(n) || n === 0) fail();
  // Reconstruct known JSON only: no privileged or prototype-carried fields escape.
  return JSON.parse(JSON.stringify(value));
}
