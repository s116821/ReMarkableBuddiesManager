import test from 'node:test';
import assert from 'node:assert/strict';
import {TabletDriveSetupController} from '../src/tablet-drive-setup.ts';
import {parseTabletDriveSetupResult} from '../host/tablet-drive-setup-protocol.mjs';
import {tablet} from './fixtures/owned-report.mjs';

const reference = 'b'.repeat(64), target = {connection_id: tablet.connection_id, boot_id: tablet.boot_id};
const result = (state = 'ready') => ({contract_version: 1, status: 'observed', observation: structuredClone(tablet),
  tablet_drive: {state, reference, intent: 'connect', account: {label: 'fixture@example.invalid'}, installed: false, mode: 'local-only',
    authorizationUrl: state === 'authorizing' ? 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' : null, retained: []}});

test('shared setup requires the captured target and explicit confirmation', async t => {
  const calls = [];
  const controller = new TabletDriveSetupController(async request => { calls.push(request); return result(request.action === 'confirm' ? 'verified' : 'ready'); }, () => {}, () => true);
  t.after(() => controller.dispose());
  await controller.begin(structuredClone(tablet), 'connect'); assert.equal(controller.state.view.state, 'ready');
  assert.deepEqual(calls, [{action: 'begin', ...target, intent: 'connect'}]);
  await controller.confirm(); assert.equal(controller.state.view.state, 'verified');
  await controller.confirm(); assert.equal(calls.filter(call => call.action === 'confirm').length, 1);
});

test('navigation cancels a late prepared reply without resurrecting account details', async () => {
  let release; const calls = [];
  const controller = new TabletDriveSetupController(request => {
    calls.push(request); return request.action === 'begin' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(result());
  }, () => {}, () => true);
  const pending = controller.begin(target, 'connect'); controller.hide(); release(result('authorizing')); await pending;
  assert.equal(controller.state.view, null); assert.equal(controller.state.busy, false);
  assert.deepEqual(calls.at(-1), {action: 'cancel', reference}); controller.dispose();
});

test('cancel during Confirm retains uncertainty despite late unknown replies', async () => {
  let release; const calls = [];
  const record = {...target, reference, status_available: true};
  const inventory = {contract_version: 1, status: 'unconfigured', observation: null,
    tablet_drive: {state: 'none', reference: null, intent: null, account: null, installed: null, mode: null, authorizationUrl: null, retained: [record]}};
  const unknown = {...inventory, tablet_drive: {...inventory.tablet_drive, state: 'unknown', reference, intent: 'connect'}};
  const controller = new TabletDriveSetupController(request => {
    calls.push(request);
    return request.action === 'confirm' ? new Promise(resolve => { release = value => resolve(parseTabletDriveSetupResult(value, request)); }) :
      Promise.resolve(parseTabletDriveSetupResult(request.action === 'cancel' ? unknown : request.action === 'retained' ? inventory : result(), request));
  }, () => {}, () => true);
  await controller.begin(target, 'connect');
  const pending = controller.confirm(); controller.clear();
  assert.equal(controller.state.uncertain, true); assert.equal(controller.state.busy, false);
  release(unknown); await pending;
  assert.equal(controller.state.uncertain, true); assert.equal(controller.state.view, null);
  assert.match(controller.state.status, /unknown/);
  await controller.loadRetained(); assert.equal(controller.state.uncertain, true);
  assert.deepEqual(controller.state.retained, [record]); assert.equal(controller.state.view.state, 'none');
  assert.match(controller.state.status, /unknown/);
  assert.equal(calls.filter(call => call.action === 'confirm').length, 1);
  controller.dispose();
});

test('navigation preserves dispatched Confirm and its terminal result', async () => {
  let release; const calls = [];
  const controller = new TabletDriveSetupController(request => {
    calls.push(request); return request.action === 'confirm' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(result());
  }, () => {}, () => true);
  await controller.begin(target, 'connect');
  const pending = controller.confirm(); controller.hide();
  assert.equal(controller.state.busy, true); assert.equal(calls.filter(call => call.action === 'cancel').length, 0);
  release(result('verified')); await pending;
  assert.equal(controller.state.view.state, 'verified'); assert.equal(controller.state.uncertain, false);
  controller.dispose();
});

test('target loss before a delayed reply clears the unused reference', async () => {
  let release, current = true; const calls = [];
  const controller = new TabletDriveSetupController(request => { calls.push(request); return request.action === 'begin' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(result()); }, () => {}, () => current);
  const pending = controller.begin(target, 'connect'); current = false; release(result()); await pending;
  assert.equal(controller.state.view, null); assert.equal(controller.state.busy, false);
  current = true; await controller.confirm(); assert.equal(calls.filter(call => call.action === 'confirm').length, 0); controller.dispose();
});

test('lost Confirm response retains a visible warning and never retries automatically', async () => {
  const calls = [];
  const controller = new TabletDriveSetupController(async request => {
    calls.push(request); if (request.action === 'confirm') throw Error('lost'); return result();
  }, () => {}, () => true);
  await controller.begin(target, 'connect'); await controller.confirm();
  assert.equal(controller.state.uncertain, true); assert.equal(controller.state.view, null);
  controller.clear(); assert.equal(controller.state.uncertain, true);
  await controller.confirm(); assert.equal(calls.filter(call => call.action === 'confirm').length, 1); controller.dispose();
});

test('renderer rejects credential-bearing frames and unexpected consent parameters', async () => {
  for (const value of [{...result(), access_token: 'synthetic-secret'},
    {...result('authorizing'), tablet_drive: {...result('authorizing').tablet_drive, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?code_verifier=synthetic-secret'}},
    {...result(), tablet_drive: {...result().tablet_drive, credential_b64: 'secret'}}]) {
    const controller = new TabletDriveSetupController(async () => value, () => {}, () => true);
    await controller.begin(target, 'connect'); assert.equal(controller.state.view, null);
    assert.equal(JSON.stringify(controller.state).includes('synthetic-secret'), false); controller.dispose();
  }
});

test('retained readback sends only the original reference and matching target', async () => {
  const record = {...target, reference, status_available: true}, calls = [];
  const controller = new TabletDriveSetupController(async request => { calls.push(request); return result('observed'); }, () => {}, candidate => candidate.boot_id === target.boot_id);
  await controller.check({...record, boot_id: '33333333-3333-4333-8333-333333333333'}); assert.equal(calls.length, 0);
  await controller.check(record); assert.deepEqual(calls, [{action: 'check', ...target, reference}]); controller.dispose();
});
