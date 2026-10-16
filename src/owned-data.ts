import { parseOwnedReport, type OwnedDataReport } from '../host/owned-report.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface InspectionResult extends ObservationResult { inspection: { status: 'reported' | 'unsupported' | 'unavailable'; report: unknown } | null }
export interface InspectionAdapter { inspectOwned(): Promise<InspectionResult> }
export interface InspectionState { status: string; report: OwnedDataReport | null; checkedAt: string | null }
export const sameTablet = (a: TabletObservation, b: TabletObservation) => a.connection_id === b.connection_id && a.boot_id === b.boot_id;
export class OwnedDataController {
  state: InspectionState = { status: 'Not inspected', report: null, checkedAt: null };
  private generation = 0;
  private changed: (state: InspectionState) => void;
  constructor(changed: (state: InspectionState) => void) { this.changed = changed; }
  clear() { this.generation++; this.update('Not inspected'); }
  private update(status: string, report: OwnedDataReport | null = null) {
    this.state = { status, report, checkedAt: report ? new Date().toISOString() : null }; this.changed(this.state);
  }
  async inspect(adapter: InspectionAdapter, tablet: TabletObservation) {
    const generation = ++this.generation; this.update('Inspecting owned data…');
    try {
      const result = await adapter.inspectOwned();
      if (generation !== this.generation) return;
      if (result.contract_version !== 1 || result.status !== 'observed' || !result.observation || !sameTablet(tablet, result.observation)) {
        this.update('Inspection unavailable — read tablet state again'); return;
      }
      if (result.inspection?.status === 'unsupported') { this.update('Installed Buddy inspection unsupported'); return; }
      if (result.inspection?.status !== 'reported') { this.update('Owned-data report unavailable'); return; }
      const report = parseOwnedReport(result.inspection.report);
      this.update(report.status === 'complete' ? 'Inspection complete' : `Inspection ${report.status}`, report);
    } catch (error) {
      if (generation === this.generation) this.update(error instanceof Error && error.message === 'Unsupported owned-data report' ? 'Owned-data report version unsupported' : 'Owned-data report unavailable');
    }
  }
}
