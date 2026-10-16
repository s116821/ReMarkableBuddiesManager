import { parseDriveState, parseDriveBegin, unavailableDrive } from '../host/drive-protocol.mjs';
import type { DriveState, DriveBegin } from '../host/drive-protocol.mjs';
export type { DriveState, DriveBegin };
export interface DriveAdapter {
  status(): Promise<DriveState>;
  begin(): Promise<DriveBegin>;
  cancel(): Promise<DriveState>;
  check(): Promise<DriveState>;
  disconnect(): Promise<DriveState>;
  revoke(authorizationId: string): Promise<DriveState>;
}
export class DriveController {
  state: DriveState = unavailableDrive();
  authorizationUrl: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly adapter: DriveAdapter;
  private readonly changed: (state: DriveState, url: string | null) => void;
  constructor(adapter: DriveAdapter, changed: (state: DriveState, url: string | null) => void) { this.adapter = adapter; this.changed = changed; }
  private publish(state: DriveState, url: string | null = null) { this.state = state; this.authorizationUrl = url; this.changed(state, url); }
  async load() {
    const generation = this.generation;
    try { const state = parseDriveState(await this.adapter.status()); if (generation === this.generation) { this.publish(state, state.status === 'connecting' ? this.authorizationUrl : null); this.poll(); } }
    catch { if (generation === this.generation) this.publish(unavailableDrive()); }
  }
  private poll() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.state.status === 'connecting' ? setTimeout(() => { void this.load(); }, 800) : null;
  }
  async begin() {
    const generation = ++this.generation;
    this.publish({ ...unavailableDrive(), status: 'connecting', error: null });
    try { const result = parseDriveBegin(await this.adapter.begin()); if (generation === this.generation) { this.publish(result.state, result.authorizationUrl); this.poll(); } }
    catch { if (generation === this.generation) this.publish(unavailableDrive()); }
  }
  async action(action: 'check' | 'cancel' | 'disconnect' | 'revoke') {
    const authorizationId = this.state.authorizationId;
    if (action === 'revoke' && !authorizationId) return;
    const generation = ++this.generation;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.publish({ ...unavailableDrive(), status: action === 'check' ? 'checking' : action === 'revoke' ? 'revoking' : 'cancelled', error: null });
    try { const state = parseDriveState(await (action === 'revoke' ? this.adapter.revoke(authorizationId!) : this.adapter[action]())); if (generation === this.generation) this.publish(state); }
    catch { if (generation === this.generation) this.publish(unavailableDrive()); }
  }
  dispose() { this.generation++; if (this.timer) clearTimeout(this.timer); void this.adapter.cancel().catch(() => undefined); }
}
