import { parseMemoryRequest, parseMemoryResult, type MemoryRequest, type MemoryReport } from '../host/memory-query.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface MemoryResult extends ObservationResult { memory_query: { status: 'reported' | 'unsupported' | 'unavailable'; report: MemoryReport | null } }
export interface MemoryAdapter { memoryQuery(request: MemoryRequest): Promise<MemoryResult> }
export interface MemoryState { status: string; busy: boolean; report: MemoryReport | null }
export class MemoryController {
  state: MemoryState = { status: 'Not searched', busy: false, report: null };
  private generation = 0;
  private readonly changed: (state: MemoryState) => void;
  constructor(changed: (state: MemoryState) => void) { this.changed = changed; }
  private publish(status: string, busy = false, report: MemoryReport | null = null) { this.state = { status, busy, report }; this.changed(this.state); }
  clear(status = 'Not searched') { this.generation++; this.publish(status); }
  async search(adapter: MemoryAdapter, tablet: TabletObservation, text: string) {
    const generation = ++this.generation; this.publish('Searching global memory…', true);
    const request = { connection_id: tablet.connection_id, boot_id: tablet.boot_id, text };
    try {
      parseMemoryRequest(request);
      const result = await adapter.memoryQuery(request);
      if (generation !== this.generation) return;
      parseMemoryResult(result, request, validateResult);
      if (result.status !== 'observed') { this.publish(`Memory query unavailable (${result.status}) — read tablet state again`); return; }
      const q = result.memory_query;
      if (q.status !== 'reported' || !q.report) { this.publish(`Memory query ${q.status}`); return; }
      const report = q.report;
      if (report.status === 'invalid-input') { this.publish('Installed memory query input unsupported'); return; }
      if (!report.data || !('query_status' in report.data)) { this.publish(`Memory query ${report.status}`, false, report); return; }
      const labels = { disabled: 'Subject memory disabled', 'complete-empty': 'Search complete — no matching global facts', complete: 'Search complete', partial: 'Partial results — some memory could not be searched', unavailable: 'Subject memory unavailable' };
      this.publish(labels[report.data.query_status], false, report);
    } catch (error) {
      if (generation === this.generation) this.publish(error instanceof Error && error.message === 'Memory query report version unsupported' ? 'Memory query report version unsupported' : 'Memory query unavailable or response refused');
    }
  }
}
