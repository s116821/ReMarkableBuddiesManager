import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {TabletDriveSetupHost} from '../../host/tablet-drive-setup.mjs';
import {MaintenanceIO} from '../../host/maintenance-io.mjs';
import {tablet} from './owned-report.mjs';
import {DRIVE_SCOPE} from '../../host/drive-auth.mjs';
import {unavailableDrive} from '../../host/drive-protocol.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
export const identity = {connection_id: tablet.connection_id, boot_id: tablet.boot_id};
export const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic';

// In-memory semantic peers only. Real-library authorization has its own suite;
// these cases establish host ownership, never provider or installed behavior.
export function fixture(options = {}) {
  let time = 0, sequence = 10, authReady = false, resolveApply;
  const calls = [], io = new MaintenanceIO(), wall = Date.now();
  const store = options.store ?? {value: null, digest: null,
    tabletDriveOperations() { return {value: structuredClone(this.value), digest: this.digest}; },
    saveTabletDriveOperations(value, expectedDigest) {
      if (expectedDigest !== this.digest || this.refuseSave) return {committed: false, digest: this.digest};
      const byReference = new Map((this.value?.originals ?? []).map(entry => [entry.reference, entry]));
      const byConnection = new Set((this.value?.originals ?? []).map(entry => entry.connection_id));
      const targets = new Set(value.bindings.map(entry => entry.connection_id + '/' + entry.device));
      if (targets.size !== value.bindings.length || new Set(value.originals.map(entry => entry.reference)).size !== value.originals.length ||
          new Set(value.originals.map(entry => entry.connection_id)).size !== value.originals.length) {
        return {committed: false, digest: this.digest};
      }
      for (const entry of value.originals) {
        const previous = byReference.get(entry.reference);
        if (previous ? !isDeepStrictEqual(previous, entry) : byConnection.has(entry.connection_id)) {
          return {committed: false, digest: this.digest};
        }
        targets.add(entry.connection_id + '/' + entry.readback.original.device);
      }
      if (targets.size > 8) return {committed: false, digest: this.digest};
      this.value = structuredClone(value); this.digest = hash(JSON.stringify(value));
      return {committed: true, digest: this.digest};
    }};
  const original = {config_sha256: hash('config'), credential_path_sha256: hash('path'), parent_identity_sha256: hash('parent'),
    device: id(1), epoch: id(2), mode: {kind: 'local-only'}, mode_token: {actor: id(3), sha256: hash('mode')}, slot: {kind: 'absent'}};
  const credential = {credential_version: 1, client_id: 'synthetic-client.apps.googleusercontent.com', client_secret: 'synthetic-client-secret',
    access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: Math.floor(wall / 1000) + 3600,
    scopes: [DRIVE_SCOPE], account_permission_id: 'synthetic-account', collection: id(9)};
  const binding = collection => hash(JSON.stringify([credential.client_id, credential.account_permission_id, collection]));
  if (options.present) original.slot = {kind: 'present', sha256: hash('old'), metadata_sha256: hash('metadata'),
    collection: id(9), binding_sha256: options.wrongBinding ? hash('wrong') : binding(id(9))};
  if (options.isolated) original.mode = {kind: 'isolated-backup', backup: id(5), binding_sha256: binding(id(9))};
  const auth = {store, generation: 0, takes: 0, cancels: 0, digest: hash('grant'), dispose() {},
    snapshot: () => ({config: {}, saved: {}, clientRecord: {digest: hash('client')}, grantRecord: {digest: auth.digest}}),
    beginTabletAuthorization: async () => { auth.generation++; return {state: {...unavailableDrive(), status: 'connecting', error: null},
      authorizationUrl: consentUrl}; },
    ownsAuthorizationUrl: url => url === consentUrl,
    cancel: () => { auth.cancels++; auth.generation++; },
    tabletAuthorizationStatus: () => ({status: authReady ? 'ready' : 'connecting', reference: hash('grant-ref'), account: authReady ? {label: 'Synthetic account'} : null}),
    takeTabletAuthorization: (reference, collection) => { assert.equal(reference, hash('grant-ref')); auth.takes++; return {...credential, collection}; }};
  const observer = {lastObservation: structuredClone(tablet), cancels: 0, cancel() { this.cancels++; },
    async run(action, envelope) {
      assert.equal(action, 'local-mode-choice');
      const request = envelope.input_base64 === null ? null : JSON.parse(Buffer.from(envelope.input_base64, 'base64'));
      calls.push({selector: envelope.selector, request});
      let report;
      if (envelope.selector === 'inspect') report = {report_version: 1, operation: 'inspect', status: 'ok', incomplete: false,
        activation_performed: false, data: {current_snapshot: {device: original.device, epoch: original.epoch, mode: original.mode, token: original.mode_token}, receipt: null, receipt_status: null}};
      else {
        assert.equal(envelope.selector, 'drive-credential');
        if (request.action === 'inspect') report = {report_version: 1, action: 'inspect', operation: null, outcome: 'observed', current: structuredClone(original), disk_readback_verified: true};
        else if (request.action === 'apply') {
          const change = request.change;
          if (change.kind === 'remove') original.slot = {kind: 'absent'};
          else original.slot = {kind: 'present', sha256: hash(Buffer.from(change.credential_b64, 'base64')), metadata_sha256: hash('new-metadata'),
            binding_sha256: change.binding_sha256, collection: change.collection};
          report = {report_version: 1, action: 'apply', operation: request.operation, outcome: 'verified', current: structuredClone(original), disk_readback_verified: true};
          if (options.delayApply) await new Promise(resolve => { resolveApply = resolve; });
          if (options.lostReply) throw Error('synthetic lost reply');
          if (options.badReport) report.operation = id(999);
        } else {
          assert.equal(request.action, 'readback');
          report = {report_version: 1, action: 'readback', operation: request.operation,
            outcome: options.unresolved ? 'unresolved' : 'desired-state-observed', current: options.unresolved ? null : structuredClone(original), disk_readback_verified: !options.unresolved};
        }
      }
      return {contract_version: 1, status: 'observed', observation: structuredClone(tablet),
        local_mode_raw: {status: 'reported', stdout_base64: Buffer.from(JSON.stringify(report) + '\n').toString('base64')}};
    }};
  const host = new TabletDriveSetupHost({observer, driveAuth: auth, store, io, now: () => time, wallNow: () => wall + time,
    uuid: () => id(sequence++), reference: () => hash(String(sequence++)), budgetMs: 1000});
  const begin = intent => host.request({action: 'begin', ...identity, intent: intent ?? 'connect'});
  const request = (action, reference) => host.request({action, ...identity, reference});
  const ready = async () => { const started = await begin(); authReady = true; return request('poll', started.tablet_drive.reference); };
  return {host, auth, store, observer, io, calls, original, credential, begin, request, ready,
    setAuthReady: () => { authReady = true; }, setClock: value => { time = value; },
    release: () => resolveApply?.(), get applyCount() { return calls.filter(call => call.request?.action === 'apply').length; }};
}
