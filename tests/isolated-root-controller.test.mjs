import assert from 'node:assert/strict';
import test from 'node:test';
import {IsolatedRootController, isolatedRootReportLabel} from '../src/isolated-root.ts';
import {historical, id, original, setup} from './fixtures/isolated-root.mjs';

const ready = async fixture => {
  await fixture.controller.begin(fixture.adapter, fixture.target, async () => true);
  assert.equal(fixture.controller.state.view.state, 'ready');
};
const sameObservation = async () => true;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function open(options = {}) {
  const fixture = setup(options), requests = [];
  const controller = new IsolatedRootController(() => {});
  const adapter = {isolatedRoot(request) {
    requests.push(request);
    return fixture.host.request(request);
  }};
  return {...fixture, get release() { return fixture.release; }, controller, adapter, requests, target: fixture.observer.lastObservation};
}

test('review does one inspection and prepare requires the same session and one explicit confirmation', async () => {
  const f = open();
  await ready(f);
  assert.deepEqual(f.calls.map(call => call.selector), ['inspect']);
  for (const changed of [{...f.target, boot_id: id(7)}, {...f.target, connection_id: 'f'.repeat(64)}]) {
    await f.controller.prepare(f.adapter, changed, sameObservation);
  }
  assert.equal(f.calls.length, 1);
  await Promise.all([
    f.controller.prepare(f.adapter, f.target, sameObservation),
    f.controller.prepare(f.adapter, f.target, sameObservation),
  ]);
  assert.deepEqual(f.requests.map(request => request.action), ['begin', 'prepare']);
  assert.equal(new Set(f.requests.map(request => request.wait_id)).size, 2);
  assert.equal(f.controller.state.retained[0].state, 'verified');
  assert.match(f.controller.state.status, /current saved backup/);
});

test('lost result survives reload as unknown and explicit replay reuses retained input', async () => {
  const f = open({raw: 'lost'});
  await ready(f);
  await f.controller.prepare(f.adapter, f.target, sameObservation);
  assert.match(f.controller.state.status, /outcome is unknown/);
  assert.equal(f.controller.state.view.report, null);
  const earlier = f.calls[1].input_base64;
  f.restart();
  const reloaded = new IsolatedRootController(() => {});
  await reloaded.retained(f.adapter);
  const [row] = reloaded.state.retained;
  assert.equal(row.state, 'unknown');
  for (const changed of [{...f.target, boot_id: id(7)}, {...f.target, connection_id: 'f'.repeat(64)}]) {
    await reloaded.retry(f.adapter, changed, row, sameObservation);
  }
  assert.equal(f.calls.length, 2);
  f.options.raw = undefined;
  f.options.report = historical;
  await reloaded.retry(f.adapter, f.target, row, sameObservation);
  assert.equal(f.calls[2].input_base64, earlier);
  assert.equal(f.requests.at(-1).reference, row.reference);
  assert.notEqual(f.requests[1].wait_id, f.requests.at(-1).wait_id);
  assert.match(reloaded.state.status, /earlier backup/);
  assert.equal(reloaded.state.view.report.result.currency, 'historical');
  assert.equal(reloaded.state.retained[0].state, 'verified');
});

test('captured pending report stays visible with unresolved original', async () => {
  const report = structuredClone(original);
  report.data.isolated_root.outcome = 'authorization-required';
  report.status = 'unavailable';
  report.incomplete = true;
  const f = open({report});
  await ready(f);
  await f.controller.prepare(f.adapter, f.target, sameObservation);
  assert.equal(f.controller.state.retained[0].state, 'unknown');
  assert.match(f.controller.state.status, /outcome is unknown/);
  assert.match(isolatedRootReportLabel(f.controller.state.view.report), /authorization is required/);
});

test('stop cancels the exact dispatched wait and ignores late completion after explicit retry', async () => {
  const f = open({delay: true});
  await ready(f);
  const dispatched = deferred(), adapter = {isolatedRoot(q) {
    const result = f.adapter.isolatedRoot(q);
    if (q.action === 'prepare') dispatched.resolve();
    return result;
  }};
  const pending = f.controller.prepare(adapter, f.target, sameObservation);
  await dispatched.promise;
  const first = f.requests.at(-1), releaseFirst = f.release;
  assert.equal(first.action, 'prepare');
  await f.controller.stop(f.adapter);
  assert.deepEqual(f.requests.at(-1), {action: 'cancel', reference: first.reference, wait_id: first.wait_id});
  assert.equal(f.controller.state.retained[0].state, 'unknown');
  f.options.delay = false;
  await f.controller.retry(f.adapter, f.target, f.controller.state.retained[0], sameObservation);
  const verified = f.controller.state;
  assert.equal(verified.view.state, 'verified');
  releaseFirst();
  await pending;
  assert.equal(f.controller.state, verified);
});

test('clearing a queued review prevents inspection and a late ready result is cancelled by its own wait', async () => {
  const queued = open(), gate = deferred();
  const pending = queued.controller.begin(queued.adapter, queued.target, () => gate.promise);
  queued.controller.clear(queued.adapter);
  gate.resolve(true);
  await pending;
  assert.deepEqual(queued.requests, []);

  const f = open({inspectDelay: true});
  const dispatched = deferred(), adapter = {isolatedRoot(q) {
    const result = f.adapter.isolatedRoot(q);
    if (q.action === 'begin') dispatched.resolve();
    return result;
  }};
  const inspection = f.controller.begin(adapter, f.target, sameObservation);
  await dispatched.promise;
  await f.controller.stop(adapter);
  assert.deepEqual(f.requests.map(q => q.action), ['begin']);
  f.release();
  await inspection;
  assert.equal(f.controller.state.view, null);
  const [begin, cancel] = f.requests;
  assert.equal(cancel.action, 'cancel');
  assert.equal(cancel.wait_id, begin.wait_id);
  assert.match(cancel.reference, /^[a-f0-9]{64}$/);
});

test('clearing a ready review cancels it and disables prepare', async () => {
  const f = open();
  await ready(f);
  const reference = f.controller.state.view.reference;
  f.controller.clear(f.adapter);
  assert.deepEqual(f.requests.at(-1), {action: 'cancel', reference, wait_id: f.requests[0].wait_id});
  await f.controller.prepare(f.adapter, f.target, sameObservation);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.state.view, null);
});

test('rejects instead of rendering a forged report and preserves loss uncertainty', async () => {
  const f = open();
  const adapter = {async isolatedRoot(q) {
    const value = await f.adapter.isolatedRoot(q);
    if (q.action === 'prepare') value.isolated_root_preparation.retained[0].boot_id = id(7);
    return value;
  }};
  await f.controller.begin(adapter, f.target, sameObservation);
  await f.controller.prepare(adapter, f.target, sameObservation);
  assert.equal(f.controller.state.view, null);
  assert.match(f.controller.state.status, /outcome is unknown/);
  assert.deepEqual(f.controller.state.retained, []);
});

test('reports private storage failure without any inspection or provisioning', async () => {
  const f = open({readFailure: true});
  await f.controller.begin(f.adapter, f.target, sameObservation);
  assert.equal(f.controller.state.view.state, 'storage-unavailable');
  assert.match(f.controller.state.status, /private operation storage is unavailable/);
  assert.deepEqual(f.calls, []);
});

test('reports full history without offering confirmation or losing retry control', async () => {
  const f = open();
  const rows = Array.from({length: 8}, (_, i) => ({
    device: id(2), backup: id(3), epoch: id(10 + i), reference: String(i).repeat(64),
    connection_id: f.target.connection_id, boot_id: f.target.boot_id, state: 'unknown',
  }));
  const adapter = {async isolatedRoot() {
    return {
      contract_version: 1, status: 'unconfigured', observation: null,
      isolated_root_preparation: {state: 'capacity', report: null, preview: null, reference: null, retained: rows},
    };
  }};
  await f.controller.begin(adapter, f.target, sameObservation);
  assert.match(f.controller.state.status, /history is full/);
  assert.equal(f.controller.canPrepare(f.target), false);
  assert.equal(f.controller.canRetry(f.target, rows[0]), true);
});
