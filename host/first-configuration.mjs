import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {MaintenanceIO} from './maintenance-io.mjs';
import {
  digest, uuid, sameTarget, parseFirstConfigRequest, parseFirstConfigResult, parseFirstConfigProducerReport,
} from './first-configuration-protocol.mjs';

export class FirstConfigurationHost {
  #review = null;
  #active = null;
  #originals = new Map();
  #invocations = new Map();
  #issued = new WeakMap();
  #epoch = 0;
  #closed = false;

  constructor({observer, io = new MaintenanceIO(), beforeIO = () => {}, now = () => performance.now(),
    reference = () => randomBytes(32).toString('hex'), budgetMs = 13000}) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 13000) throw Error('Invalid configuration budget');
    Object.assign(this, {observer, io, beforeIO, now, reference, budgetMs});
  }

  invalidate(document) {
    const active = this.#active;
    if (document === undefined) {
      // Peer invalidation retires an idle review. A peer that could not acquire
      // the joined lane cannot cancel its current owner.
      if (!active) { this.#review = null; this.#epoch++; }
      return;
    }
    if (this.#review?.document === document) this.#review = null;
    this.#invocations.delete(document);
    if (active?.document === document) {
      active.controller.abort();
      return active.joined;
    }
  }

  dispose() {
    this.#closed = true;
    this.#review = null;
    this.#invocations.clear();
    const active = this.#active;
    active?.controller.abort();
    return active?.joined;
  }

  #admit(sample) {
    // This is a private registration seam. An observed service state or binary
    // version cannot supply package ownership, supported selectors or quiescence.
    const service = sample?.service;
    if (service?.ActiveState !== 'inactive' || service.SubState !== 'dead') return null;
    const proof = this.observer.firstConfigurationAdmission?.(sample);
    if (proof) {
      if (proof.configuration_protocol !== 1 || !digest(proof.package_sha256) ||
          !uuid(proof.quiescence_id) || !isDeepStrictEqual(sample, proof.target) ||
          !['loaded', 'not-found'].includes(service.LoadState)) return null;
      return {kind: 'initial', package_sha256: proof.package_sha256, quiescence_id: proof.quiescence_id};
    }
    // The physical backend must independently qualify and bind the resident launcher.
    return service.LoadState === 'loaded' ? {kind: 'existing-default'} : null;
  }

  #live(attempt) {
    if (this.#closed || this.#active !== attempt || !this.io.owns(attempt.token) ||
        attempt.controller.signal.aborted || !attempt.callerCurrent() || this.now() >= attempt.deadline ||
        !isDeepStrictEqual(attempt.sample, this.observer.lastObservation)) return false;
    try { return isDeepStrictEqual(attempt.admission, this.#admit(attempt.sample)); }
    catch { return false; }
  }

  #unknown(connection) {
    return [...this.#originals.values()].some(row => row.connection_id === connection && row.outcome === 'unknown');
  }

  #value(request, state, current = null, review = null, issued = null) {
    const value = parseFirstConfigResult({version: 1, state, invocation: request.invocation ?? null,
      reference: review?.reference ?? request.reference ?? null, current,
      retained: [...this.#originals.values()].map(({reference, connection_id, boot_id, outcome}) =>
        ({reference, connection_id, boot_id, outcome})),
    }, request);
    if (issued) this.#issued.set(value, {issued, review});
    return value;
  }

  deliver(value, request, callerCurrent) {
    if (!callerCurrent()) throw Error('Configuration caller changed');
    const receipt = this.#issued.get(value);
    if (receipt) {
      const {issued, review} = receipt;
      if (this.#closed || issued.epoch !== this.#epoch || issued.controller.signal.aborted || this.now() >= issued.deadline ||
          !isDeepStrictEqual(issued.sample, this.observer.lastObservation) ||
          !isDeepStrictEqual(issued.admission, this.#admit(issued.sample)) ||
          review && (review !== this.#review || this.now() >= review.expires)) {
        throw Error('Configuration result changed');
      }
    }
    return parseFirstConfigResult(value, request);
  }

  #cancel(request, document) {
    const active = this.#active;
    const review = this.#review;
    if (review?.document === document && sameTarget(review.sample, request) &&
        (review.reference === request.reference && request.invocation === null ||
          request.reference === null && review.attempt.request.invocation === request.invocation)) {
      this.#review = null;
      return this.#value(request, 'invalidated');
    }
    if (active?.document === document && sameTarget(active.sample, request) &&
        (active.request.reference ?? null) === request.reference && active.request.invocation === request.invocation) {
      active.controller.abort();
      return active.joined.then(() => this.#value(request,
        this.#originals.get(request.reference)?.outcome ?? 'invalidated'));
    }
    const original = this.#originals.get(request.reference);
    if (original?.document === document && original.invocation === request.invocation && sameTarget(original, request)) {
      return this.#value(request, original.outcome);
    }
    if (request.invocation !== null && sameTarget(request, this.observer.lastObservation)) {
      const ledger = this.#ledger(document);
      if (!ledger.has(request.invocation)) {
        if (ledger.size >= 32) return this.#value(request, 'capacity');
        ledger.add(request.invocation);
      }
    }
    return this.#value(request, 'invalidated');
  }

  #ledger(document) {
    let ledger = this.#invocations.get(document);
    if (!ledger) this.#invocations.set(document, ledger = new Set());
    return ledger;
  }

  request(value, {document, callerCurrent, onAbandon}) {
    const request = parseFirstConfigRequest(value);
    if (this.#closed || typeof document !== 'symbol' || !callerCurrent()) throw Error('Configuration caller refused');
    if (request.action === 'retained') return this.#value(request, 'none');
    if (request.action === 'cancel') return this.#cancel(request, document);
    const ledger = this.#ledger(document);
    if (ledger.has(request.invocation)) return this.#value(request, 'invalidated');
    if (ledger.size >= 32) return this.#value(request, 'capacity');
    const sample = this.observer.lastObservation;
    if (!sameTarget(request, sample)) return this.#value(request, 'unavailable');
    const admission = this.#admit(sample);
    if (!admission) return this.#value(request, 'unavailable');
    const create = request.action === 'create';
    const isReview = request.action === 'review';
    const review = this.#review;
    if ((create || isReview) && this.#unknown(request.connection_id)) return this.#value(request, 'unknown');
    if (create && (!review || review.document !== document || review.reference !== request.reference ||
        this.now() >= review.expires || !isDeepStrictEqual(review.sample, sample) ||
        !isDeepStrictEqual(review.admission, admission))) return this.#value(request, 'invalidated');
    if ((create || isReview) && this.#originals.size >= 8) return this.#value(request, 'capacity');

    const captured = structuredClone(sample);
    const token = this.io.acquire('first-configuration', request.reference ?? 'check', request.action, {joined: true});
    if (!token) return this.#value(request, 'busy');
    ledger.add(request.invocation);
    const active = {request, sample: captured, admission, document, callerCurrent, token, epoch: ++this.#epoch,
      deadline: Math.min(this.now() + this.budgetMs, create ? review.expires : Infinity),
      expectedExecutable: create ? review.executable : null,
      controller: new AbortController(), joined: null};
    this.#active = active;
    this.#review = null;
    active.joined = Promise.resolve().then(() => this.#execute(active));
    onAbandon?.(() => {
      if (this.#active === active) active.controller.abort();
      if (this.#review?.attempt === active) this.#review = null;
    });
    return active.joined;
  }

  async #execute(active) {
    const {request, sample, admission, document, controller, token} = active;
    const current = () => this.#live(active);
    const timer = setTimeout(() => controller.abort(), Math.max(0, active.deadline - this.now()));
    const create = request.action === 'create';
    const selector = `${create ? 'create' : 'check'}-${admission.kind}`;
    let original;
    try {
      if (!current()) return this.#value(request, 'invalidated');
      this.beforeIO();
      if (!current()) return this.#value(request, 'invalidated');
      if (create) {
        original = {reference: request.reference, connection_id: request.connection_id, boot_id: request.boot_id,
          document, invocation: request.invocation, outcome: 'unknown'};
        this.#originals.set(original.reference, original);
      }
      const reply = await this.observer.runFirstConfiguration({selector, connection_id: request.connection_id,
        boot_id: request.boot_id, service: sample.service,
        expected_executable_sha256: active.expectedExecutable}, {
        signal: controller.signal, current, remainingMs: () => Math.floor(active.deadline - this.now()),
      });
      if (reply?.dispatch === 'not-dispatched' && reply.observation === null && reply.report === null) {
        if (original) {
          this.#originals.delete(original.reference);
          original = null;
        }
        return this.#value(request, current() ? 'unavailable' : 'invalidated');
      }
      if (!current() || reply?.dispatch !== 'possible' || !isDeepStrictEqual(reply.observation, sample) || !reply.report) {
        return this.#value(request, original ? 'unknown' : 'unavailable');
      }
      const executable = reply.executable_sha256 ?? null;
      if ((admission.kind === 'existing-default' && !digest(executable)) ||
          (admission.kind === 'initial' && executable !== null) ||
          (create && executable !== active.expectedExecutable)) {
        return this.#value(request, original ? 'unknown' : 'unavailable');
      }
      const state = parseFirstConfigProducerReport(reply.report, selector);
      if (original) {
        original.outcome = state;
        return this.#value(request, state, null, null, active);
      }
      if (request.action === 'review' && state === 'missing') {
        const reference = this.reference();
        if (!digest(reference) || this.#originals.has(reference)) return this.#value(request, 'unavailable');
        const review = this.#review = {reference, document, sample, admission, executable, expires: this.now() + 120000, attempt: active};
        return this.#value(request, 'ready', state, review, active);
      }
      return this.#value(request, 'checked', state, null, active);
    } catch {
      return this.#value(request, original ? 'unknown' : 'unavailable');
    } finally {
      clearTimeout(timer);
      if (this.#active === active) this.#active = null;
      this.io.release(token);
    }
  }
}
