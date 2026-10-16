import { parseRuntimeIdentity } from '../host/runtime-identity.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import type { RuntimeIdentity } from '../host/runtime-identity.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface RuntimeResult extends ObservationResult { runtime_identity: RuntimeIdentity | null }
export interface RuntimeAdapter { inspectRuntime(): Promise<RuntimeResult> }
export class RuntimeIdentityController {
  state: { status: string; report: RuntimeIdentity | null } = { status: 'Not inspected', report: null };
  private generation = 0;
  private readonly changed: (state: { status: string; report: RuntimeIdentity | null }) => void;
  constructor(changed: (state: { status: string; report: RuntimeIdentity | null }) => void) { this.changed = changed; }
  private publish(status: string, report: RuntimeIdentity | null = null) { this.state = { status, report }; this.changed(this.state); }
  clear() { this.generation++; this.publish('Not inspected'); }
  async inspect(adapter: RuntimeAdapter, tablet: TabletObservation) {
    const generation = ++this.generation; this.publish('Reading binary version…');
    try {
      const value = await adapter.inspectRuntime();
      if (generation !== this.generation) return;
      if (!value || Object.keys(value).sort().join() !== 'contract_version,observation,runtime_identity,status') throw new Error('Unsupported runtime report');
      validateResult({ contract_version: value.contract_version, status: value.status, observation: value.observation });
      if (value.status !== 'observed' || !value.observation || value.observation.boot_id !== tablet.boot_id || value.observation.connection_id !== tablet.connection_id) { this.publish('Binary version unavailable — read tablet state again'); return; }
      const report = parseRuntimeIdentity(value.runtime_identity);
      this.publish(report.status === 'reported' ? 'Binary version reported — unverified' : `Binary identity ${report.status}`, report);
    } catch { if (generation === this.generation) this.publish('Binary version report unavailable or unsupported'); }
  }
}
