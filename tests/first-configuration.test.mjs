import test from 'node:test';
import assert from 'node:assert/strict';
import {FirstConfigurationHost} from '../host/first-configuration.mjs';
import {MaintenanceIO} from '../host/maintenance-io.mjs';
import {FirstConfigurationController} from '../src/first-configuration.ts';
import {firstConfigurationFixture, tablet, target, invocation, noDispatch} from './fixtures/first-configuration.mjs';

const bind = (action, index, ref, sample = tablet) => ({action, ...target(sample), invocation: invocation(index),
  ...(ref === undefined ? {} : {reference: ref})});
const cancel = request => ({action: 'cancel', ...target(request), reference: request.reference ?? null,
  invocation: request.invocation});
const open = options => {
  const f = firstConfigurationFixture(), io = new MaintenanceIO();
  const host = new FirstConfigurationHost({observer: f.observer, io, ...options});
  const caller = {document: Symbol(), callerCurrent: () => true};
  const run = async request => host.deliver(await host.request(request, caller), request, caller.callerCurrent);
  return {...f, io, host, caller, run};
};
const tick = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };

test('first configuration requires private installation admission and a separate fresh Create', async () => {
  const f = open();
  f.state.available = false;
  assert.equal((await f.run(bind('review', 1))).state, 'unavailable');
  assert.equal(f.state.calls.length, 0);
  f.state.available = true;
  const review = await f.run(bind('review', 2));
  assert.equal(review.state, 'ready');
  assert.equal(review.current, 'missing');
  assert.deepEqual(f.state.calls.map(call => call.request.selector), ['check-initial']);
  assert.throws(() => f.host.request({...bind('create', 3, review.reference), path: '/foreign'}, f.caller), /refused/);
  const other = {document: Symbol(), callerCurrent: () => true};
  assert.equal((await f.host.request(bind('create', 3, review.reference), other)).state, 'invalidated');
  const created = await f.run(bind('create', 3, review.reference));
  assert.equal(created.state, 'created');
  assert.equal((await f.run(bind('create', 4, review.reference))).state, 'invalidated');
  assert.equal((await f.run(bind('check', 5))).current, 'present');
  assert.deepEqual(f.state.calls.map(call => call.request.selector), ['check-initial', 'create-initial', 'check-initial']);
  for (const {request} of f.state.calls) {
    assert.deepEqual(Object.keys(request).sort(), ['boot_id', 'connection_id', 'selector', 'service']);
  }
});

test('admitted invocation UUIDs are single use, late Cancel cannot affect a successor, and Busy stays unconsumed', async () => {
  const f = open();
  const original = bind('check', 1), successor = bind('check', 2);
  const busy = f.io.acquire('peer', 'peer', 'check');
  assert.equal((await f.run(original)).state, 'busy');
  f.io.release(busy);
  assert.equal((await f.run(original)).state, 'checked');
  assert.equal((await f.run(original)).state, 'invalidated');

  f.state.hold = Promise.withResolvers();
  const pending = f.run(successor);
  await tick();
  assert.equal((await f.run(cancel(original))).state, 'invalidated');
  assert.equal(f.state.calls.at(-1).signal.aborted, false);
  assert.equal((await f.run(successor)).state, 'invalidated');
  f.state.hold.resolve();
  assert.equal((await pending).state, 'checked');
  f.state.hold = null;
  for (let index = 3; index <= 32; index++) {
    assert.equal((await f.run(bind('check', index))).state, 'checked');
  }
  assert.equal((await f.run(bind('check', 33))).state, 'capacity');
  assert.equal((await f.run(bind('review', 34))).state, 'capacity');
  assert.equal(f.state.calls.length, 32);
  assert.equal((await f.run({action: 'retained'})).state, 'none');
});

test('only exact Cancel joins possible Create and retains unknown across reboot and current checks', async () => {
  const f = open(), review = await f.run(bind('review', 1));
  const create = bind('create', 2, review.reference);
  f.state.hold = Promise.withResolvers();
  const pending = f.run(create);
  await tick();
  await f.run({...cancel(create), invocation: invocation(5)});
  f.host.invalidate();
  assert.equal(f.state.calls.at(-1).signal.aborted, false);
  let settled = false;
  const cancelling = f.run(cancel(create)).then(value => { settled = true; return value; });
  await tick();
  assert.equal(f.state.calls.at(-1).signal.aborted, true);
  assert.equal(settled, false);
  assert.equal(f.io.acquire('peer', 'peer', 'check'), null);
  assert.equal(f.io.revoke(), false);
  f.state.hold.resolve();
  assert.equal((await cancelling).state, 'unknown');
  assert.equal((await pending).state, 'unknown');
  assert.equal(f.io.ownerFor('first-configuration', review.reference), null);
  f.state.hold = null;
  const newBoot = {...tablet, boot_id: invocation(88)};
  f.observer.lastObservation = newBoot;
  assert.equal((await f.run(bind('review', 6, undefined, newBoot))).state, 'unknown');
  const checked = await f.run(bind('check', 7, undefined, newBoot));
  assert.equal(checked.current, 'present');
  assert.equal(checked.retained[0].outcome, 'unknown');
  assert.equal(f.state.calls.filter(call => call.request.selector === 'create-initial').length, 1);
});

test('pre-dispatch cancellation and replacement caller never re-submit an original', async () => {
  const f = open(), review = await f.run(bind('review', 1));
  const create = bind('create', 2, review.reference);
  await f.run(cancel(create));
  assert.equal((await f.run(create)).state, 'invalidated');
  assert.equal(f.state.calls.length, 1);
  f.observer.runFirstConfiguration = async () => noDispatch;
  const refused = await f.run(bind('create', 3, review.reference));
  assert.equal(refused.state, 'unavailable');
  assert.deepEqual(refused.retained, []);
});

test('delivery rechecks captured caller and admission, and lost Create output stays unconfirmed', async () => {
  const f = open();
  const pending = bind('review', 1);
  const value = await f.host.request(pending, f.caller);
  assert.throws(() => f.host.deliver(value, pending, () => false), /caller changed/);
  f.state.available = false;
  assert.throws(() => f.host.deliver(value, pending, f.caller.callerCurrent), /result changed/);
  f.state.available = true;
  const review = await f.run(bind('review', 2));
  f.state.lost = true;
  assert.equal((await f.run(bind('create', 3, review.reference))).state, 'unknown');
  assert.equal((await f.run(bind('review', 4))).state, 'unknown');
  f.state.lost = false;
  const current = await f.run(bind('check', 5));
  assert.equal(current.current, 'present');
  assert.equal(current.retained[0].outcome, 'unknown');
});

test('actual controller discards a queued confirmation and retains uncertainty after joined stop', async () => {
  const f = open();
  let index = 1;
  const controller = new FirstConfigurationController(() => {}, () => invocation(index++));
  const pause = async () => true;
  await controller.run('review', tablet, f.run, pause);
  assert.equal(controller.state.status, 'ready');

  const waiting = Promise.withResolvers();
  const queued = controller.run('create', tablet, f.run, () => waiting.promise);
  await controller.stop();
  waiting.resolve(true);
  await queued;
  assert.equal(f.state.calls.length, 1);
  assert.equal(controller.state.reference, null);

  await controller.run('review', tablet, f.run, pause);
  f.state.hold = Promise.withResolvers();
  const create = controller.run('create', tablet, f.run, pause);
  await tick();
  const stopping = controller.stop();
  await tick();
  assert.equal(controller.state.busy, true);
  assert.equal(f.state.calls.at(-1).signal.aborted, true);
  f.state.hold.resolve();
  await Promise.all([create, stopping]);
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.status, 'unknown');
  f.state.hold = null;
  await controller.run('check', tablet, f.run, pause);
  assert.equal(controller.state.current, 'present');
  assert.equal(controller.state.retained[0].outcome, 'unknown');
});
