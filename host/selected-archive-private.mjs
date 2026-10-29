import { createHash } from 'node:crypto';
import { strictJson } from './strict-json.mjs';
import { archiveSummary } from './selected-archive-protocol.mjs';
export const archiveHash = value => createHash('sha256').update(value).digest('hex');
export class ArchiveUnsupported extends Error { constructor() { super('Archive operation unsupported'); } }
export function parseArchiveRaw(raw, operation) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  if (raw.byteLength > 16384 || text.startsWith('\ufeff') || !text.endsWith('\n') || text.includes('\r') || text.split('\n').length !== 2) throw Error('Archive report refused');
  const v = strictJson(raw);
  if (!v || Object.keys(v).sort().join() !== 'activation_performed,data,incomplete,operation,report_version,status' || v.report_version !== 1 || v.activation_performed !== false || v.operation !== operation || !['inspect', 'export-selected'].includes(operation) || !['ok', 'invalid-input', 'unavailable', 'unsupported', ...(operation === 'export-selected' ? ['busy', 'failed'] : [])].includes(v.status) || typeof v.incomplete !== 'boolean') throw Error('Archive report refused');
  if (v.status !== 'ok') { if (v.data !== null || v.incomplete !== ['unavailable', 'failed'].includes(v.status)) throw Error('Archive refusal refused'); return { status: v.status, summary: null }; }
  if (!v.data || Object.keys(v.data).join() !== 'inspection') throw Error('Archive report refused');
  const summary = archiveSummary(v.data.inspection);
  if (v.incomplete === summary.complete_media || operation === 'export-selected' && summary.format !== 2) throw Error('Archive summary refused');
  return { status: 'ok', summary };
}
