import { MaintenanceIO } from './maintenance-io.mjs';
import { performance } from 'node:perf_hooks';

const READ_MS = 12000;
const EXCHANGE_MS = 60000;
const CAPTURE = ['tablet_id', 'connection_id', 'boot_id', 'config_sha256'];
const IDS = ['operation_id', 'grant_id'];
const ORIGINAL = [...CAPTURE, ...IDS];
const BOOT = ['connection_id', 'boot_id'];
const REPORT = ['contract_version', 'status'];
const PROOF = ['code', 'verifier', 'client_id', 'redirect_uri', 'resource'];
const keys = (value, fields) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
const match = (value, expected, fields) => Boolean(value && expected && fields.every(key => value[key] === expected[key]));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const ascii = (value, max) => typeof value === 'string' && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const refuse = () => { throw Error('Capacities tablet operation refused'); };

function proofValid(value) {
  return keys(value, PROOF) && ascii(value.code, 4096) && ascii(value.client_id, 256)
    && typeof value.verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value.verifier)
    && value.redirect_uri === 'http://127.0.0.1:48761/oauth/capacities/callback'
    && value.resource === 'https://api.capacities.io';
}

function captureFacts(report, expected) {
  if (!keys(report, [...REPORT, ...CAPTURE]) || report.contract_version !== 1
      || report.status !== 'captured' || !match(report, expected, BOOT)
      || !uuid(report.tablet_id) || !digest(report.config_sha256)) refuse();
  return Object.freeze(Object.fromEntries(CAPTURE.map(key => [key, report[key]])));
}

function originalReceipt(report, binding) {
  const committed = report?.status === 'committed';
  const expected = [...REPORT, ...ORIGINAL, ...(committed ? ['installed_config_sha256', 'space_id'] : [])];
  if (!keys(report, expected) || report.contract_version !== 1 || !match(report, binding, ORIGINAL)
      || !['committed', 'not-dispatched', 'staged', 'unresolved'].includes(report.status)
      || (committed && (!digest(report.installed_config_sha256) || !uuid(report.space_id)))) refuse();
  return Object.freeze(Object.fromEntries(expected.map(key => [key, report[key]])));
}

// Private port for the host consent broker. Only one original enrollment has
// custody at a time. An uncertain exchange retains identifiers, never proof.
export class CapacitiesTablet {
  #observer;
  #io;
  #beforeIO;
  #original = null;

  constructor({ observer, io = new MaintenanceIO(), beforeIO = () => {} } = {}) {
    this.#observer = observer;
    this.#io = io;
    this.#beforeIO = beforeIO;
  }

  async #owned(selector, binding, reference, { signal, deadline } = {}, write) {
    const unstarted = () => {
      if (write) return {secret_disposition: 'not-sent'};
      refuse();
    };
    if (signal?.aborted || !match(this.#observer.lastObservation, binding, BOOT)) return unstarted();
    const token = this.#io.acquire('capacities-oauth', reference, selector);
    if (!token) return unstarted();
    try {
      try { this.#beforeIO(); } catch { return unstarted(); }
      if (signal?.aborted || !this.#io.owns(token) || !match(this.#observer.lastObservation, binding, BOOT)) return unstarted();
      const exchange = selector === 'exchange';
      const budget_ms = Math.min(exchange ? EXCHANGE_MS : READ_MS,
        Math.floor(deadline - performance.now()) - (exchange ? 2000 : 1000));
      if (!Number.isSafeInteger(budget_ms) || budget_ms < (exchange ? 34000 : 1)) return unstarted();
      const request = { selector, budget_ms, binding };
      if (write) {
        write.claim();
        request.proof = write.proof;
        request.executable_sha256 = write.executable_sha256;
      }
      let response;
      try {
        response = await this.#observer.runCapacities(request, { signal, deadline });
      } finally {
        delete request.proof;
      }
      if (write && response?.secret_disposition === 'not-sent') return response;
      if (signal?.aborted || performance.now() >= deadline || !this.#io.owns(token) || response?.status !== 'observed'
          || !match(response.observation, binding, BOOT) || !match(this.#observer.lastObservation, binding, BOOT)) refuse();
      return response;
    } finally {
      this.#io.release(token);
    }
  }

  #find(binding) {
    const context = this.#original;
    if (!keys(binding, ORIGINAL) || !match(binding, context?.binding, ORIGINAL)) refuse();
    return context;
  }

  async capture(identities, options) {
    const original = this.#original;
    if (original?.possible || !keys(identities, IDS)
        || !IDS.every(key => uuid(identities[key])) || identities.operation_id === identities.grant_id) refuse();
    const originalIds = Object.freeze({...identities});
    const observed = this.#observer.lastObservation;
    if (!digest(observed?.connection_id) || !uuid(observed?.boot_id)) refuse();
    const binding = Object.freeze({connection_id: observed.connection_id, boot_id: observed.boot_id});
    const response = await this.#owned('capture', binding, originalIds.operation_id, options);
    const fields = captureFacts(response.capacities_oauth, binding);
    if (this.#original !== original || !digest(response.executable_sha256)) refuse();
    this.#original = {binding: Object.freeze({...fields, ...originalIds}), executable_sha256: response.executable_sha256,
      current: false, possible: false};
    return fields;
  }

  async current(binding, options) {
    const context = this.#find(binding);
    if (context.possible) return false;
    context.current = false;
    const sample = { connection_id: binding.connection_id, boot_id: binding.boot_id };
    const response = await this.#owned('capture', sample, binding.operation_id, options);
    const fields = captureFacts(response.capacities_oauth, sample);
    context.current = this.#original === context && match(fields, context.binding, CAPTURE)
      && response.executable_sha256 === context.executable_sha256;
    return context.current;
  }

  async handoff(binding, proof, options) {
    const context = this.#find(binding);
    if (!proofValid(proof) || !context.current || context.possible) refuse();
    const response = await this.#owned('exchange', context.binding, binding.operation_id, options, {
      proof, executable_sha256: context.executable_sha256,
      claim: () => {
        if (this.#original !== context || context.possible || !context.current) refuse();
        context.possible = true;
        context.current = false;
      }
    });
    const report = response.secret_disposition === 'not-sent'
      ? Object.freeze({contract_version: 1, ...context.binding, status: 'not-dispatched'})
      : originalReceipt(response.capacities_oauth, context.binding);
    if (this.#original === context && (report.status === 'committed' || report.status === 'not-dispatched')) this.#original = null;
    return report;
  }

  async status(binding, options) {
    const context = this.#find(binding);
    // The broker may have classified a local pre-child refusal conservatively.
    // The actor still reports the original operation without opening a new one.
    const response = await this.#owned('status', context.binding, binding.operation_id, options);
    const report = originalReceipt(response.capacities_oauth, context.binding);
    if (this.#original === context && report.status === 'committed') this.#original = null;
    return report;
  }
}
