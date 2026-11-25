// Private Buddy input and receipts. These values must never enter browser or IPC replies.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {localModeDigest, localModeUuid} from './local-mode-choice-protocol.mjs';
import {strictJson} from './strict-json.mjs';

const MAX_INPUT = 68 * 1024;
const MAX_CREDENTIAL = 48 * 1024;
const MAX_REPORT = 16 * 1024;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const REFUSALS = ['invalid-input', 'unsupported', 'busy', 'conflict', 'unavailable'];
const EVIDENCE = {
  inspect: ['observed'],
  apply: ['verified'],
  readback: ['desired-state-observed', 'original-state-observed']
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = v => localModeDigest(v) && v.length === 64;
const uuid = v => localModeUuid(v) && v.length === 36;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = valid => { if (!valid) throw Error('Tablet Drive credential protocol refused'); };

function exact(v, fields) {
  check(object(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k)));
}

function modeToken(v) {
  exact(v, ['actor', 'sha256']);
  check(uuid(v.actor) && digest(v.sha256));
}

function slot(v, metadata = false) {
  if (v?.kind === 'absent') {
    exact(v, ['kind']);
    return;
  }
  const fields = ['kind', 'sha256', 'binding_sha256', 'collection'];
  if (metadata) fields.push('metadata_sha256');
  exact(v, fields);
  check(v.kind === 'present' && digest(v.sha256) && digest(v.binding_sha256) && uuid(v.collection) &&
    (!metadata || digest(v.metadata_sha256)));
}

export function parseTabletDriveOriginal(v) {
  exact(v, ['config_sha256', 'credential_path_sha256', 'parent_identity_sha256', 'device', 'epoch', 'mode', 'mode_token', 'slot']);
  check([v.config_sha256, v.credential_path_sha256, v.parent_identity_sha256].every(digest) &&
    uuid(v.device) && uuid(v.epoch));
  modeToken(v.mode_token);
  slot(v.slot, true);
  const mode = v.mode;
  if (mode?.kind === 'local-only') {
    exact(mode, ['kind']);
  } else {
    exact(mode, ['kind', 'backup', 'binding_sha256']);
    check(mode.kind === 'isolated-backup' && uuid(mode.backup) && digest(mode.binding_sha256) &&
      (v.slot.kind === 'absent' || v.slot.binding_sha256 === mode.binding_sha256));
  }
  return structuredClone(v);
}

function sameBinding(original, proposal) {
  const {mode, slot} = original;
  check(digest(proposal.binding_sha256) && uuid(proposal.collection) &&
    (mode.kind === 'local-only' || mode.binding_sha256 === proposal.binding_sha256) &&
    (slot.kind === 'absent' || slot.binding_sha256 === proposal.binding_sha256 && slot.collection === proposal.collection));
}

function matches(slot, desired) {
  return Object.keys(desired).every(key => slot[key] === desired[key]);
}

function readJson(raw, limit, line = false) {
  check(raw instanceof Uint8Array && raw.byteLength > 0 && raw.byteLength <= limit &&
    !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) &&
    (!line || (raw.at(-1) === 10 && raw.indexOf(10) === raw.byteLength - 1)));
  try { return strictJson(raw); } catch { check(false); }
}

// Buddy hashes serde_json's [client ID, Drive permission ID, collection] tuple.
// All three fields are ASCII and the collection is canonical.
export function tabletDriveBindingDigest(credential) {
  check(object(credential) && uuid(credential.collection));
  for (const [key, limit] of [['client_id', 256], ['account_permission_id', 200]]) {
    check(secretText(credential[key], limit));
  }
  return sha256(JSON.stringify([credential.client_id, credential.account_permission_id, credential.collection]));
}

function secretText(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit &&
    !/[^\x21-\x7e]/.test(value);
}

function credentialRevision(change) {
  const encoded = change.credential_b64;
  check(typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_CREDENTIAL / 3) * 4);
  const bytes = Buffer.from(encoded, 'base64');
  try {
    check(bytes.toString('base64') === encoded);
    const value = readJson(bytes, MAX_CREDENTIAL);
    const fields = ['credential_version', 'client_id', 'access_token', 'refresh_token', 'expires_at',
      'scopes', 'account_permission_id', 'collection'];
    if (object(value) && Object.hasOwn(value, 'client_secret')) fields.push('client_secret');
    exact(value, fields);
    check(value.credential_version === 1 && Number.isSafeInteger(value.expires_at) && value.expires_at > 0 &&
      Array.isArray(value.scopes) && value.scopes.length === 1 && value.scopes[0] === SCOPE &&
      value.collection === change.collection && secretText(value.access_token, 16384) &&
      secretText(value.refresh_token, 16384) &&
      (!Object.hasOwn(value, 'client_secret') || value.client_secret === null || secretText(value.client_secret, 1024)) &&
      tabletDriveBindingDigest(value) === change.binding_sha256);
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function requestContext(v) {
  const action = v?.action;
  if (action === 'inspect') {
    exact(v, ['action', 'control_version', 'expected_mode']);
    check(v.control_version === 1);
    modeToken(v.expected_mode);
    return {action, operation: null, expected_mode: v.expected_mode};
  }
  check(action === 'apply' || action === 'readback');
  exact(v, ['action', 'control_version', 'operation', 'original', action === 'apply' ? 'change' : 'desired']);
  check(v.control_version === 1 && uuid(v.operation));
  const original = parseTabletDriveOriginal(v.original);
  let desired;
  if (action === 'apply') {
    const kind = v.change?.kind;
    check(['create', 'replace', 'remove'].includes(kind) && (kind === 'create') === (original.slot.kind === 'absent'));
    const fields = ['kind', 'collection', 'binding_sha256'];
    if (kind !== 'remove') fields.push('credential_b64');
    exact(v.change, fields);
    sameBinding(original, v.change);
    desired = kind === 'remove' ? {kind: 'absent'} : {
      kind: 'present', collection: v.change.collection, binding_sha256: v.change.binding_sha256,
      sha256: credentialRevision(v.change)
    };
  } else {
    desired = v.desired;
    slot(desired);
    if (desired.kind === 'present') sameBinding(original, desired);
  }
  check(!matches(original.slot, desired));
  return {action, operation: v.operation, original, desired};
}

export function parseTabletDriveRequest(v) {
  const request = v instanceof Uint8Array ? readJson(v, MAX_INPUT) : v;
  requestContext(request);
  check(Buffer.byteLength(JSON.stringify(request)) <= MAX_INPUT);
  return structuredClone(request);
}

export function parseTabletDriveReport(v, request) {
  const expected = requestContext(request);
  const report = v instanceof Uint8Array ? readJson(v, MAX_REPORT, true) : v;
  exact(report, ['report_version', 'action', 'operation', 'outcome', 'current', 'disk_readback_verified']);
  check(report.report_version === 1);
  const {action, operation, outcome, disk_readback_verified: verified} = report;
  let current = null;
  if (action === null) {
    check(operation === null && ['invalid-input', 'unsupported'].includes(outcome) &&
      report.current === null && verified === false);
  } else {
    check(action === expected.action && operation === expected.operation);
    const refusal = REFUSALS.includes(outcome) || (action === 'apply' && outcome === 'outcome-unknown') ||
      (action === 'readback' && outcome === 'unresolved');
    if (refusal) {
      check(report.current === null && verified === false);
    } else {
      check(EVIDENCE[action].includes(outcome) && verified === true);
      current = parseTabletDriveOriginal(report.current);
      if (action === 'inspect') {
        check(isDeepStrictEqual(current.mode_token, expected.expected_mode));
      } else {
        check(Object.keys(current).every(key => key === 'slot' || isDeepStrictEqual(current[key], expected.original[key])));
        check(outcome === 'original-state-observed' ? isDeepStrictEqual(current.slot, expected.original.slot) :
          matches(current.slot, expected.desired));
      }
    }
  }
  return {report_version: 1, action, operation, outcome, current, disk_readback_verified: verified};
}
