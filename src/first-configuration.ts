import {
  parseFirstConfigResult, sameTarget, type FirstConfigCurrent, type FirstConfigOriginal,
  type FirstConfigRequest, type FirstConfigResult, type FirstConfigTarget,
} from '../host/first-configuration-protocol.mjs';

export type FirstConfigAdapter = (request: FirstConfigRequest) => Promise<FirstConfigResult>;
type Work = Exclude<FirstConfigRequest, {action: 'retained' | 'cancel'}>;
type Cancel = Extract<FirstConfigRequest, {action: 'cancel'}>;

interface State {
  busy: boolean;
  status: FirstConfigResult['state'];
  reference: string | null;
  current: FirstConfigCurrent | null;
  retained: FirstConfigOriginal[];
}

interface Run {
  request: Work;
  invoke: FirstConfigAdapter;
  sent: boolean;
  stopping: boolean;
}

export class FirstConfigurationController {
  state: State = {busy: false, status: 'none', reference: null, current: null, retained: []};
  private active: Run | null = null;
  private review: {target: FirstConfigTarget; reference: string; invoke: FirstConfigAdapter} | null = null;
  private generation = 0;

  private readonly changed: (state: State) => void;
  private readonly invocation: () => string;
  private readonly timeoutMs: number;

  constructor(changed: (state: State) => void, invocation = () => crypto.randomUUID(), timeoutMs = 14000) {
    this.changed = changed;
    this.invocation = invocation;
    this.timeoutMs = timeoutMs;
  }

  private update(patch: Partial<State>) {
    this.state = {...this.state, ...patch};
    this.changed(this.state);
  }

  private async wait<T>(pending: Promise<T>, budget: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Configuration request expired')), budget);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(invoke: FirstConfigAdapter, request: FirstConfigRequest, budget = this.timeoutMs) {
    return parseFirstConfigResult(await this.wait(invoke(request), budget), request);
  }

  async retained(invoke: FirstConfigAdapter) {
    const generation = this.generation;
    try {
      const value = await this.call(invoke, {action: 'retained'});
      if (this.generation === generation) this.update({retained: value.retained});
    } catch { /* Retained history can be refreshed by any deliberate action. */ }
  }

  async run(action: 'review' | 'create' | 'check', target: FirstConfigTarget, invoke: FirstConfigAdapter,
    pause: () => Promise<boolean>) {
    if (this.active) return;
    const identity = {connection_id: target.connection_id, boot_id: target.boot_id};
    let request: Work;
    if (action === 'create') {
      if (!this.review || !sameTarget(this.review.target, target)) return;
      request = {action, ...identity, reference: this.review.reference, invocation: this.invocation()};
    } else {
      request = {action, ...identity, invocation: this.invocation()};
    }
    const active: Run = this.active = {request, invoke, sent: false, stopping: false};
    const deadline = performance.now() + this.timeoutMs;
    this.generation++;
    this.update({busy: true, status: 'none'});
    try {
      if (!await this.wait(pause(), this.timeoutMs)) {
        if (this.active === active && !active.stopping) this.update({status: 'invalidated', reference: null});
        return;
      }
      if (this.active !== active || active.stopping) return;
      const remaining = deadline - performance.now();
      if (remaining < 1) throw Error('Configuration request expired');
      active.sent = true;
      // The reviewed file state expires once Create may reach Buddy.
      if (action === 'create') this.update({current: null});
      const value = await this.call(invoke, request, remaining);
      if (this.active !== active || active.stopping) return;
      const retainedReview = action === 'create' && value.state === 'busy' ? this.review : null;
      this.review = value.state === 'ready' && value.reference ? {target: identity, reference: value.reference, invoke} : retainedReview;
      this.update({status: retainedReview ? 'ready' : value.state, reference: this.review?.reference ?? null, retained: value.retained,
        current: value.current ?? (value.state === 'created' || value.state === 'present' ? 'present' : this.state.current)});
    } catch {
      if (this.active === active && !active.stopping) {
        if (active.sent) await this.stop();
        else this.update({status: 'unavailable', reference: null});
      }
    } finally {
      if (this.active === active && !active.stopping) {
        this.active = null;
        this.update({busy: false});
      }
    }
  }

  async stop() {
    const active = this.active;
    if (!active || active.stopping) return;
    active.stopping = true;
    const generation = this.generation;
    const review = this.review;
    this.review = null;
    const {request, invoke} = active;
    let result: FirstConfigResult | undefined;
    if (active.sent) {
      const cancel: Cancel = {action: 'cancel', connection_id: request.connection_id, boot_id: request.boot_id,
        reference: request.action === 'create' ? request.reference : null, invocation: request.invocation};
      try { result = await this.call(invoke, cancel); } catch { /* Preserve an uncertain Create below. */ }
    } else if (review) {
      const {target, reference} = review;
      void this.call(invoke, {action: 'cancel', ...target, reference, invocation: null}).catch(() => {});
    }
    if (this.active !== active) return;
    this.active = null;
    const status = result?.state ?? (active.sent && request.action === 'create' ? 'unknown' : 'invalidated');
    this.update(generation === this.generation
      ? {busy: false, status, reference: null, retained: result?.retained ?? this.state.retained,
        current: status === 'created' || status === 'present' ? 'present' : this.state.current}
      : {busy: false});
  }

  discard() {
    if (this.active) void this.stop();
    this.generation++;
    const review = this.review;
    this.review = null;
    this.update({status: 'none', reference: null, current: null});
    if (!review) return;
    void this.call(review.invoke, {action: 'cancel', connection_id: review.target.connection_id,
      boot_id: review.target.boot_id, reference: review.reference, invocation: null}).catch(() => {});
  }
}
