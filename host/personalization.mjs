export const PERSONALIZATION_OPERATIONS = Object.freeze(['inspect', 'set', 'disable', 'clear']);
export const validText = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && new TextEncoder().encode(value).length <= 16384;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const keys = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join() : '';
export function parsePersonalizationRequest(v) {
  if (!PERSONALIZATION_OPERATIONS.includes(v?.operation) || !digest(v.connection_id) || typeof v.boot_id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.boot_id)) throw new Error('Invalid personalization request');
  const expected = v.operation === 'inspect' ? 'boot_id,connection_id,operation' : v.operation === 'set' ? 'boot_id,connection_id,enabled,expected_config_sha256,operation,text' : 'boot_id,connection_id,expected_config_sha256,operation';
  if (keys(v) !== expected || (v.operation !== 'inspect' && !digest(v.expected_config_sha256)) || (v.operation === 'set' && (typeof v.enabled !== 'boolean' || !validText(v.text)))) throw new Error('Invalid personalization request');
  return v;
}
export function parsePersonalizationReport(v, operation) {
  if (keys(v) !== 'config_sha256,disk_reload_verified,operation,personalization,report_version,runtime_activation,status' || v.report_version !== 1 || v.operation !== operation || !['ok', 'invalid-input', 'unavailable', 'unsupported', 'busy', 'conflict', 'failed'].includes(v.status)) throw new Error('Unsupported personalization report');
  if (v.status === 'ok') {
    if (!digest(v.config_sha256) || v.disk_reload_verified !== true || v.runtime_activation !== (operation === 'inspect' ? 'unverified' : 'restart-required') || keys(v.personalization) !== 'enabled,schema_version,text' || v.personalization.schema_version !== 1 || typeof v.personalization.enabled !== 'boolean' || !validText(v.personalization.text)) throw new Error('Invalid personalization readback');
  } else if (v.config_sha256 !== null || v.personalization !== null || v.disk_reload_verified !== false || v.runtime_activation !== 'unverified') throw new Error('Invalid personalization refusal');
  return v;
}
export function parsePersonalizationResult(value, request, validateObservation) {
  if (keys(value) !== 'contract_version,observation,personalization,status') throw new Error('Invalid personalization response');
  validateObservation({ contract_version: value.contract_version, status: value.status, observation: value.observation });
  const p = value.personalization;
  if (keys(p) !== 'outcome,report,status' || !['reported', 'unsupported', 'unavailable'].includes(p.status) || !['read-only', 'verified', 'unknown', 'not-dispatched'].includes(p.outcome)) throw new Error('Invalid personalization outcome');
  if (p.report !== null) {
    parsePersonalizationReport(p.report, request.operation);
    if (value.status !== 'observed' || p.status !== 'reported' || (p.report.status === 'ok' && p.outcome !== (request.operation === 'inspect' ? 'read-only' : 'verified')) || (p.report.status !== 'ok' && p.outcome !== (request.operation === 'inspect' ? 'read-only' : 'unknown'))) throw new Error('Invalid personalization outcome');
  } else if (p.status === 'reported' || p.outcome === 'verified') throw new Error('Invalid personalization outcome');
  return value;
}
