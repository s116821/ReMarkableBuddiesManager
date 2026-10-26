export interface TabletObservation {
  model: string | null; firmware: string | null; firmware_conflict: boolean; architecture: string | null;
  boot_id: string; connection_id: string;
  service: { LoadState: string | null; ActiveState: string | null; SubState: string | null };
  installed_version: null; provenance: 'unknown';
}
export type ObservationStatus = 'unconfigured' | 'unsupported-host' | 'disconnected' | 'untrusted' | 'authentication-required' |
  'timeout' | 'cancelled' | 'cable-lost' | 'observation-unavailable' | 'observed';
export interface ObservationResult { contract_version: 1; status: ObservationStatus; observation: TabletObservation | null }
export interface ObservationAdapter { observe(): Promise<ObservationResult>; cancel(): Promise<ObservationResult> }
export interface ConnectionState { status: ObservationStatus | 'checking' | 'device-changed'; observation: TabletObservation | null; checkedAt: string | null }
export const CONNECTION_LABELS: Record<ConnectionState['status'], string> = {
  unconfigured: 'Not configured', 'unsupported-host': 'Host transport unavailable', disconnected: 'Wired tablet unavailable',
  untrusted: 'Tablet trust required', 'authentication-required': 'Authentication required', timeout: 'Tablet read timed out',
  cancelled: 'Disconnected', 'cable-lost': 'Cable or route changed', 'observation-unavailable': 'Tablet state unavailable',
  observed: 'Wired tablet observed', checking: 'Reading tablet state…', 'device-changed': 'Tablet session changed',
};

export class ConnectionController {
  state: ConnectionState = { status: 'unconfigured', observation: null, checkedAt: null };
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private identity: string | null = null;
  private disposed = false;
  private cancellation: Promise<unknown> = Promise.resolve();
  private readonly observations = new Set<Promise<ObservationResult>>();
  private adapter: ObservationAdapter;
  private changed: (state: ConnectionState) => void;
  private pollMs: number;
  constructor(adapter: ObservationAdapter, changed: (state: ConnectionState) => void, pollMs = 4000) {
    this.adapter = adapter; this.changed = changed; this.pollMs = pollMs;
  }
  private update(state: ConnectionState) { this.state = state; this.changed(state); }
  async connect() {
    if (this.disposed) return;
    this.stop(); this.identity = null;
    const generation = this.generation;
    this.update({ status: 'checking', observation: null, checkedAt: null });
    await this.cancellation;
    if (!this.disposed && generation === this.generation) await this.read(generation);
  }
  private async read(generation: number) {
    // connect() shows explicit progress; scheduled reads retain the last verified sample.
    if (this.disposed || generation !== this.generation) return;
    let pending: Promise<ObservationResult> | null = null;
    try {
      pending = this.adapter.observe();
      this.observations.add(pending);
      const result = await pending;
      if (this.disposed || generation !== this.generation) return;
      if (result.contract_version !== 1 || (result.status === 'observed') !== !!result.observation) throw new Error('Invalid host result');
      const identity = result.observation ? `${result.observation.connection_id}:${result.observation.boot_id}` : null;
      if (identity && this.identity && identity !== this.identity) {
        this.stop(); this.update({ status: 'device-changed', observation: null, checkedAt: null }); return;
      }
      this.identity = identity;
      this.update({ status: result.status, observation: result.observation, checkedAt: result.observation ? new Date().toISOString() : null });
      if (result.status === 'observed') this.timer = setTimeout(() => { void this.read(generation); }, this.pollMs);
      // Any failure stops observations. Reattachment requires an explicit user action.
    } catch {
      if (!this.disposed && generation === this.generation) this.update({ status: 'observation-unavailable', observation: null, checkedAt: null });
    } finally {
      if (pending) this.observations.delete(pending);
    }
  }
  private stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancellation = this.cancellation.then(() => this.adapter.cancel()).catch(() => undefined);
  }
  async pause() { this.stop(); await this.cancellation; }
  async pauseObservation() {
    // Local polling quiescence only: a global cancel could revoke another owner.
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Include queued host invocations, not just already-dispatched observations.
    const sample = this.state.observation, pending = [...this.observations];
    const results = await Promise.allSettled(pending);
    await this.cancellation;
    // An adapter timeout/abort is not successful quiescence of a queued read.
    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value.contract_version !== 1 || result.value.status !== 'observed' || !result.value.observation ||
          sample && (result.value.observation.connection_id !== sample.connection_id || result.value.observation.boot_id !== sample.boot_id)) {
        throw new Error('Observation did not quiesce');
      }
    }
  }
  disconnect() { this.stop(); this.identity = null; this.update({ status: 'cancelled', observation: null, checkedAt: null }); }
  dispose() { this.disposed = true; this.stop(); }
}
