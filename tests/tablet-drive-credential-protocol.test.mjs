import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  parseTabletDriveOriginal, parseTabletDriveRequest, parseTabletDriveReport, tabletDriveBindingDigest
} from '../host/tablet-drive-credential-protocol.mjs';

const actor = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const collection = '44444444-4444-4444-8444-444444444444';
const operation = '55555555-5555-4555-8555-555555555555';
const credential = {
  credential_version: 1, client_id: 'synthetic-desktop-client', client_secret: null,
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: 2100000000,
  scopes: ['https://www.googleapis.com/auth/drive.appdata'], account_permission_id: 'fixture-account', collection
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binding = hash('["synthetic-desktop-client","fixture-account","44444444-4444-4444-8444-444444444444"]');
const bytes = Buffer.from(JSON.stringify(credential));
const credential_b64 = bytes.toString('base64');
const desired = {kind: 'present', sha256: hash(bytes), binding_sha256: binding, collection};
const installed = {...desired, metadata_sha256: 'f'.repeat(64)};
const absent = {kind: 'absent'};
const mode_token = {actor, sha256: 'a'.repeat(64)};
const original = {device, epoch, mode_token, mode: {kind: 'local-only'}, slot: absent,
  config_sha256: 'b'.repeat(64), credential_path_sha256: 'c'.repeat(64), parent_identity_sha256: 'd'.repeat(64)};
const inspect = {control_version: 1, action: 'inspect', expected_mode: mode_token};
const create = {control_version: 1, action: 'apply', operation, original,
  change: {kind: 'create', collection, binding_sha256: binding, credential_b64}};
const readback = {control_version: 1, action: 'readback', operation, original, desired};
const response = (action, outcome, current = null) => ({report_version: 1, action, operation: ['apply', 'readback'].includes(action) ? operation : null,
  outcome, current, disk_readback_verified: current !== null});
const frame = v => Buffer.from(JSON.stringify(v) + '\n');
const refused = /Tablet Drive credential protocol refused/;

test('private original and request preserve Buddy mode and token, with the shared tuple binding', () => {
  assert.equal(tabletDriveBindingDigest(credential), binding);
  assert.deepEqual(parseTabletDriveOriginal(original), original);
  assert.deepEqual(parseTabletDriveRequest(frame(inspect)), inspect);
  assert.deepEqual(parseTabletDriveRequest(create), create);
  const isolated = {...original, mode: {kind: 'isolated-backup', backup: epoch, binding_sha256: binding}};
  assert.deepEqual(parseTabletDriveRequest({...create, original: isolated}).original, isolated);
  const replacing = {...create, original: {...isolated, slot: {...installed, sha256: '1'.repeat(64)}},
    change: {...create.change, kind: 'replace'}};
  assert.deepEqual(parseTabletDriveRequest(replacing), replacing);
  const removal = {...replacing, change: {kind: 'remove', collection, binding_sha256: binding}};
  assert.deepEqual(parseTabletDriveReport(response('apply', 'verified', isolated), removal).current, isolated);
});

test('refuses noncanonical, cross-binding, wrong revision, or malformed credential input', () => {
  const withCredential = raw => ({...create, change: {...create.change, credential_b64: Buffer.from(raw).toString('base64')}});
  for (const request of [
    {...inspect, expected_mode: {...mode_token, actor: actor + '\n'}},
    {...create, original: {...original, mode: {kind: 'shared-group'}}},
    {...create, change: {...create.change, kind: 'replace'}},
    {...create, original: {...original, slot: installed}},
    {...create, original: {...original, mode: {kind: 'isolated-backup', backup: epoch, binding_sha256: '2'.repeat(64)}}},
    {...create, change: {...create.change, credential_b64: credential_b64 + '\n'}},
    {...create, change: {...create.change, binding_sha256: binding + '\n'}},
    withCredential(JSON.stringify({...credential, scopes: ['unexpected']})),
    withCredential(JSON.stringify({...credential, refresh_token: 'synthetic \n token'})),
    withCredential(JSON.stringify({...credential, collection: device})),
    withCredential(JSON.stringify({...credential, extra: 1})),
    withCredential('{"credential_version":1,' + bytes.toString().slice(1)),
    withCredential(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])),
    withCredential(Buffer.alloc(48 * 1024 + 1, 0x20)),
    {...readback, desired: absent},
    {...readback, original: {...original, slot: installed}}
  ]) assert.throws(() => parseTabletDriveRequest(request), refused);
  assert.throws(() => parseTabletDriveRequest(Buffer.from('{"action":"inspect","action":"readback"}')), refused);
  assert.throws(() => parseTabletDriveRequest(Buffer.concat([frame(inspect), Buffer.alloc(68 * 1024)])), refused);
});

test('accepts only action, operation, custody and revision matched evidence', () => {
  const current = {...original, slot: installed};
  const good = response('apply', 'verified', current);
  assert.deepEqual(parseTabletDriveReport(frame(good), create), good);
  assert.deepEqual(parseTabletDriveReport(response('inspect', 'observed', original), inspect).current, original);
  assert.deepEqual(parseTabletDriveReport(response('readback', 'desired-state-observed', current), readback).current, current);
  assert.deepEqual(parseTabletDriveReport(response('readback', 'original-state-observed', original), readback).current, original);
  for (const changed of [
    {...good, operation: epoch}, {...good, action: 'inspect'}, {...good, disk_readback_verified: false},
    {...good, current: {...current, device: actor}}, {...good, current: {...current, epoch: actor}},
    {...good, current: {...current, parent_identity_sha256: '1'.repeat(64)}},
    {...good, current: {...current, mode_token: {...mode_token, sha256: '1'.repeat(64)}}},
    {...good, current: {...current, slot: {...installed, sha256: '1'.repeat(64)}}},
    {...good, current: {...current, slot: {...installed, credential_b64}}},
    {...good, credential_b64}
  ]) assert.throws(() => parseTabletDriveReport(changed, create), refused);
  assert.throws(() => parseTabletDriveReport(response('inspect', 'observed', {...original,
    mode_token: {...mode_token, actor: device}}), inspect), refused);
  assert.throws(() => parseTabletDriveReport(response('readback', 'original-state-observed', current), readback), refused);
});

test('supports sanitized refusals and rejects false evidence and incomplete frames', () => {
  const refusals = [[null, 'invalid-input', create], [null, 'unsupported', inspect],
    ['apply', 'busy', create], ['apply', 'outcome-unknown', create], ['readback', 'unresolved', readback]];
  for (const [action, outcome, request] of refusals) {
    assert.deepEqual(parseTabletDriveReport(response(action, outcome), request), response(action, outcome));
  }
  for (const v of [response(null, 'busy'), response('apply', 'outcome-unknown', original),
    response('apply', 'unresolved'), response('apply', 'verified')]) {
    assert.throws(() => parseTabletDriveReport(v, create), refused);
  }
  const valid = frame(response('apply', 'verified', {...original, slot: installed}));
  for (const raw of [valid.subarray(0, -1), Buffer.concat([valid, valid]), Buffer.alloc(16 * 1024 + 1),
    Buffer.from('{"report_version":1,"report_version":1}' + '\n'), Buffer.from([0xff, 10])]) {
    assert.throws(() => parseTabletDriveReport(raw, create), refused);
  }
});
