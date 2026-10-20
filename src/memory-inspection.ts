import { parseMemoryInspectionRequest, parseMemoryInspectionResult, type MemoryInspectionRequest, type MemoryInspectionView, type MemoryKey } from '../host/memory-inspection.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface MemoryInspectionResult extends ObservationResult { memory_inspection: { status: 'reported' | 'unsupported' | 'unavailable'; view: MemoryInspectionView | null } }
export interface MemoryInspectionAdapter { inspectMemory(request: MemoryInspectionRequest): Promise<MemoryInspectionResult> }
export interface MemoryInspectionState { status: string; busy: boolean; key: MemoryKey | null; view: MemoryInspectionView | null }
export class MemoryInspectionController {
  state: MemoryInspectionState = { status: 'Select a search result to inspect current revisions', busy: false, key: null, view: null };
  private generation = 0;
  private readonly changed: (state: MemoryInspectionState) => void;
  constructor(changed: (state: MemoryInspectionState) => void) { this.changed = changed; }
  private publish(status: string, busy = false, key: MemoryKey | null = null, view: MemoryInspectionView | null = null) { this.state = { status, busy, key, view }; this.changed(this.state); }
  clear(status = 'Select a search result to inspect current revisions') { this.generation++; this.publish(status); }
  async inspect(adapter: MemoryInspectionAdapter, tablet: TabletObservation, key: MemoryKey) {
    const generation = ++this.generation;
    this.publish('Reading current fact revisions…', true, key);
    const request = { connection_id: tablet.connection_id, boot_id: tablet.boot_id, key };
    try {
      parseMemoryInspectionRequest(request);
      const result = await adapter.inspectMemory(request);
      await parseMemoryInspectionResult(result, request, validateResult);
      if (generation !== this.generation) return;
      if (result.status !== 'observed') { this.publish('Memory inspection unavailable — read tablet state again'); return; }
      const q = result.memory_inspection;
      if (q.status !== 'reported' || !q.view) { this.publish(`Memory inspection ${q.status}`, false, key); return; }
      const view = q.view;
      if (view.status !== 'ok' || !view.heads) { this.publish(`Memory inspection ${view.status}`, false, key, view); return; }
      this.publish(view.heads.length === 0 ? 'No current heads for this fact in the admitted view' : view.heads.length > 1 ? `Conflict — ${view.heads.length} current revisions; no winner selected` : 'Current fact revision inspected', false, key, view);
    } catch { if (generation === this.generation) this.publish('Memory inspection unavailable or response refused'); }
  }
}
