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
    this.update({ status: 'checking', observation: null, checkedAt: null });
    try {
      const result = await this.adapter.observe();
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
    }
  }
  private stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancellation = this.cancellation.then(() => this.adapter.cancel()).catch(() => undefined);
  }
  disconnect() { this.stop(); this.identity = null; this.update({ status: 'cancelled', observation: null, checkedAt: null }); }
  dispose() { this.disposed = true; this.stop(); }
}
