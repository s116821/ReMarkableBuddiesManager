import { parsePersonalizationRequest, parsePersonalizationResult, validText } from '../host/personalization.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { PersonalizationRequest, PersonalizationReport, PersonalizationOperation } from '../host/personalization.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface PersonalizationResult extends ObservationResult { personalization: { status: 'reported' | 'unsupported' | 'unavailable'; outcome: 'read-only' | 'verified' | 'unknown' | 'not-dispatched'; report: PersonalizationReport | null } }
export interface PersonalizationAdapter { personalization(request: PersonalizationRequest): Promise<PersonalizationResult> }
export interface PersonalizationState { status: string; busy: boolean; report: PersonalizationReport | null; unknown: boolean }
export { validText };
const normalized = (s: string) => s.replace(/\r\n?/g, '\n');
export function rawOffset(text: string, offset: number) {
  let raw = 0, shown = 0;
  while (raw < text.length && shown < offset) { if (text[raw] === '\r' && text[raw + 1] === '\n') raw++; raw++; shown++; }
  return raw;
}
// Keep unchanged original line endings when a textarea exposes normalized DOM text.
export function editText(current: string, display: string) {
  const prior = normalized(current); let start = 0, end = 0;
  while (start < prior.length && start < display.length && prior[start] === display[start]) start++;
  while (end < prior.length - start && end < display.length - start && prior[prior.length - 1 - end] === display[display.length - 1 - end]) end++;
  return current.slice(0, rawOffset(current, start)) + display.slice(start, display.length - end) + current.slice(rawOffset(current, prior.length - end));
}
export class PersonalizationController {
  state: PersonalizationState = { status: 'Not inspected', busy: false, report: null, unknown: false };
  private generation = 0;
  private writing = false;
  private readonly changed: (state: PersonalizationState) => void;
  constructor(changed: (state: PersonalizationState) => void) { this.changed = changed; }
  private publish(status: string, report: PersonalizationReport | null = null, busy = false, unknown = false) { this.state = { status, report, busy, unknown }; this.changed(this.state); }
  clear() { this.generation++; const unknown = this.writing || this.state.unknown; this.writing = false; this.publish(unknown ? 'Previous save outcome unknown — inspect the wired tablet again' : 'Not inspected', null, false, unknown); }
  async run(adapter: PersonalizationAdapter, tablet: TabletObservation, operation: PersonalizationOperation, text = '', enabled = false) {
    if (this.state.busy) return;
    const prior = this.state.report;
    if (operation !== 'inspect' && (!prior || prior.status !== 'ok')) return;
    const request: PersonalizationRequest = { operation, connection_id: tablet.connection_id, boot_id: tablet.boot_id };
    if (operation !== 'inspect') request.expected_config_sha256 = prior!.config_sha256!;
    if (operation === 'set') { request.text = text; request.enabled = enabled; }
    try { parsePersonalizationRequest(request); } catch { this.publish('Invalid text — use at most 16,384 UTF-8 bytes and no NUL', prior); return; }
    const generation = ++this.generation;
    this.writing = operation !== 'inspect'; this.publish(operation === 'inspect' ? 'Inspecting personalization…' : 'Saving personalization…', null, true);
    try {
      const value = parsePersonalizationResult(await adapter.personalization(request), request, validateResult) as PersonalizationResult;
      if (generation !== this.generation) return;
      if (value.status !== 'observed' || !value.observation || (tablet.connection_id !== value.observation.connection_id || tablet.boot_id !== value.observation.boot_id)) {
        const unknown = operation !== 'inspect' && value.personalization.outcome !== 'not-dispatched';
        this.publish(unknown ? 'Save outcome unknown — inspect again before retrying' : 'Personalization unavailable — read the wired tablet again', null, false, unknown); return;
      }
      const report = value.personalization.report;
      if (!report || report.status !== 'ok') {
        const reason = value.personalization.status === 'unsupported' ? 'unsupported' : report?.status ?? 'unavailable';
        this.publish(`Personalization ${reason} — inspect again${operation !== 'inspect' ? '; save outcome unverified' : ''}`, null, false, operation !== 'inspect'); return;
      }
      const saved = report.personalization!;
      if ((operation === 'set' && (saved.text !== text || saved.enabled !== enabled)) || (operation === 'disable' && (saved.enabled || saved.text !== prior!.personalization!.text)) || (operation === 'clear' && (saved.enabled || saved.text !== ''))) throw new Error('Readback mismatch');
      this.publish(operation === 'inspect' ? 'Disk setting read — running activation unverified' : 'Saved on disk — restart required', report);
    } catch { if (generation === this.generation) this.publish(operation === 'inspect' ? 'Personalization report unavailable or unsupported' : 'Save outcome unknown — inspect again before retrying', null, false, operation !== 'inspect'); }
    finally { if (generation === this.generation) this.writing = false; }
  }
}
