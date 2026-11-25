import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTabletDriveSetupRequest, parseTabletDriveSetupResult} from '../host/tablet-drive-setup-protocol.mjs';
import {tablet} from './fixtures/owned-report.mjs';
import {fixture, hash, id, identity} from './fixtures/tablet-drive-setup.mjs';

test('connect binds consent to the original target and writes once without returning secrets', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const start = await f.begin();
  assert.equal(start.tablet_drive.state, 'authorizing'); assert.equal(f.io.ownerFor('tablet-drive-setup', start.tablet_drive.reference), null);
  assert.equal((await f.request('poll', start.tablet_drive.reference)).tablet_drive.state, 'authorizing');
  const ready = await f.ready(), reference = ready.tablet_drive.reference;
  assert.equal(ready.tablet_drive.state, 'ready'); assert.equal(f.auth.takes, 1); assert.equal(f.applyCount, 0);
  const saved = await f.request('confirm', reference);
  assert.equal(saved.tablet_drive.state, 'verified'); assert.equal(saved.tablet_drive.installed, true);
  await f.request('confirm', reference); assert.equal(f.applyCount, 1);
  const output = JSON.stringify([start, ready, saved]);
  for (const secret of ['synthetic-access', 'synthetic-refresh', 'synthetic-client-secret', 'account_permission_id', 'binding_sha256', 'credential_b64', 'mode_token']) assert.equal(output.includes(secret), false);
});

test('reconnection keeps collection and same account binding; wrong binding cannot reach Apply', async t => {
  for (const options of [{present: true}, {present: true, isolated: true}, {present: true, wrongBinding: true}]) {
    const f = fixture(options); t.after(() => f.host.dispose());
    const ready = await f.ready();
    if (options.wrongBinding) { assert.equal(ready.tablet_drive.state, 'unavailable'); assert.equal(f.applyCount, 0); continue; }
    assert.equal((await f.request('confirm', ready.tablet_drive.reference)).tablet_drive.state, 'verified');
    assert.equal(f.original.slot.collection, id(9));
  }
});

test('isolated remove and reconnect retain collection across host restart; missing provenance refuses before consent', async t => {
  const f = fixture({present: true, isolated: true}); t.after(() => f.host.dispose());
  const removal = await f.begin('remove'); await f.request('confirm', removal.tablet_drive.reference);
  assert.equal(f.store.value.bindings[0].collection, id(9)); f.host.dispose();
  const resumed = fixture({store: f.store, isolated: true}); t.after(() => resumed.host.dispose());
  const ready = await resumed.ready(); assert.equal(ready.tablet_drive.state, 'ready');
  assert.equal((await resumed.request('confirm', ready.tablet_drive.reference)).tablet_drive.state, 'verified');
  assert.equal(resumed.original.slot.collection, id(9));
  const missing = fixture({isolated: true}); t.after(() => missing.host.dispose());
  assert.equal((await missing.begin()).tablet_drive.state, 'recovery-required');
  assert.equal(missing.auth.generation, 0); assert.equal(missing.auth.takes, 0); assert.equal(missing.applyCount, 0);
});

test('remove requires an inspected present slot and never opens OAuth or changes mode', async t => {
  const f = fixture({present: true, isolated: true}); t.after(() => f.host.dispose());
  const ready = await f.begin('remove'); assert.equal(ready.tablet_drive.state, 'ready');
  assert.equal((await f.request('confirm', ready.tablet_drive.reference)).tablet_drive.installed, false);
  assert.equal(f.auth.generation, 0); assert.equal(f.original.mode.kind, 'isolated-backup');
  const empty = fixture(); t.after(() => empty.host.dispose());
  assert.equal((await empty.begin('remove')).tablet_drive.state, 'unavailable'); assert.equal(empty.applyCount, 0);
});

test('credential, mode, account and target drift refuse before Apply', async t => {
  for (const mutate of [f => { f.original.slot = {kind: 'present', sha256: hash('foreign'), metadata_sha256: hash('foreign'), collection: id(9), binding_sha256: hash('foreign')}; },
    f => { f.original.epoch = id(999); }, f => { f.auth.digest = hash('changed'); }, f => { f.observer.lastObservation.boot_id = id(999); }]) {
    const f = fixture(); t.after(() => f.host.dispose()); const ready = await f.ready(); mutate(f);
    assert.notEqual((await f.request('confirm', ready.tablet_drive.reference)).tablet_drive.state, 'verified'); assert.equal(f.applyCount, 0);
  }
});

test('detected target loss and OAuth supersession retire an unused preview permanently', async t => {
  for (const action of ['poll', 'confirm']) {
    const f = fixture(); t.after(() => f.host.dispose()); const ready = await f.ready(), reference = ready.tablet_drive.reference;
    f.observer.lastObservation = null;
    assert.equal((await f.request(action, reference)).tablet_drive.state, 'invalidated');
    f.observer.lastObservation = structuredClone(tablet);
    await f.request('confirm', reference); assert.equal(f.applyCount, 0);
  }
  for (const mutate of [f => { f.auth.generation++; }, f => { f.auth.digest = hash('replacement'); }]) {
    const f = fixture(); t.after(() => f.host.dispose()); const ready = await f.ready(); mutate(f);
    assert.equal((await f.request('poll', ready.tablet_drive.reference)).tablet_drive.state, 'invalidated');
    await f.request('confirm', ready.tablet_drive.reference); assert.equal(f.applyCount, 0);
  }
});

test('lost or mismatched reply retains original readback and never retries Apply', async t => {
  for (const options of [{lostReply: true}, {badReport: true}]) {
    const f = fixture(options); t.after(() => f.host.dispose()); const ready = await f.ready(), reference = ready.tablet_drive.reference;
    assert.equal((await f.request('confirm', reference)).tablet_drive.state, 'unknown');
    assert.equal((await f.begin()).tablet_drive.state, 'unknown');
    await f.request('confirm', reference); assert.equal(f.applyCount, 1);
    const checked = await f.request('check', reference);
    assert.equal(checked.tablet_drive.state, 'observed'); assert.equal(checked.tablet_drive.retained.length, 0);
    assert.equal(f.calls.at(-1).request.action, 'readback');
    assert.equal(JSON.stringify(f.calls.at(-1)).includes('synthetic-refresh'), false);
  }
});

test('cancellation during Apply retains uncertainty and late success cannot release a different owner', async t => {
  const f = fixture({delayApply: true}); t.after(() => f.host.dispose()); const ready = await f.ready(), reference = ready.tablet_drive.reference;
  const pending = f.request('confirm', reference);
  while (f.applyCount === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.host.request({action: 'cancel', reference})).tablet_drive.state, 'unknown');
  const other = f.io.acquire('other', 'other', 'work'); assert.ok(other);
  f.release(); assert.equal((await pending).tablet_drive.state, 'unknown'); assert.equal(f.io.owns(other), true);
  f.io.release(other);
});

test('expired and cancelled previews are not dispatched; competing maintenance preserves preview', async t => {
  const f = fixture(); t.after(() => f.host.dispose()); let ready = await f.ready();
  const other = f.io.acquire('other', 'other', 'work');
  assert.equal((await f.request('confirm', ready.tablet_drive.reference)).tablet_drive.state, 'busy'); assert.equal(f.io.owns(other), true);
  f.io.release(other); f.setClock(120001);
  await f.request('confirm', ready.tablet_drive.reference); assert.equal(f.applyCount, 0);
  ready = await f.ready(); await f.host.request({action: 'cancel', reference: ready.tablet_drive.reference});
  await f.request('confirm', ready.tablet_drive.reference); assert.equal(f.applyCount, 0);
});

test('original readback survives Manager restart without preserving or replaying credentials', async t => {
  const f = fixture({lostReply: true}); t.after(() => f.host.dispose()); const ready = await f.ready();
  await f.request('confirm', ready.tablet_drive.reference); f.host.dispose();
  assert.equal(JSON.stringify(f.store.value).includes('synthetic-refresh'), false);
  const next = fixture({store: f.store}); t.after(() => next.host.dispose()); Object.assign(next.original, structuredClone(f.original));
  const retained = await next.host.request({action: 'retained'});
  assert.equal(retained.tablet_drive.retained[0].status_available, true);
  assert.equal((await next.begin()).tablet_drive.state, 'unknown'); assert.equal(next.applyCount, 0);
  assert.equal((await next.request('check', ready.tablet_drive.reference)).tablet_drive.state, 'observed');
  assert.equal(next.calls.at(-1).request.action, 'readback'); assert.equal(next.applyCount, 0);
  assert.deepEqual(f.store.value.originals, []);
});

test('durable original refusal prevents dispatch; unresolved state remains when resolution cannot be saved', async t => {
  const f = fixture(); t.after(() => f.host.dispose()); const ready = await f.ready(); f.store.refuseSave = true;
  assert.equal((await f.request('confirm', ready.tablet_drive.reference)).tablet_drive.state, 'refused'); assert.equal(f.applyCount, 0);
  const lost = fixture({lostReply: true}); t.after(() => lost.host.dispose()); const pending = await lost.ready();
  await lost.request('confirm', pending.tablet_drive.reference); lost.store.refuseSave = true;
  assert.equal((await lost.request('check', pending.tablet_drive.reference)).tablet_drive.state, 'unknown');
  assert.equal((await lost.begin()).tablet_drive.state, 'unknown'); assert.equal(lost.applyCount, 1);
});

test('binding capacity is checked before OAuth and reserved again before Apply', async t => {
  const foreign = Array.from({length: 8}, (_, index) => ({connection_id: hash('foreign-' + index),
    device: id(100 + index), collection: id(200 + index), binding_sha256: hash('binding-' + index)}));
  const seed = (f, bindings) => {
    assert.equal(f.store.saveTabletDriveOperations({version: 1, originals: [], bindings}, f.store.digest).committed, true);
  };
  const full = fixture(); t.after(() => full.host.dispose()); seed(full, foreign);
  assert.equal((await full.begin()).tablet_drive.state, 'capacity');
  assert.equal(full.auth.generation, 0);
  assert.equal(full.applyCount, 0);

  const raced = fixture(); t.after(() => raced.host.dispose()); seed(raced, foreign.slice(0, 7));
  const ready = await raced.ready();
  assert.equal(ready.tablet_drive.state, 'ready');
  seed(raced, foreign);
  assert.equal((await raced.request('confirm', ready.tablet_drive.reference)).tablet_drive.state, 'refused');
  assert.equal(raced.applyCount, 0);
  assert.deepEqual(raced.store.value.originals, []);

  const bound = fixture(); t.after(() => bound.host.dispose());
  seed(bound, [...foreign.slice(0, 7), {...foreign[7], connection_id: identity.connection_id, device: bound.original.device}]);
  const existing = await bound.ready();
  assert.equal(existing.tablet_drive.state, 'ready');
  assert.equal((await bound.request('confirm', existing.tablet_drive.reference)).tablet_drive.state, 'verified');
  assert.equal(bound.store.value.bindings.length, 8);
});

test('public setup frames reject secret, path and target authority supplied by renderer', async t => {
  const request = {action: 'begin', ...identity, intent: 'connect'};
  for (const extra of [{credential: 'secret'}, {collection: id(9)}, {path: '/tmp/a'}, {operation: id(8)}]) assert.throws(() => parseTabletDriveSetupRequest({...request, ...extra}));
  const f = fixture(); t.after(() => f.host.dispose()); const result = await f.begin();
  assert.throws(() => parseTabletDriveSetupResult({...result, secret: 'value'}, request));
  assert.throws(() => parseTabletDriveSetupResult({...result, tablet_drive: {...result.tablet_drive, authorizationUrl: 'https://evil.example/'}}, request));
});
