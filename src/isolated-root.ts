import {
  parseIsolatedRootRequest, parseIsolatedRootResult,
  type IsolatedRootIdentity, type IsolatedRootReport, type IsolatedRootRequest,
  type IsolatedRootResult, type IsolatedRootRetained, type IsolatedRootState, type IsolatedRootView,
} from '../host/isolated-root-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';

export interface IsolatedRootAdapter {
  isolatedRoot(request: IsolatedRootRequest): Promise<IsolatedRootResult>;
}

interface IsolatedRootUiState {
  busy: boolean;
  status: string;
  view: IsolatedRootView | null;
  retained: IsolatedRootRetained[];
}

type RunRequest = Extract<IsolatedRootRequest, IsolatedRootIdentity>;
type CancelRequest = Extract<IsolatedRootRequest, {action: 'cancel'}>;
type ReadyReview = {target: IsolatedRootIdentity; cancel: CancelRequest; expires: number};

const unknown = 'Preparation outcome is unknown. Refresh preparation history to look for its original.';
const retainedUnknown = 'Preparation outcome is unknown. You can retry the retained original.';
const invalidated = 'Review cancelled or expired. Review the saved backup again.';
const states: Record<IsolatedRootState, string> = {
  none: 'Review the saved isolated backup to prepare its cloud storage.',
  ready: 'Review complete. Confirm to prepare cloud storage for this backup.',
  invalidated,
  unsupported: 'This version of Buddy does not support isolated backup preparation.',
  unavailable: 'A saved isolated backup is unavailable. Read tablet state and check the saved mode.',
  busy: 'Another maintenance task is running.',
  capacity: 'The retained preparation history is full. You can still retry an unresolved original.',
  'storage-unavailable': 'Manager’s private operation storage is unavailable. Preparation requires that storage.',
  unknown: retainedUnknown,
  verified: 'The retained operation has verified cloud storage evidence.',
};

export function isolatedRootReportLabel(report: IsolatedRootReport) {
  const result = report.result;
  if (!result) return {
    ok: 'Buddy reported success without a preparation result.',
    'invalid-input': 'Buddy refused the preparation request.',
    unsupported: 'Buddy reported that preparation is unsupported.',
    unavailable: 'Buddy reported that preparation is unavailable.',
    busy: 'Buddy reported that storage is busy.',
    conflict: 'Buddy reported a conflict with the saved backup.',
    failed: 'Buddy reported that preparation failed.',
  }[report.status];
  return {
    'root-verified': result.currency === 'current'
      ? 'Cloud storage verified for the current saved backup.'
      : 'Cloud storage verified for the earlier backup. Buddy reported a newer saved setting.',
    'outcome-unknown': 'Buddy reported an unknown preparation outcome.',
    'authorization-required': 'Buddy reported that provider authorization is required.',
    'retry-later': 'Buddy asked to retry later.',
    'recovery-required': 'Buddy reported that provider recovery is required.',
    'provider-binding-unqualified': 'Buddy reported that the provider binding is unsupported.',
  }[result.outcome];
}

function sameTarget(a: IsolatedRootIdentity, b: IsolatedRootIdentity) {
  return a.connection_id === b.connection_id && a.boot_id === b.boot_id;
}

async function bounded<T>(pending: Promise<T>, waitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated backup wait expired')), waitMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class IsolatedRootController {
  state: IsolatedRootUiState = {busy: false, status: states.none, view: null, retained: []};
  private generation = 0;
  private ready: ReadyReview | null = null;
  private active: CancelRequest | null = null;
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  private unconfirmed: string | null = null;
  private readonly changed: (state: IsolatedRootUiState) => void;

  constructor(changed: (state: IsolatedRootUiState) => void) {
    this.changed = changed;
  }

  private publish(patch: Partial<IsolatedRootUiState>) {
    this.state = {...this.state, ...patch};
    this.changed(this.state);
  }

  private dropReview() {
    clearTimeout(this.reviewTimer);
    this.ready = null;
  }

  private reset() {
    this.generation++;
    const cancel = this.active ?? this.ready?.cancel;
    this.active = null;
    this.dropReview();
    if (this.state.busy || this.state.view) {
      this.publish({busy: false, view: null, status: this.unconfirmed ? unknown : invalidated});
    }
    return cancel;
  }

  clear(adapter?: IsolatedRootAdapter) {
    const request = this.reset();
    if (adapter && request) void this.cancel(adapter, request);
  }

  async stop(adapter: IsolatedRootAdapter) {
    const request = this.reset();
    if (!request) return;
    const generation = this.generation;
    const view = await this.cancel(adapter, request);
    if (view && generation === this.generation) this.publish({retained: view.retained});
  }

  private async cancel(adapter: IsolatedRootAdapter, request: CancelRequest) {
    try {
      return await this.read(adapter, request);
    } catch {
      return null;
    }
  }

  private async read(adapter: IsolatedRootAdapter, request: IsolatedRootRequest) {
    parseIsolatedRootRequest(request);
    const value = await bounded(adapter.isolatedRoot(request), 46000);
    return parseIsolatedRootResult(value, request, validateResult).isolated_root_preparation;
  }

  async retained(adapter: IsolatedRootAdapter) {
    if (this.state.busy || this.ready) return;
    const generation = ++this.generation;
    this.publish({busy: true, view: null, status: 'Reading retained preparations…'});
    try {
      const view = await this.read(adapter, {action: 'retained'});
      if (generation !== this.generation) return;
      if (view.state === 'storage-unavailable') {
        this.publish({busy: false, status: states['storage-unavailable']});
        return;
      }
      const row = view.retained.find(record => record.reference === this.unconfirmed);
      if (row?.state === 'verified') this.unconfirmed = null;
      this.publish({busy: false, retained: view.retained, status: this.unconfirmed
        ? 'The earlier preparation is unconfirmed. Retry its original if it appears below.'
        : 'Retained preparations refreshed.'});
    } catch {
      if (generation === this.generation) this.publish({busy: false, status: 'Retained preparations could not be read.'});
    }
  }

  canPrepare(target: IsolatedRootIdentity) {
    return !this.state.busy && !!this.ready && this.ready.expires > performance.now() && sameTarget(target, this.ready.target);
  }

  canRetry(target: IsolatedRootIdentity, selected: IsolatedRootRetained) {
    return !this.state.busy && !!this.state.retained.find(row =>
      row.reference === selected.reference && row.state === 'unknown' && sameTarget(target, row));
  }

  async begin(adapter: IsolatedRootAdapter, target: IsolatedRootIdentity, pause: () => Promise<boolean>) {
    if (this.state.busy) return;
    this.clear(adapter);
    await this.run(adapter, {action: 'begin', ...this.target(target), wait_id: crypto.randomUUID()}, pause);
  }

  async prepare(adapter: IsolatedRootAdapter, target: IsolatedRootIdentity, pause: () => Promise<boolean>) {
    if (!this.canPrepare(target) || !this.ready) return;
    await this.run(adapter, {
      action: 'prepare', ...this.target(target), reference: this.ready.cancel.reference, wait_id: crypto.randomUUID(),
    }, pause);
  }

  async retry(adapter: IsolatedRootAdapter, target: IsolatedRootIdentity, record: IsolatedRootRetained, pause: () => Promise<boolean>) {
    if (!this.canRetry(target, record)) return;
    this.clear(adapter);
    await this.run(adapter, {action: 'retry', ...this.target(target), reference: record.reference, wait_id: crypto.randomUUID()}, pause);
  }

  private target({connection_id, boot_id}: IsolatedRootIdentity) {
    return {connection_id, boot_id};
  }

  private async run(adapter: IsolatedRootAdapter, request: RunRequest, pause: () => Promise<boolean>) {
    const generation = ++this.generation;
    this.publish({busy: true, view: null, status: request.action === 'begin' ? 'Reading the saved backup…' : 'Preparing cloud storage…'});
    try {
      const paused = await bounded(pause(), 14000);
      if (generation !== this.generation) return;
      if (!paused || request.action === 'prepare' && (!this.ready || this.ready.expires <= performance.now())) {
        this.clear(adapter);
        return;
      }
      if (request.action !== 'begin') {
        this.dropReview();
        this.active = {action: 'cancel', reference: request.reference, wait_id: request.wait_id};
        this.unconfirmed = request.reference;
      }
      const pending = adapter.isolatedRoot(parseIsolatedRootRequest(request)).then(value => {
        const view = parseIsolatedRootResult(value, request, validateResult).isolated_root_preparation;
        if (generation !== this.generation && request.action === 'begin' && view.state === 'ready' && view.reference) {
          void this.cancel(adapter, {action: 'cancel', reference: view.reference, wait_id: request.wait_id});
        }
        return view;
      });
      const view = await bounded(pending, 46000);
      if (generation !== this.generation) return;
      this.active = null;
      if (request.action === 'begin' && view.state === 'ready' && view.reference) {
        this.ready = {
          target: this.target(request), expires: performance.now() + 120000,
          cancel: {action: 'cancel', reference: view.reference, wait_id: request.wait_id},
        };
        this.reviewTimer = setTimeout(() => this.clear(adapter), 120000);
      }
      const row = view.retained.find(record => record.reference === this.unconfirmed);
      if (row || !['invalidated', 'storage-unavailable'].includes(view.state)) {
        if (request.action !== 'begin' || row) this.unconfirmed = null;
      }
      let status = states[view.state];
      if (view.state === 'invalidated' && this.unconfirmed) status = unknown;
      if (view.state === 'invalidated' && row?.state === 'unknown') status = retainedUnknown;
      if (view.state === 'verified' && view.report) status = isolatedRootReportLabel(view.report);
      this.publish({
        busy: false, view,
        retained: view.state === 'storage-unavailable' ? this.state.retained : view.retained,
        status,
      });
    } catch {
      if (generation !== this.generation) return;
      const dispatched = !!this.active;
      this.clear(adapter);
      this.publish({status: dispatched ? unknown : 'Manager could not finish the backup review. Review the saved backup again.'});
    }
  }
}
