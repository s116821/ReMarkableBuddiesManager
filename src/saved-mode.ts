import { parseSavedModeRequest, parseSavedModeResult, type SavedModeRequest, type SavedModeView } from '../host/saved-mode.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface SavedModeResult extends ObservationResult { saved_mode: { status: 'reported' | 'unsupported' | 'unavailable'; view: SavedModeView | null } }
export interface SavedModeAdapter { inspectSavedMode(request: SavedModeRequest): Promise<SavedModeResult> }
export interface SavedModeState { status: string; busy: boolean; view: SavedModeView | null }
export class SavedModeController {
  state: SavedModeState = { status: 'Not inspected', busy: false, view: null };
  private generation = 0;
  private readonly changed: (state: SavedModeState) => void;
  constructor(changed: (state: SavedModeState) => void) { this.changed = changed; }
  private publish(status: string, busy = false, view: SavedModeView | null = null) { this.state = { status, busy, view }; this.changed(this.state); }
  clear(status = 'Not inspected') { this.generation++; this.publish(status); }
  async inspect(adapter: SavedModeAdapter, tablet: TabletObservation) {
    const generation = ++this.generation;
    this.publish('Reading saved storage mode…', true);
    const request = { connection_id: tablet.connection_id, boot_id: tablet.boot_id };
    try {
      parseSavedModeRequest(request);
      const result = await adapter.inspectSavedMode(request);
      if (generation !== this.generation) return;
      parseSavedModeResult(result, request, validateResult);
      if (result.status !== 'observed') { this.publish(`Saved mode unavailable (${result.status}) — read tablet state again`); return; }
      const q = result.saved_mode;
      if (q.status !== 'reported' || !q.view) { this.publish(`Saved mode inspection ${q.status}`); return; }
      const view = q.view;
      if (view.status !== 'ok' || !view.snapshot) {
        this.publish(view.status === 'busy' ? 'Buddy data is busy — try again later' : `Saved mode inspection ${view.status}`, false, view);
        return;
      }
      const labels = { unconfigured: 'No explicit storage mode saved', 'local-only': 'Local only (saved)', 'isolated-backup': 'Isolated backup (saved)', 'shared-group': 'Shared group (saved)' };
      this.publish(labels[view.snapshot.kind], false, view);
    } catch {
      if (generation === this.generation) this.publish('Saved mode unavailable or response refused');
    }
  }
}
