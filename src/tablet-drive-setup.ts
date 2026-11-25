import {parseTabletDriveSetupRequest, parseTabletDriveSetupResult, type TabletDriveIdentity, type TabletDriveRetained,
  type TabletDriveSetupRequest, type TabletDriveSetupResult, type TabletDriveSetupState, type TabletDriveSetupView} from '../host/tablet-drive-setup-protocol.mjs';

export type TabletDriveSetupAdapter = (request: TabletDriveSetupRequest) => Promise<TabletDriveSetupResult>;
interface UiState {busy: boolean; status: string; view: TabletDriveSetupView | null; retained: TabletDriveRetained[]; uncertain: boolean}
const labels: Record<TabletDriveSetupState, string> = {
  none: 'Connect the tablet to your Google account to prepare its backups.',
  authorizing: 'Finish signing in with Google, then return here.',
  ready: 'Review the account and tablet, then confirm.',
  verified: 'The tablet credential change was verified. Backup mode has not changed.',
  observed: 'The requested credential state is present on the tablet. The earlier response was not confirmed.',
  unchanged: 'The original credential state is still present. No write was retried.',
  unknown: 'The result is unknown. Check the original change before doing anything else.',
  unresolved: 'The original change could not be reconciled. It has not been retried.',
  cancelled: 'Setup cancelled.', unavailable: 'Setup is unavailable. Check the wired connection and installed Buddy version.',
  busy: 'Another maintenance task is running.', refused: 'The tablet or account changed. Start a new review.',
  expired: 'Sign-in expired. Start again.', capacity: 'Resolve pending credential changes before starting another.',
  unsupported: 'The installed Buddy does not support this setup.', invalidated: 'Setup changed or expired. Start again.',
  'recovery-required': 'The saved backup identity is unavailable. Reconnecting requires its original backup setup.',
};

export class TabletDriveSetupController {
  state: UiState = {busy: false, status: labels.none, view: null, retained: [], uncertain: false};
  private generation = 0;
  private target: TabletDriveIdentity | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: {generation: number; action: TabletDriveSetupRequest['action']} | null = null;
  private readonly adapter: TabletDriveSetupAdapter;
  private readonly changed: (state: UiState) => void;
  private readonly current: (target: TabletDriveIdentity) => boolean;

  constructor(adapter: TabletDriveSetupAdapter, changed: (state: UiState) => void, current: (target: TabletDriveIdentity) => boolean) {
    this.adapter = adapter; this.changed = changed; this.current = current;
  }

  private publish(patch: Partial<UiState>) { this.state = {...this.state, ...patch}; this.changed(this.state); }
  private stopPoll() { if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; }

  async loadRetained() { if (!this.state.busy) await this.run({action: 'retained'}); }

  async begin(target: TabletDriveIdentity, intent: 'connect' | 'remove') {
    if (this.state.busy || !this.current(target)) return;
    this.clear(); this.target = {connection_id: target.connection_id, boot_id: target.boot_id};
    await this.run({action: 'begin', ...this.target, intent});
  }

  async confirm() {
    const reference = this.state.view?.reference, target = this.target;
    if (!target || !reference || this.state.view?.state !== 'ready' || this.state.busy || !this.current(target)) return;
    await this.run({action: 'confirm', ...target, reference});
  }

  async check(record: TabletDriveRetained) {
    if (this.state.busy || !record.status_available || !this.current(record)) return;
    this.target = {connection_id: record.connection_id, boot_id: record.boot_id};
    await this.run({action: 'check', ...this.target, reference: record.reference});
  }

  private async run(request: TabletDriveSetupRequest) {
    parseTabletDriveSetupRequest(request);
    const generation = ++this.generation;
    const operation = {generation, action: request.action};
    this.inFlight = operation;
    this.stopPoll(); this.publish({busy: true});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = parseTabletDriveSetupResult(await Promise.race([this.adapter(request), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Setup response expired')), 16000);
      })]), request);
      const view = result.tablet_drive;
      if (generation !== this.generation || 'connection_id' in request && !this.current(request)) {
        if (['ready', 'authorizing'].includes(view.state) && view.reference) void this.adapter({action: 'cancel', reference: view.reference}).catch(() => undefined);
        if (generation === this.generation) this.clear();
        return;
      }
      const uncertain = ['unknown', 'unresolved'].includes(view.state) || request.action === 'retained' && this.state.uncertain;
      this.publish({busy: false, view, retained: view.retained, status: uncertain && view.state === 'none' ? labels.unknown : labels[view.state], uncertain});
      if (view.state === 'authorizing' && view.reference && this.target) {
        const target = {...this.target}, reference = view.reference;
        this.pollTimer = setTimeout(() => {
          if (generation === this.generation && this.current(target)) void this.run({action: 'poll', ...target, reference});
          else this.clear();
        }, 800);
      }
    } catch {
      if (generation === this.generation) this.publish({busy: false, view: null,
        status: request.action === 'confirm' ? 'The response was lost. Refresh pending changes to check the original result.' : labels.unavailable,
        uncertain: request.action === 'confirm' || this.state.uncertain});
    } finally {
      clearTimeout(timer);
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  hide() {
    if (this.inFlight && ['confirm', 'check'].includes(this.inFlight.action)) return;
    this.clear();
  }

  clear() {
    const uncertain = this.state.uncertain || !!this.inFlight && ['confirm', 'check'].includes(this.inFlight.action);
    this.generation++; this.stopPoll();
    this.inFlight = null;
    const reference = this.state.view?.reference;
    if (reference) void this.adapter({action: 'cancel', reference}).catch(() => undefined);
    this.target = null;
    this.publish({busy: false, view: null, status: uncertain ? labels.unknown : labels.none, uncertain});
  }

  dispose() { this.clear(); }
}
