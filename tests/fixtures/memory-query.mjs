import { tablet } from './owned-report.mjs';
export { tablet };
export const request = (text = 'gravity 第二行\r\n🦊') => ({ connection_id: tablet.connection_id, boot_id: tablet.boot_id, text });
export const id = '11111111-1111-4111-8111-111111111111';
export function report(status = 'complete') {
  return { report_version: 1, operation: 'query', status: ['partial', 'unavailable'].includes(status) ? status : 'ok', incomplete: ['partial', 'unavailable'].includes(status), data: {
    query_status: status, diagnostics: { conflicted_keys: 0, contradicted_claims: 0, unsupported: 0, expired: 0, suppressed: 0, budget_omitted: 0, snapshot_unavailable: false },
    context: { kind: 'associative-memory-data', provenance_authority: 'author-asserted-not-source-verified', facts: ['complete', 'partial'].includes(status) ? [{ record: id, revision: id, fact: { key: { profile: id, scope: { kind: 'global' }, fact: id }, claim: 'gravity', subject: 'Physics', value: 'Synthetic context 🦊\r\nSecond line', tags: ['units'], provenance: { basis: 'user-confirmed', description: 'Explicit fixture assertion', conversation: null, turn: null, source: null }, confidence_basis_points: 8000, observed_ms: 1, expires_ms: null } }] : [] } } };
}
export const reply = r => ({ contract_version: 1, status: 'observed', observation: tablet, memory_query: { status: 'reported', report: r } });
