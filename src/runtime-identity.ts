import type { RuntimeIdentity } from '../host/runtime-identity.mjs';
import type { ObservationResult, TabletObservation } from './observation';
export interface RuntimeResult extends ObservationResult { runtime_identity: RuntimeIdentity | null }
export interface RuntimeAdapter { inspectRuntime(): Promise<RuntimeResult> }
export class RuntimeIdentityController {
  state: { status: string; report: RuntimeIdentity | null } = { status: 'Not inspected', report: null };
  private generation = 0;
  private readonly changed: (state: { status: string; report: RuntimeIdentity | null }) => void;
  private readonly load:()=>Promise<typeof import('../host/runtime-identity.mjs')>;
  constructor(changed: (state: { status: string; report: RuntimeIdentity | null }) => void,load=()=>import('../host/runtime-identity.mjs')) { this.changed = changed;this.load=load; }
  private publish(status: string, report: RuntimeIdentity | null = null) { this.state = { status, report }; this.changed(this.state); }
  clear() { this.generation++; this.publish('Not inspected'); }
  async inspect(adapter: RuntimeAdapter, tablet: TabletObservation) {
    const generation = ++this.generation; this.publish('Reading binary version…');
    try {
      const value = await adapter.inspectRuntime();
      if (generation !== this.generation) return;
      const {parseRuntimeReport}=await this.load();
      if(generation!==this.generation)return;
      const view=parseRuntimeReport(value,tablet);this.publish(view.status,view.report);
    } catch { if (generation === this.generation) this.publish('Binary version report unavailable or unsupported'); }
  }
}
