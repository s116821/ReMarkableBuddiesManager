import test from 'node:test';
import assert from 'node:assert/strict';
import {FirstConfigurationHost} from '../host/first-configuration.mjs';
import {MaintenanceIO} from '../host/maintenance-io.mjs';
import {FirstConfigurationController} from '../src/first-configuration.ts';
import {currentHost} from '../src/host.ts';
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
    assert.deepEqual(Object.keys(request).sort(), ['boot_id', 'connection_id', 'expected_executable_sha256', 'selector', 'service']);
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
  assert.equal(controller.state.current, null);
  f.state.hold = null;
  await controller.run('check', tablet, f.run, pause);
  assert.equal(controller.state.current, 'present');
  assert.equal(controller.state.retained[0].outcome, 'unknown');
});

test('the shared browser maintenance bridge preserves bounds, parsers and stream custody', async t => {
  const environment = {window: {}, location: {hostname: 'elsewhere', protocol: 'http:'}};
  for (const [key, value] of Object.entries(environment)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true});
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }

  const encoder = new TextEncoder(), signal = new AbortController().signal;
  let cancelled = 0, released = 0, chunks = [], ok = true;
  const reader = {
    async read() { return chunks.length ? {done: false, value: chunks.shift()} : {done: true}; },
    async cancel() { cancelled++; },
    releaseLock() { released++; },
  };
  const timeout = t.mock.method(AbortSignal, 'timeout', () => signal);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ok, body: {getReader: () => reader}}));
  const host = currentHost();
  const first = {action: 'retained'};
  await assert.rejects(host.firstConfiguration(first), {message: 'First configuration helper unavailable'});
  environment.location.hostname = '127.0.0.1';
  environment.location.protocol = 'https:';
  await assert.rejects(host.firstConfiguration(first), {message: 'First configuration helper unavailable'});
  assert.equal(fetchMock.mock.callCount(), 0);
  environment.location.protocol = 'http:';

  const frame = size => {
    chunks = [encoder.encode('{"value":1}'), encoder.encode(' '.repeat(size - 11))];
  };
  const payload = {version: 1, state: 'none', invocation: null, reference: null, current: null, retained: []};
  const body = JSON.stringify(payload);
  chunks = [encoder.encode(body), encoder.encode(' '.repeat(8192 - body.length))];
  assert.deepEqual(await host.firstConfiguration(first), payload);
  assert.deepEqual(fetchMock.mock.calls[0].arguments, ['/manager-first-configuration', {
    method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
    body: '{"action":"retained"}', signal,
  }]);
  assert.deepEqual(timeout.mock.calls[0].arguments, [14000]);
  assert.deepEqual([cancelled, released], [0, 1]);

  frame(8193);
  await assert.rejects(host.researchSettings({}), {message: 'Research response refused'});
  assert.deepEqual([cancelled, released], [1, 2]);
  frame(16384);
  assert.deepEqual(await host.inspectOwnedV3({}), {value: 1});
  frame(16385);
  await assert.rejects(host.inspectOwnedV3({}), {message: 'Stored data inspection response refused'});
  assert.deepEqual([cancelled, released], [2, 4]);
  frame(270336);
  assert.deepEqual(await host.handwritingRecords({}), {value: 1});
  frame(270337);
  await assert.rejects(host.handwritingRecords({}), {message: 'Archive operation response refused'});

  const duplicate = '{"value":1,"value":2}';
  chunks = [encoder.encode(duplicate)];
  await assert.rejects(host.firstConfiguration(first), {message: 'Ordinary restore refused'});
  chunks = [encoder.encode(duplicate)];
  assert.deepEqual(await host.storageInitialization(first), {value: 2});
  chunks = [encoder.encode('\ufeff{}')];
  await assert.rejects(host.storageInitialization(first), SyntaxError);
  chunks = [Uint8Array.of(0xff)];
  await assert.rejects(host.storageInitialization(first), TypeError);
  assert.deepEqual([cancelled, released], [3, 10]);

  ok = false;
  await assert.rejects(host.storageInitialization(first), {message: 'Storage preparation unavailable'});
  assert.deepEqual([cancelled, released], [3, 10]);

  ok = true;
  chunks = [encoder.encode('\ufeff{}')];
  assert.deepEqual(await host.localModeChoice({}), {});
  assert.deepEqual([cancelled, released], [4, 10]);
  chunks = [encoder.encode('\ufeff{}')];
  assert.deepEqual(await host.isolatedRoot({}), {});
  assert.deepEqual(timeout.mock.calls.at(-1).arguments, [46000]);
  assert.deepEqual([cancelled, released], [5, 11]);

  chunks = [encoder.encode('\ufeff{}')];
  await assert.rejects(host.ordinaryExport({}), SyntaxError);
  assert.deepEqual([cancelled, released], [6, 11]);
  frame(2048);
  assert.deepEqual(await host.downloads.request({action: 'status'}), {value: 1});
  assert.deepEqual(timeout.mock.calls.at(-1).arguments, [10000]);
  frame(2049);
  await assert.rejects(host.downloads.request({action: 'status'}), {message: 'Download response refused'});
  assert.deepEqual([cancelled, released], [8, 11]);
  ok = false;
  await assert.rejects(host.isolatedRoot({}), {message: 'Isolated backup helper unavailable'});
  await assert.rejects(host.localModeChoice({}), {message: 'Local-only helper unavailable'});
  await assert.rejects(host.downloads.request({action: 'status'}), {message: 'Download host unavailable'});
  assert.deepEqual([cancelled, released], [8, 11]);
  await assert.rejects(host.firstConfiguration(first), /unavailable/i);
  ok = true;
  chunks = [encoder.encode(body), encoder.encode(' '.repeat(8193 - body.length))];
  await assert.rejects(host.firstConfiguration(first), /response refused/i);
  assert.deepEqual([cancelled, released], [9, 12]);
});

test('existing configuration requires the observed resident executable through confirmation and never falls back', async () => {
  const f = open();
  f.state.existing = true;
  f.observer.lastObservation.service.LoadState = 'loaded';
  const review = await f.run(bind('review', 1));
  assert.equal(review.state, 'ready');
  assert.equal(f.state.calls[0].request.selector, 'check-existing-default');
  const original = f.state.executable;
  f.state.executable = 'e'.repeat(64);
  const refused = await f.run(bind('create', 2, review.reference));
  assert.equal(refused.state, 'unavailable');
  assert.equal(f.state.exists, false);
  assert.equal(f.state.calls[1].request.expected_executable_sha256, original);
  const reviewedAgain = await f.run(bind('review', 3));
  f.state.lost = true;
  assert.equal((await f.run(bind('create', 4, reviewedAgain.reference))).state, 'unknown');
  f.state.lost = false;
  const readback = await f.run(bind('check', 5));
  assert.equal(readback.current, 'present');
  assert.equal(readback.retained[0].outcome, 'unknown');
  assert.equal((await f.run(bind('create', 6, reviewedAgain.reference))).state, 'unknown');
  assert.deepEqual(f.state.calls.map(({request}) => request.selector), [
    'check-existing-default', 'create-existing-default', 'check-existing-default',
    'create-existing-default', 'check-existing-default',
  ]);
});
