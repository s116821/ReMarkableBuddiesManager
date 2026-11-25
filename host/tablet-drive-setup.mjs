import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {MaintenanceIO} from './maintenance-io.mjs';
import {strictJson} from './strict-json.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseLocalModeReport, localModeDigest, localModeUuid} from './local-mode-choice-protocol.mjs';
import {parseDriveBegin} from './drive-protocol.mjs';
import {parseTabletDriveRequest, parseTabletDriveReport} from './tablet-drive-credential-protocol.mjs';
import {parseTabletDriveSetupRequest, parseTabletDriveSetupResult} from './tablet-drive-setup-protocol.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => a && b && a.connection_id === b.connection_id && a.boot_id === b.boot_id;
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
const refuse = () => { throw Error('Tablet Drive operation unavailable'); };

export class TabletDriveSetupHost {
  #setup = null;
  #active = null;
  #records = new Map();
  #bindings = [];
  #epoch = 0;
  #issued = new WeakMap();
  #recordDigest = null;
  #disposed = false;

  constructor({observer, driveAuth, io = new MaintenanceIO(), beforeIO = () => {}, now = () => performance.now(),
    store = driveAuth?.store, wallNow = Date.now, uuid = randomUUID, reference = () => randomBytes(32).toString('hex'), budgetMs = 13000} = {}) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 13000) refuse();
    Object.assign(this, {observer, driveAuth, store, io, beforeIO, now, wallNow, uuid, reference, budgetMs});
  }

  #erase(setup) {
    clearTimeout(setup.timer);
    setup.timer = null;
    setup.input?.fill(0);
    setup.input = null;
    if (setup.authGeneration === this.driveAuth.generation && !setup.authorizationTaken) this.driveAuth.cancel();
    setup.authorizationUrl = null;
  }

  invalidate() {
    this.#epoch++;
    const active = this.#active;
    if (active) {
      for (const buffer of active.buffers) buffer.fill(0);
      this.io.release(active.token);
    }
    this.#active = null;
    if (this.#setup) this.#erase(this.#setup);
    this.#setup = null;
  }

  dispose() { this.#disposed = true; this.invalidate(); this.#records.clear(); }

  #expire() {
    if (this.#setup && this.now() >= this.#setup.deadline) this.invalidate();
  }

  #record(setup) {
    return {reference: setup.reference, connection_id: setup.sample.connection_id, boot_id: setup.sample.boot_id,
      intent: setup.intent, readback: structuredClone(setup.readback)};
  }

  #loadRecords() {
    const loaded = this.store.tabletDriveOperations();
    if (keys(loaded) !== 'digest,value' || loaded.digest !== null && !/^[a-f0-9]{64}$/.test(loaded.digest)) refuse();
    if (loaded.value === null) {
      if (loaded.digest !== null) refuse();
      this.#records.clear(); this.#bindings = []; this.#recordDigest = null; return;
    }
    const value = loaded.value;
    if (!loaded.digest || keys(value) !== 'bindings,originals,version' || value.version !== 1 || !Array.isArray(value.originals) ||
        value.originals.length > 8 || !Array.isArray(value.bindings) || value.bindings.length > 8 ||
        Buffer.byteLength(JSON.stringify(value)) + 1 > 40 * 1024) refuse();
    const identities = new Set();
    for (const binding of value.bindings) {
      if (keys(binding) !== 'binding_sha256,collection,connection_id,device' ||
          ![binding.binding_sha256, binding.connection_id].every(localModeDigest) ||
          ![binding.collection, binding.device].every(localModeUuid)) refuse();
      const identity = `${binding.connection_id}/${binding.device}`;
      if (identities.has(identity)) refuse();
      identities.add(identity);
    }
    const next = new Map(), targets = new Set();
    for (const record of value.originals) {
      if (keys(record) !== 'boot_id,connection_id,intent,readback,reference' || Buffer.byteLength(JSON.stringify(record)) > 4096) refuse();
      parseTabletDriveSetupRequest({action: 'begin', connection_id: record.connection_id, boot_id: record.boot_id, intent: record.intent});
      parseTabletDriveSetupRequest({action: 'cancel', reference: record.reference});
      const readback = parseTabletDriveRequest(record.readback);
      if (readback.action !== 'readback' || (record.intent === 'connect') !== (readback.desired.kind === 'present') ||
          next.has(record.reference) || targets.has(record.connection_id)) refuse();
      const prior = this.#records.get(record.reference);
      const setup = prior && isDeepStrictEqual(this.#record(prior), record) ? prior : {
        reference: record.reference, intent: record.intent, sample: {connection_id: record.connection_id, boot_id: record.boot_id},
        readback, authorizationTaken: true};
      next.set(record.reference, setup); targets.add(record.connection_id);
      identities.add(`${record.connection_id}/${readback.original.device}`);
    }
    if (identities.size > 8) refuse();
    this.#records = next; this.#bindings = structuredClone(value.bindings); this.#recordDigest = loaded.digest;
  }

  #saveRecords(records, bindings = this.#bindings) {
    const result = this.store.saveTabletDriveOperations({version: 1, originals: records, bindings}, this.#recordDigest);
    if (result.committed !== true || typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.digest)) refuse();
    this.#recordDigest = result.digest; this.#bindings = structuredClone(bindings);
  }

  #retain(setup) {
    this.#loadRecords();
    if (this.#records.size >= 8 || !this.#hasBindingCapacity(setup) ||
        [...this.#records.values()].some(record => record.sample.connection_id === setup.sample.connection_id)) refuse();
    this.#saveRecords([...this.#records.values()].map(record => this.#record(record)).concat(this.#record(setup)));
    this.#records.set(setup.reference, setup);
  }

  #hasBindingCapacity(setup) {
    const pairs = new Set(this.#bindings.map(binding => `${binding.connection_id}/${binding.device}`));
    for (const record of this.#records.values()) pairs.add(`${record.sample.connection_id}/${record.readback.original.device}`);
    pairs.add(`${setup.sample.connection_id}/${setup.original.device}`);
    return pairs.size <= 8;
  }

  #resolve(setup, observed = false) {
    this.#loadRecords();
    const retained = this.#records.get(setup.reference);
    if (!retained || !isDeepStrictEqual(this.#record(retained), this.#record(setup))) refuse();
    let bindings = this.#bindings;
    if (observed) {
      const slot = setup.current.slot.kind === 'present' ? setup.current.slot : setup.readback.original.slot;
      if (slot.kind === 'present') {
        const binding = {connection_id: setup.sample.connection_id, device: setup.readback.original.device,
          collection: slot.collection, binding_sha256: slot.binding_sha256};
        bindings = bindings.filter(value => value.connection_id !== binding.connection_id || value.device !== binding.device).concat(binding);
        if (bindings.length > 8) refuse();
      }
    }
    this.#saveRecords([...this.#records.values()].filter(record => record.reference !== setup.reference).map(record => this.#record(record)), bindings);
    this.#records.delete(setup.reference);
  }

  #value(state, setup = null, observed = false) {
    const current = observed ? setup.current : null;
    const value = {contract_version: 1, status: observed ? 'observed' : 'unconfigured',
      observation: observed ? structuredClone(setup.sample) : null,
      tablet_drive: {state, reference: setup?.reference ?? null, intent: setup?.intent ?? null,
        account: observed && setup.account ? {...setup.account} : null,
        installed: current ? current.slot.kind === 'present' : null, mode: current?.mode.kind ?? null,
        authorizationUrl: state === 'authorizing' ? setup.authorizationUrl : null,
        retained: [...this.#records.values()].map(record => ({reference: record.reference,
          connection_id: record.sample.connection_id, boot_id: record.sample.boot_id, status_available: !!record.readback}))}};
    this.#issued.set(value, this.#epoch);
    return value;
  }

  assertCurrent(value) {
    this.#expire();
    if (value.status === 'observed' && this.#issued.get(value) !== this.#epoch) refuse();
    if (['ready', 'authorizing'].includes(value.tablet_drive.state) && this.#setup?.reference !== value.tablet_drive.reference) refuse();
    return value;
  }

  #current(setup, request) {
    return setup && same(setup.sample, request) && same(setup.sample, this.observer.lastObservation);
  }

  #authFingerprint() {
    const snapshot = this.driveAuth.snapshot();
    if (!snapshot.config || !snapshot.saved) refuse();
    return {generation: this.driveAuth.generation, client: snapshot.clientRecord.digest, grant: snapshot.grantRecord.digest};
  }

  #authorized(setup) {
    return setup.intent === 'remove' || isDeepStrictEqual(setup.authorization, this.#authFingerprint());
  }

  #stale(token, epoch) { return epoch !== this.#epoch || !this.io.owns(token); }

  async #owned(setup, operation, handler) {
    const token = this.io.acquire('tablet-drive-setup', setup.reference, operation);
    if (!token) return this.#value('busy', setup);
    const deadline = this.now() + this.budgetMs;
    const active = {token, setup, buffers: []};
    this.#active = active;
    const timer = setTimeout(() => {
      if (this.io.owns(token)) { this.invalidate(); this.observer.cancel(); }
    }, this.budgetMs);
    try {
      this.beforeIO();
      return await handler(token, this.#epoch, deadline);
    } finally {
      clearTimeout(timer);
      for (const buffer of active.buffers) buffer.fill(0);
      this.io.release(token);
      if (this.#active === active) this.#active = null;
    }
  }

  async #raw(selector, input, sample, deadline) {
    const budget_ms = Math.min(12000, Math.floor(deadline - this.now()));
    if (budget_ms < 1 || input && input.length > 68 * 1024) refuse();
    const request = {connection_id: sample.connection_id, boot_id: sample.boot_id, selector,
      input_base64: input === null ? null : input.toString('base64'), budget_ms};
    if (Buffer.byteLength(JSON.stringify(request)) > 96 * 1024) refuse();
    let value, timer;
    try {
      value = await Promise.race([this.observer.run('local-mode-choice', request), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Tablet Drive operation expired')), Math.max(1, deadline - this.now()));
      })]);
    } finally { clearTimeout(timer); request.input_base64 = null; }
    if (this.now() >= deadline || keys(value) !== 'contract_version,local_mode_raw,observation,status' ||
        Buffer.byteLength(JSON.stringify(value)) > 24576) refuse();
    validateResult({contract_version: value.contract_version, status: value.status, observation: value.observation});
    const raw = value.local_mode_raw;
    if (keys(raw) !== 'status,stdout_base64' || raw.status !== 'reported' || value.status !== 'observed' || !same(value.observation, sample)) {
      const error = Error('Tablet Drive transport unavailable');
      error.unsupported = raw?.status === 'unsupported';
      throw error;
    }
    if (typeof raw.stdout_base64 !== 'string') refuse();
    const bytes = Buffer.from(raw.stdout_base64, 'base64');
    this.#active?.buffers.push(bytes);
    if (bytes.length > 16384 || bytes.toString('base64') !== raw.stdout_base64 || bytes.at(-1) !== 10 ||
        bytes.filter(byte => byte === 10).length !== 1) refuse();
    return strictJson(bytes);
  }

  async #credential(request, setup, deadline) {
    parseTabletDriveRequest(request);
    const input = Buffer.from(JSON.stringify(request));
    this.#active?.buffers.push(input);
    try { return parseTabletDriveReport(await this.#raw('drive-credential', input, setup.sample, deadline), request); }
    finally { input.fill(0); }
  }

  #prepare(setup, change, desired) {
    const operation = this.uuid();
    const request = {control_version: 1, action: 'apply', operation, original: setup.original, change};
    parseTabletDriveRequest(request);
    setup.input = Buffer.from(JSON.stringify(request));
    setup.readback = {control_version: 1, action: 'readback', operation, original: structuredClone(setup.original), desired};
    setup.state = 'ready';
    setup.deadline = Math.min(setup.deadline, this.now() + 120000);
    clearTimeout(setup.timer);
    setup.timer = setTimeout(() => this.#expire(), Math.max(1, setup.deadline - this.now()));
    setup.timer.unref?.();
  }

  async request(value) {
    const request = parseTabletDriveSetupRequest(value);
    if (this.#disposed) return this.#value('unavailable');
    this.#expire();
    if (request.action !== 'cancel') {
      try { this.#loadRecords(); } catch { return this.#value('unavailable'); }
    }
    let result;
    if (request.action === 'retained') result = this.#value('none');
    else if (request.action === 'cancel') result = this.#cancel(request);
    else if (request.action === 'begin') result = await this.#begin(request);
    else if (request.action === 'poll') result = this.#poll(request);
    else if (request.action === 'confirm') result = await this.#confirm(request);
    else result = await this.#check(request);
    parseTabletDriveSetupResult(result, request);
    return this.assertCurrent(result);
  }

  async #begin(request) {
    if (!same(request, this.observer.lastObservation)) return this.#value('unavailable');
    const unresolved = [...this.#records.values()].find(record => record.sample.connection_id === request.connection_id);
    if (unresolved) return this.#value('unknown', unresolved);
    if (this.#records.size >= 8) return this.#value('capacity');
    if (this.#active) return this.#value('busy');
    this.invalidate();
    const setup = {reference: this.reference(), intent: request.intent, sample: structuredClone(this.observer.lastObservation),
      deadline: this.now() + 300000, state: 'inspecting', authorizationTaken: false};
    if (this.#records.has(setup.reference)) return this.#value('unavailable');
    this.#setup = setup;
    const inspected = await this.#owned(setup, 'begin', async (token, epoch, deadline) => {
      try {
        const mode = parseLocalModeReport(await this.#raw('inspect', null, setup.sample, deadline), 'inspect');
        if (this.#stale(token, epoch)) return this.#value('invalidated');
        if (mode.status !== 'ok' || mode.incomplete || !['local-only', 'isolated-backup'].includes(mode.current.kind)) refuse();
        const report = await this.#credential({control_version: 1, action: 'inspect', expected_mode: mode.token}, setup, deadline);
        if (this.#stale(token, epoch)) return this.#value('invalidated');
        if (report.outcome !== 'observed') return this.#value(report.outcome === 'busy' ? 'busy' : report.outcome === 'unsupported' ? 'unsupported' : 'unavailable');
        setup.original = structuredClone(report.current);
        setup.current = structuredClone(report.current);
        if (!this.#hasBindingCapacity(setup)) return this.#value('capacity');
        if (request.intent === 'connect') {
          const original = setup.original;
          if (original.slot.kind === 'present') setup.collection = original.slot.collection;
          else if (original.mode.kind === 'isolated-backup') {
            const binding = this.#bindings.find(value => value.connection_id === setup.sample.connection_id &&
              value.device === original.device && value.binding_sha256 === original.mode.binding_sha256);
            if (!binding) return this.#value('recovery-required');
            setup.collection = binding.collection;
          } else setup.collection = this.uuid();
        }
        if (request.intent === 'remove') {
          const slot = setup.original.slot;
          if (slot.kind !== 'present') refuse();
          this.#prepare(setup, {kind: 'remove', collection: slot.collection, binding_sha256: slot.binding_sha256}, {kind: 'absent'});
        }
        return null;
      } catch (error) { return this.#value(error.unsupported ? 'unsupported' : 'unavailable'); }
    });
    if (inspected) { if (this.#setup === setup) this.invalidate(); return inspected; }
    if (this.#setup !== setup) return this.#value('invalidated');
    if (request.intent === 'remove') return this.#value('ready', setup, true);
    const epoch = this.#epoch;
    try {
      const pending = this.driveAuth.beginTabletAuthorization();
      setup.authGeneration = this.driveAuth.generation;
      const authorization = parseDriveBegin(await pending);
      if (this.#epoch !== epoch || this.#setup !== setup) { this.#erase(setup); return this.#value('invalidated'); }
      if (!authorization.authorizationUrl) refuse();
      setup.authorizationUrl = authorization.authorizationUrl;
      setup.state = 'authorizing';
      setup.timer = setTimeout(() => this.#expire(), Math.max(1, setup.deadline - this.now()));
      setup.timer.unref?.();
      return this.#value('authorizing', setup, true);
    } catch { if (this.#setup === setup) this.invalidate(); return this.#value('unavailable'); }
  }

  #poll(request) {
    const setup = this.#setup;
    if (!setup || setup.reference !== request.reference) return this.#value('unavailable');
    if (!this.#current(setup, request)) { this.invalidate(); return this.#value('invalidated'); }
    if (setup.state === 'ready') {
      try { if (!this.#authorized(setup)) refuse(); }
      catch { this.invalidate(); return this.#value('invalidated'); }
      return this.#value('ready', setup, true);
    }
    if (setup.state !== 'authorizing' || setup.authGeneration !== this.driveAuth.generation) { this.invalidate(); return this.#value('invalidated'); }
    const status = this.driveAuth.tabletAuthorizationStatus();
    if (status.status === 'connecting') return this.#value('authorizing', setup, true);
    if (status.status !== 'ready') { this.invalidate(); return this.#value(status.status === 'expired' ? 'expired' : 'unavailable'); }
    let credentialBytes;
    try {
      setup.authorization = this.#authFingerprint();
      const collection = setup.collection;
      const credential = this.driveAuth.takeTabletAuthorization(status.reference, collection);
      setup.authorizationTaken = true;
      if (!credential || !this.#authorized(setup)) refuse();
      const binding_sha256 = hash(JSON.stringify([credential.client_id, credential.account_permission_id, collection]));
      if (setup.original.slot.kind === 'present' && setup.original.slot.binding_sha256 !== binding_sha256 ||
          setup.original.mode.kind === 'isolated-backup' && setup.original.mode.binding_sha256 !== binding_sha256) refuse();
      credentialBytes = Buffer.from(JSON.stringify(credential));
      if (credentialBytes.length > 48 * 1024 || !Number.isSafeInteger(credential.expires_at) || credential.expires_at * 1000 <= this.wallNow()) refuse();
      setup.deadline = Math.min(setup.deadline, this.now() + credential.expires_at * 1000 - this.wallNow());
      setup.account = status.account;
      this.#prepare(setup, {kind: setup.original.slot.kind === 'absent' ? 'create' : 'replace', collection,
        binding_sha256, credential_b64: credentialBytes.toString('base64')},
      {kind: 'present', sha256: hash(credentialBytes), collection, binding_sha256});
      return this.#value('ready', setup, true);
    } catch { this.invalidate(); return this.#value('unavailable'); }
    finally { credentialBytes?.fill(0); }
  }

  async #confirm(request) {
    const setup = this.#setup, retained = this.#records.get(request.reference);
    if (retained) return this.#value('unknown', retained);
    if (!setup || setup.reference !== request.reference || setup.state !== 'ready') return this.#value('unavailable');
    if (!this.#current(setup, request)) { this.invalidate(); return this.#value('invalidated'); }
    return this.#owned(setup, 'confirm', async (token, epoch, deadline) => {
      let possible = false;
      try {
        if (!this.#authorized(setup)) refuse();
        const inspected = await this.#credential({control_version: 1, action: 'inspect', expected_mode: setup.original.mode_token}, setup, deadline);
        if (this.#stale(token, epoch) || this.now() >= setup.deadline || !this.#authorized(setup) || inspected.outcome !== 'observed' ||
            !isDeepStrictEqual(inspected.current, setup.original)) refuse();
        const input = setup.input;
        if (!input) refuse();
        const original = parseTabletDriveRequest(strictJson(input));
        this.#retain(setup);
        if (this.#stale(token, epoch) || this.now() >= deadline || this.now() >= setup.deadline || !this.#authorized(setup)) refuse();
        possible = true;
        setup.state = 'unknown';
        const report = parseTabletDriveReport(await this.#raw('drive-credential', input, setup.sample, Math.min(deadline, setup.deadline)), original);
        if (this.#stale(token, epoch)) return this.#value('unknown', setup);
        if (report.outcome === 'verified') {
          setup.current = report.current;
          this.#resolve(setup, true);
          if (this.#stale(token, epoch) || this.now() >= deadline) return this.#value('unavailable');
          return this.#value('verified', setup, true);
        }
        if (['invalid-input', 'unsupported', 'unavailable', 'busy', 'conflict'].includes(report.outcome)) {
          this.#resolve(setup);
          return this.#value('refused', setup);
        }
        return this.#value('unknown', setup);
      } catch { return this.#value(this.#records.has(setup.reference) ? 'unknown' : possible ? 'unavailable' : 'refused', setup); }
      finally { this.#erase(setup); if (this.#setup === setup) this.#setup = null; }
    });
  }

  async #check(request) {
    const setup = this.#records.get(request.reference);
    if (!setup?.readback || !this.#current(setup, request)) return this.#value('unavailable');
    setup.sample = structuredClone(this.observer.lastObservation);
    return this.#owned(setup, 'check', async (token, epoch, deadline) => {
      try {
        const report = await this.#credential(setup.readback, setup, deadline);
        this.#expire();
        if (this.#stale(token, epoch) || !setup.readback) return this.#value('unknown', setup);
        if (['desired-state-observed', 'original-state-observed'].includes(report.outcome)) {
          setup.current = report.current;
          this.#resolve(setup, true);
          if (this.#stale(token, epoch) || this.now() >= deadline) return this.#value('unavailable');
          return this.#value(report.outcome === 'desired-state-observed' ? 'observed' : 'unchanged', setup, true);
        }
        return this.#value('unresolved', setup);
      } catch { return this.#value(this.#records.has(setup.reference) ? 'unknown' : 'unavailable', setup); }
    });
  }

  #cancel(request) {
    const setup = this.#setup?.reference === request.reference ? this.#setup : this.#records.get(request.reference);
    if (!setup) return this.#value('unavailable');
    const active = this.#active;
    if (active?.setup === setup && this.io.owns(active.token)) { this.invalidate(); this.observer.cancel(); }
    else if (this.#setup === setup) this.invalidate();
    return this.#value(this.#records.has(setup.reference) ? 'unknown' : 'cancelled', setup);
  }
}
