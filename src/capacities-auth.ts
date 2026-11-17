import {parseCapacitiesState,type CapacitiesConnectionState,type CapacitiesState,type CapacitiesStatus} from '../host/capacities-protocol.mjs';

export interface CapacitiesAdapter {
  status(): Promise<CapacitiesState>;
  begin(): Promise<CapacitiesState>;
  cancel(): Promise<CapacitiesState>;
  reconcile(): Promise<CapacitiesState>;
  inspectConnection?(): Promise<CapacitiesConnectionState>;
  disconnect?(connectionRef: string): Promise<CapacitiesConnectionState>;
}
export interface PreparedCapacitiesBegin {
  begin(): Promise<CapacitiesState>;
  close(): void;
}
export interface CapacitiesUiState {
  status: CapacitiesStatus;
  pending: 'begin' | 'cancel' | 'reconcile' | null;
  notice: string | null;
  ownsFlow: boolean;
}

export const capacitiesLabels: Record<CapacitiesStatus,string> = {
  unconfigured: 'Capacities sign-in is unavailable in this build.',
  unavailable: 'Capacities sign-in status is unavailable.',
  disconnected: 'Capacities is ready to connect.',
  starting: 'Starting Capacities sign-in…',
  'awaiting-consent': 'Finish sign-in in the browser window.',
  'handing-off': 'Verifying and saving access on the tablet…',
  connected: 'Capacities access is set up on the tablet.',
  canceled: 'Capacities sign-in canceled.',
  expired: 'Capacities sign-in expired.',
  denied: 'Capacities access was declined.',
  'authorization-failed': 'Capacities sign-in could not start or finish.',
  'selection-changed': 'The tablet or its settings changed during sign-in.',
  'not-dispatched': 'The exchange did not start. You can connect again.',
  staged: 'The tablet retained the grant. Check the original connection to see whether setup completed.',
  'reconcile-required': 'The sign-in outcome is unconfirmed. Check the original connection.',
};

export const capacitiesActive = (status: CapacitiesStatus) =>
  status === 'starting' || status === 'awaiting-consent' || status === 'handing-off';
export const capacitiesMayBegin = (status: CapacitiesStatus) =>
  status === 'disconnected' || status === 'canceled' || status === 'expired' || status === 'denied' ||
  status === 'authorization-failed' || status === 'selection-changed' || status === 'not-dispatched';
export const capacitiesMayCheck = (status: CapacitiesStatus) =>
  status === 'staged' || status === 'reconcile-required';

export class CapacitiesController {
  state: CapacitiesUiState = {status:'unavailable',pending:null,notice:null,ownsFlow:false};
  private generation = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private popup: PreparedCapacitiesBegin | null = null;
  private beginRequest: Promise<CapacitiesState> | null = null;
  private readonly adapter: CapacitiesAdapter | undefined;
  private readonly changed: (state: CapacitiesUiState, confirmed?: boolean) => void;
  private readonly prepareBegin?: () => PreparedCapacitiesBegin;
  private readonly pollMs: number;

  constructor(adapter: CapacitiesAdapter | undefined, changed: (state: CapacitiesUiState, confirmed?: boolean) => void,
              prepareBegin?: () => PreparedCapacitiesBegin, pollMs = 1000) {
    this.adapter = adapter;
    this.changed = changed;
    this.prepareBegin = prepareBegin;
    this.pollMs = pollMs;
  }

  private publish(next: Partial<CapacitiesUiState>, confirmed = false) {
    this.state = {...this.state,...next};
    this.changed(this.state,confirmed);
  }

  private live(generation: number) {
    return !this.disposed && generation === this.generation;
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.disposed || this.state.pending || !capacitiesActive(this.state.status)) return;
    this.timer = setTimeout(() => { void this.refresh(); }, this.pollMs);
  }

  async refresh() {
    if (!this.adapter || this.disposed || this.state.pending) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    try {
      const value = parseCapacitiesState(await this.adapter.status());
      if (this.live(generation)) this.publish({status:value.status,notice:null,
        ownsFlow:this.state.ownsFlow && capacitiesActive(value.status)},
        this.state.ownsFlow && value.status === 'connected');
    } catch {
      if (this.live(generation)) this.publish({notice:'Could not check Capacities sign-in status.'});
    } finally {
      if (this.live(generation)) this.schedule();
    }
  }

  async begin(quiesce: () => Promise<boolean>, previousConnection = false) {
    if (!this.adapter || this.disposed || this.state.pending ||
        !(capacitiesMayBegin(this.state.status) || previousConnection && this.state.status === 'connected')) return;
    let prepared: PreparedCapacitiesBegin | null = null;
    try {
      prepared = this.prepareBegin?.() ?? null;
    } catch {
      this.publish({notice:'Allow a sign-in window to open, then try Connect again.'});
      return;
    }
    this.popup = prepared;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.publish({pending:'begin',notice:null});
    let request: Promise<CapacitiesState> | null = null;
    try {
      if (!await quiesce() || !this.live(generation)) {
        if (this.live(generation)) this.publish({notice:'Read the original tablet state again before connecting.'});
        return;
      }
      this.publish({status:'starting'});
      request = (prepared ? prepared.begin() : this.adapter.begin()).then(parseCapacitiesState);
      this.beginRequest = request;
      const value = await request;
      if (this.live(generation)) this.publish({status:value.status,ownsFlow:capacitiesActive(value.status)},
        value.status === 'connected');
    } catch {
      if (this.live(generation)) this.publish({notice:'Capacities sign-in did not open or could not be checked.'});
    } finally {
      prepared?.close();
      if (request && this.beginRequest === request) this.beginRequest = null;
      if (this.popup === prepared) this.popup = null;
      if (this.live(generation)) {
        this.publish({pending:null});
        this.schedule();
      }
    }
  }

  async cancel() {
    if (!this.adapter || this.disposed || this.state.pending === 'cancel' ||
        (this.state.pending !== 'begin' && !this.state.ownsFlow)) return;
    const request = this.beginRequest, owned = this.state.ownsFlow;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.popup?.close();
    this.popup = null;
    if (!request && !owned) {
      this.publish({pending:null,notice:null});
      return;
    }
    // A Cancel cannot precede admission of our still-running Begin request.
    // A terminal reply or failed admission cannot authorize canceling another flow.
    await this.settle('cancel', generation, async () => {
      if (request) {
        const result = await request;
        if (!capacitiesActive(result.status)) return result;
      }
      return this.adapter!.cancel();
    });
  }

  async reconcile(quiesce: () => Promise<boolean>, confirmsConnection = true) {
    if (!this.adapter || this.disposed || this.state.pending || !capacitiesMayCheck(this.state.status)) return;
    const generation = ++this.generation;
    await this.settle('reconcile', generation, async () => {
      if (!await quiesce() || !this.live(generation)) throw Error('Original tablet unavailable');
      return this.adapter!.reconcile();
    }, confirmsConnection);
  }

  private async settle(action: 'cancel' | 'reconcile', generation: number, request: () => Promise<CapacitiesState>,
                       confirmsConnection = true) {
    this.publish({pending:action,notice:null});
    try {
      const value = parseCapacitiesState(await request());
      if (this.live(generation)) this.publish({status:value.status,
        ownsFlow:action === 'cancel' && capacitiesActive(value.status)}, confirmsConnection && value.status === 'connected');
    } catch {
      if (this.live(generation)) this.publish({notice:'Could not check the original sign-in outcome.'});
    } finally {
      if (this.live(generation)) {
        this.publish({pending:null});
        this.schedule();
      }
    }
  }

  pageHidden() {
    if (this.state.pending === 'begin' || this.state.ownsFlow) void this.cancel();
  }

  dispose() {
    this.pageHidden();
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.popup?.close();
    this.popup = null;
  }
}
