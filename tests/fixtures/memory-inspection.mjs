// Explicitly synthetic semantic reports; actual producer specimens are separately attributed.
import { report as queryReport, tablet } from './memory-query.mjs';
export { tablet };
export const key = { profile: '11111111-1111-4111-8111-111111111111', scope: { kind: 'global' }, fact: '22222222-2222-4222-8222-222222222222' };
export const record = 'aa0b8ad5-2bb5-5515-84d6-668fb768d199';
export const id = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
export const request = () => ({ connection_id: tablet.connection_id, boot_id: tablet.boot_id, key: structuredClone(key) });
export function envelope(n = 1, kind = 'value') {
  const fact = structuredClone(queryReport().data.context.facts[0].fact); fact.key = structuredClone(key);
  return { envelope_version: 1, namespace: 'subject-memory', domain_schema_version: 1, record_id: record, revision_id: id(n), parents: [], operation_id: id(n + 100), actor_id: id(200), kind, payload: kind === 'value' ? fact : null, media_descriptors: [] };
}
export const report = (data = [envelope()]) => ({ report_version: 1, operation: 'inspect', status: 'ok', incomplete: false, data });
export const privateReply = r => ({ contract_version: 1, status: 'observed', observation: tablet, memory_inspection: { status: 'reported', report: r } });
export const query = () => { const q = queryReport(); q.data.context.facts[0] = { record, revision: id(1), fact: envelope().payload }; return q; };
