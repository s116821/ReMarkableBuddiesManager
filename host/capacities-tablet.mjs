import { MaintenanceIO } from './maintenance-io.mjs';
import { performance } from 'node:perf_hooks';

const READ_MS = 12000;
const EXCHANGE_MS = 60000;
const CAPTURE = ['tablet_id', 'connection_id', 'boot_id', 'config_sha256'];
const IDS = ['operation_id', 'grant_id'];
const ORIGINAL = [...CAPTURE, ...IDS];
const BOOT = ['connection_id', 'boot_id'];
const REPORT = ['contract_version', 'status'];
const GRANT_REPORT = [...REPORT, ...ORIGINAL, 'space_id', 'phase', 'grant_sha256', 'observed_operation_id'];
const GRANT_PHASES = ['absent', 'pending-exchange', 'staged', 'active', 'pending-rotation',
  'local-disabled', 'revocation-pending', 'revoked', 'retired-unconfirmed'];
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

function captureFacts(report, expected, includeConnection = false) {
  if (!keys(report, [...REPORT, ...CAPTURE, ...(includeConnection ? ['connection'] : [])]) || report.contract_version !== 1
      || report.status !== 'captured' || !match(report, expected, BOOT)
      || !uuid(report.tablet_id) || !digest(report.config_sha256)) refuse();
  const facts = Object.fromEntries(CAPTURE.map(key => [key, report[key]]));
  if (includeConnection) {
    const connection = report.connection;
    if (connection !== null && (!keys(connection, ['space_id', 'grant_id'])
        || !uuid(connection.space_id) || !uuid(connection.grant_id))) refuse();
    facts.connection = connection === null ? null : Object.freeze({...connection});
  }
  return Object.freeze(facts);
}

function grantReceipt(report, binding, space, disconnect) {
  const statuses = disconnect ? ['refused', 'conflict', 'local-disabled', 'revoked', 'unresolved']
    : ['observed', 'conflict', 'unresolved'];
  if (!keys(report, GRANT_REPORT) || report.contract_version !== 1 || !match(report, binding, ORIGINAL)
      || report.space_id !== space || !statuses.includes(report.status)
      || (report.phase !== null && !GRANT_PHASES.includes(report.phase))
      || (report.grant_sha256 !== null && !digest(report.grant_sha256))
      || (report.observed_operation_id !== null && !uuid(report.observed_operation_id))
      || (report.status === 'observed' && report.phase === null)
      || (report.status === 'observed' && ['local-disabled', 'revocation-pending', 'revoked'].includes(report.phase)
          && !digest(report.grant_sha256))
      || (report.status === 'local-disabled' && (report.phase !== 'local-disabled' || !digest(report.grant_sha256)))
      || (report.status === 'revoked' && (report.phase !== 'revoked'
          || !digest(report.grant_sha256) || report.observed_operation_id !== binding.operation_id))) refuse();
  return Object.freeze({...report});
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

  async #owned(selector, binding, reference, { signal, deadline } = {}, write, grant) {
    const disposition = selector === 'disconnect' ? 'operation_disposition' : 'secret_disposition';
    const unstarted = () => {
      if (write) return {[disposition]: 'not-sent'};
      refuse();
    };
    if (signal?.aborted || !match(this.#observer.lastObservation, binding, BOOT)) return unstarted();
    const token = this.#io.acquire('capacities-oauth', reference, selector);
    if (!token) return unstarted();
    try {
      try { this.#beforeIO(); } catch { return unstarted(); }
      if (signal?.aborted || !this.#io.owns(token) || !match(this.#observer.lastObservation, binding, BOOT)) return unstarted();
      const budget_ms = Math.min(write ? EXCHANGE_MS : READ_MS,
        Math.floor(deadline - performance.now()) - (write ? 2000 : 1000));
      if (!Number.isSafeInteger(budget_ms) || budget_ms < (write ? 34000 : 1)) return unstarted();
      const request = { selector, budget_ms, binding, ...grant };
      if (write) {
        write.claim();
        if (selector === 'exchange') request.proof = write.proof;
        request.executable_sha256 = write.executable_sha256;
      }
      let response;
      try {
        response = await this.#observer.runCapacities(request, { signal, deadline });
      } finally {
        delete request.proof;
      }
      if (write && response?.[disposition] === 'not-sent') return response;
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

  async selectedConnection(operation, options) {
    if (this.#original?.possible || !uuid(operation)) refuse();
    const observed = this.#observer.lastObservation;
    if (!digest(observed?.connection_id) || !uuid(observed?.boot_id)) refuse();
    const original = {connection_id: observed.connection_id, boot_id: observed.boot_id};
    const response = await this.#owned('capture-connection', original, operation, options);
    const facts = captureFacts(response.capacities_oauth, original, true);
    if (!facts.connection) return null;
    if (!digest(response.executable_sha256) || operation === facts.connection.grant_id) refuse();
    const {connection, ...capture} = facts;
    const selected = Object.freeze({
      binding: Object.freeze({...capture, operation_id: operation, grant_id: connection.grant_id}),
      space: connection.space_id,
      executable: response.executable_sha256,
    });
    const report = await this.disconnectStatus(selected, options);
    return {selected, report};
  }

  async disconnectStatus(selected, options) {
    const {binding, space} = selected;
    const response = await this.#owned('grant-status', binding, binding.operation_id, options, null, {space_id: space});
    return grantReceipt(response.capacities_oauth, binding, space, false);
  }

  async disconnectConnection(selected, options, claim) {
    const {binding, space, executable, revision} = selected;
    if (this.#original?.possible || !digest(executable) || !digest(revision)) refuse();
    const response = await this.#owned('disconnect', binding, binding.operation_id, options,
      {executable_sha256: executable, claim}, {space_id: space, expected_grant_sha256: revision});
    if (response.operation_disposition === 'not-sent') return {status: 'not-dispatched'};
    return grantReceipt(response.capacities_oauth, binding, space, true);
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
