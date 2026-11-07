import {createHash, randomUUID} from 'node:crypto';
import {validateResult} from './observation-protocol.mjs';
import {portableBase64, portableCanonical, portableKeys} from './portable-configuration-protocol.mjs';
import {INPUT_LIMIT, REPORT_LIMIT, parseSharedPreferenceRequest, parseSharedPreferenceReport, parseSharedPreferenceResult, sharedPreferenceContext, sameTarget} from './shared-preferences-protocol.mjs';

const LANE = 'shared-preferences';
const hash = value => createHash('sha256').update(portableCanonical(value)).digest('hex');

export class SharedPreferencesHost {
  #view = null;
  #active = null;
  #epoch = 0;
  #originals = new Map();
  #issued = new WeakMap();

  constructor({observer, io, beforeIO, now = () => performance.now(), uuid = randomUUID}) {
    Object.assign(this, {observer, io, beforeIO, now, uuid});
  }

  invalidate() {
    this.#epoch++;
    this.#view = null;
  }

  dispose() {
    this.invalidate();
    this.#originals.clear();
  }

  #result(state, reference = null, view = null) {
    const result = {state, reference, view, retained: [...this.#originals.values()].map(item => ({
      reference: item.reference, connection_id: item.target.connection_id, boot_id: item.target.boot_id
    }))};
    this.#issued.set(result, this.#epoch);
    return result;
  }

  deliver(result) {
    if (this.#issued.get(result) !== this.#epoch) throw Error('Shared preferences invalidated');
    if (result.state === 'ready' && (this.#view?.reference !== result.reference ||
        !sameTarget(this.#view.target, this.observer.lastObservation) ||
        this.now() >= this.#view.expires)) throw Error('Shared preferences invalidated');
    const record = this.#originals.get(result.reference);
    if (record?.terminal === result) {
      if (!sameTarget(record.target, this.observer.lastObservation)) throw Error('Shared preferences invalidated');
      this.#originals.delete(result.reference);
      result.retained = result.retained.filter(item => item.reference !== result.reference);
    }
    return result;
  }

  #terminal(state, reference) {
    const result = this.#result(state, reference);
    this.#originals.get(reference).terminal = result;
    return result;
  }

  #current(active) {
    return active.epoch === this.#epoch && this.io.owns(active.token) &&
      this.now() < active.deadline && sameTarget(active.target, this.observer.lastObservation);
  }

  async #run(active, operation, body, context) {
    const input = Buffer.from(JSON.stringify(body));
    if (input.length > INPUT_LIMIT) { input.fill(0); throw Error('Shared request refused'); }
    const budget_ms = Math.min(12000, Math.floor(active.deadline - this.now()));
    if (budget_ms < 1) { input.fill(0); throw Error('Shared request expired'); }
    const request = {selector: operation, input_base64: input.toString('base64'), budget_ms,
      connection_id: active.target.connection_id, boot_id: active.target.boot_id};
    input.fill(0);
    let report;
    try { report = await this.observer.run(LANE, request); }
    finally { request.input_base64 = null; }
    if (portableKeys(report) !== 'contract_version,observation,portable_configuration_raw,status') {
      throw Error('Shared observation refused');
    }
    const {contract_version, status, observation, portable_configuration_raw: raw} = report;
    if (portableKeys(raw) !== 'status,stdout_base64') throw Error('Shared report refused');
    validateResult({contract_version, status, observation});
    if (status !== 'observed' || !sameTarget(active.target, observation) || !this.#current(active)) {
      throw Error('Shared observation refused');
    }
    if (operation === 'inspect' && raw?.status === 'unsupported' && raw.stdout_base64 === null) {
      return {state: 'unsupported'};
    }
    if (raw?.status !== 'reported') throw Error('Shared report unavailable');
    const bytes = Buffer.from(portableBase64(raw.stdout_base64, REPORT_LIMIT));
    try { return parseSharedPreferenceReport(bytes, operation, context, portableCanonical); }
    finally { bytes.fill(0); }
  }

  async request(value) {
    let q = parseSharedPreferenceRequest(value);
    const action = q.action;
    const requestedReference = q.reference;
    value = null;
    if (q.action === 'retained') return this.#result('idle');
    if (q.action === 'cancel') {
      if (this.#active?.reference === q.reference && this.io.owns(this.#active.token)) {
        this.invalidate();
        this.observer.cancel();
      } else if (this.#view?.reference === q.reference) {
        this.invalidate();
      }
      return this.#result(this.#originals.has(q.reference) ? 'unknown' : 'invalidated', q.reference);
    }

    const sample = this.observer.lastObservation;
    const reference = q.action === 'inspect' ? this.uuid() : q.reference;
    if (!sameTarget(q, sample)) return this.#result('unavailable', q.reference);
    const token = this.io.acquire(LANE, reference, q.action);
    if (!token) return this.#result('busy', q.reference);
    const active = {token, target: structuredClone(sample), reference, deadline: this.now() + 12000};
    try {
      if (q.action !== 'edit') this.invalidate();
      this.beforeIO();
      active.epoch = this.#epoch;
      this.#active = active;
      if (q.action === 'inspect') {
        const report = await this.#run(active, 'inspect', {shared_preferences_version: 1,
          reveal_text: q.reveal_text}, q);
        if (report.state !== 'ready') return this.#result(report.state);
        const {guard, view} = report;
        this.#view = {reference, guard, target: active.target, expires: this.now() + 120000};
        return this.#result('ready', reference, view);
      }

      if (q.action === 'edit') {
        const view = this.#view;
        if (!view || view.reference !== reference || !sameTarget(view.target, sample) ||
            this.now() >= view.expires || !this.#current(active)) {
          return this.#result('invalidated', reference);
        }
        this.#view = null;
        if (this.#originals.size >= 8) return this.#result('capacity', reference);
        const original = {operation: this.uuid(), guard: view.guard, patch_sha256: hash(q.patch)};
        const body = {shared_preferences_version: 1, operation: original.operation,
          guard: original.guard, patch: q.patch};
        this.#originals.set(reference, {reference, target: active.target, original});
        const pending = this.#run(active, 'edit', body, original);
        body.patch = null;
        q = null;
        const report = await pending;
        return report.state === 'unknown' ? this.#result('unknown', reference) : this.#terminal(report.state, reference);
      }

      const entry = this.#originals.get(reference);
      if (!entry || !sameTarget(entry.target, sample)) return this.#result('unavailable', reference);
      const report = await this.#run(active, 'status', {shared_preferences_version: 1, ...entry.original}, entry.original);
      return report.state === 'local-committed' ? this.#terminal(report.state, reference) : this.#result(report.state, reference);
    } catch {
      return this.#result(action !== 'inspect' && this.#originals.has(reference) ? 'unknown' : 'unavailable', requestedReference);
    } finally {
      if (this.#active === active) this.#active = null;
      this.io.release(token);
    }
  }
}


export function registerSharedPreferenceHandler(ipcMain, authorized, host) {
  ipcMain.handle('manager:sharedPreferences', async (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw Error('Shared preferences caller refused');
    let request = parseSharedPreferenceRequest(args[0]);
    args.length = 0;
    const context = sharedPreferenceContext(request);
    const pending = host.request(request);
    request = null;
    return host.deliver(parseSharedPreferenceResult(await pending, context));
  });
}
