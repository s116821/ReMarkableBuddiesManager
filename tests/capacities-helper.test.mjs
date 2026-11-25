import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {startHelper} from '../host/browser-helper.mjs';
import {parseCapacitiesState} from '../host/capacities-protocol.mjs';

const state = status => ({contract_version: 1, status});
function navigate(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {headers}, response => {
      response.resume();
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers}));
    });
    request.on('error', reject);
    request.end();
  });
}

test('Capacities browser navigation keeps consent parameters private and consumes its redirect once', async t => {
  let current = state('disconnected'), calls = 0, disposed = false;
  const authorizationUrl = 'https://api.capacities.io/oauth/authorize?state=synthetic-state&code_challenge=synthetic-challenge';
  const helper = await startHelper({root: path.resolve('dist/manager/browser'), capacitiesFactory: ({openAuthorization}) => ({
    status: () => current,
    begin: async () => { calls++; current = state('starting'); await openAuthorization(authorizationUrl); current = state('awaiting-consent'); return current; },
    cancel: () => (current = state('canceled')),
    reconcile: () => current,
    dispose: () => { disposed = true; },
  })});
  t.after(async () => { await helper.close(); assert.equal(disposed, true); });
  const initial = await fetch(helper.origin + '/preview/');
  const cookie = initial.headers.get('set-cookie').split(';')[0]; await initial.text();
  const post = (body, headers = {}) => fetch(helper.origin + '/manager-capacities', {
    method: 'POST', headers: {Origin: helper.origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers}, body,
  });
  assert.equal((await post('{"action":"begin"}', {Origin: 'https://other.invalid'})).status, 403);
  assert.equal((await post('{"action":"begin"}', {Cookie: 'wrong'})).status, 403);
  assert.equal((await post('{"action":"begin","proof":"not-accepted"}')).status, 400);
  assert.equal((await post('{"action":"status","action":"begin"}')).status, 400);
  assert.equal((await post('x'.repeat(129))).status, 413);
  assert.equal(calls, 0);
  const begin = await post('{"action":"begin"}');
  assert.equal(begin.status, 200);
  const first = await begin.json();
  assert.deepEqual(Object.keys(first).sort(), ['launchId', 'state']);
  assert.deepEqual(first.state, state('awaiting-consent'));
  assert.match(first.launchId, /^[a-f0-9]{32}$/);
  assert.equal((await post('{"action":"begin"}')).status, 409);
  assert.equal(calls, 1);
  const navigation = {Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'};
  const endpoint = helper.origin + '/manager-capacities-open?launch=' + first.launchId;
  assert.equal((await navigate(endpoint, {...navigation, 'Sec-Fetch-Site': 'cross-site'})).status, 403);
  assert.equal((await navigate(endpoint, {...navigation, 'Sec-Fetch-Mode': 'cors'})).status, 403);
  assert.equal((await navigate(endpoint + '&redirect=https://other.invalid', navigation)).status, 403);
  const launched = await navigate(endpoint, navigation);
  assert.equal(launched.status, 303);
  assert.equal(launched.headers.location, authorizationUrl);
  assert.equal(launched.headers['referrer-policy'], 'no-referrer');
  assert.equal((await navigate(endpoint, navigation)).status, 409);
  await post(JSON.stringify({action:'cancel',launchId:first.launchId}));
  assert.deepEqual(await (await post('{"action":"status"}')).json(), state('canceled'));
  const second = await (await post('{"action":"begin"}')).json();
  // A delayed popup from the canceled flow cannot consume a new flow's URL.
  assert.deepEqual(await (await post(JSON.stringify({action:'cancel',launchId:first.launchId}))).json(), state('selection-changed'));
  assert.deepEqual(await (await post(JSON.stringify({action:'status',launchId:first.launchId}))).json(), state('selection-changed'));
  assert.equal((await navigate(endpoint, navigation)).status, 409);
  assert.equal((await navigate(helper.origin + '/manager-capacities-open?launch=' + second.launchId, navigation)).status, 303);
  current = state('handing-off');
  assert.equal((await navigate(endpoint, navigation)).status, 409);
  await post(JSON.stringify({action:'cancel',launchId:second.launchId}));
  assert.deepEqual(current, state('canceled'));
  assert.equal((await navigate(endpoint, navigation)).status, 409);
  await post('{"action":"begin"}');
  current = state('expired'); // Natural expiry without an intervening status poll.
  const afterExpiry = await post('{"action":"begin"}');
  assert.equal(afterExpiry.status, 200);
  assert.deepEqual((await afterExpiry.json()).state, state('awaiting-consent'));
});

test('Capacities public state rejects accidental credential or binding fields', () => {
  assert.deepEqual(parseCapacitiesState(state('staged')), state('staged'));
  for (const extra of ['authorizationUrl', 'code', 'access_token', 'tablet_id', 'operation_id']) {
    assert.throws(() => parseCapacitiesState({...state('connected'), [extra]: 'synthetic'}));
  }
  assert.throws(() => parseCapacitiesState(state('unexpected')));
});

test('closing an outstanding Begin response cancels that pending host flow', {timeout: 5000}, async t => {
  let current = state('disconnected'), beginReady, releaseBegin, canceled;
  const started = new Promise(resolve => { beginReady = resolve; });
  const gate = new Promise(resolve => { releaseBegin = resolve; });
  const cancellation = new Promise(resolve => { canceled = resolve; });
  const helper = await startHelper({root: path.resolve('dist/manager/browser'), capacitiesFactory: () => ({
    status: () => current,
    begin: async () => { current = state('starting'); beginReady(); await gate; return current; },
    cancel: () => { current = state('canceled'); canceled(); return current; },
    reconcile: () => current, dispose() {},
  })});
  t.after(async () => { releaseBegin(); await helper.close(); });
  const initial = await fetch(helper.origin + '/preview/');
  const cookie = initial.headers.get('set-cookie').split(';')[0]; await initial.text();
  const controller = new AbortController();
  const pending = fetch(helper.origin + '/manager-capacities', {method:'POST', signal:controller.signal,
    headers:{Origin:helper.origin,Cookie:cookie,'Content-Type':'application/json'},body:'{"action":"begin"}'});
  const rejected = assert.rejects(pending);
  await started;
  controller.abort();
  await Promise.all([rejected, cancellation]);
  assert.deepEqual(current, state('canceled'));
  releaseBegin();
});

test('Capacities host refuses a provider redirect outside its fixed authorization endpoint', async t => {
  const helper = await startHelper({root: path.resolve('dist/manager/browser'), capacitiesFactory: ({openAuthorization}) => ({
    status: () => state('disconnected'),
    begin: async () => { await openAuthorization('https://other.invalid/oauth/authorize'); return state('awaiting-consent'); },
    cancel: () => state('canceled'), reconcile: () => state('disconnected'), dispose() {},
  })});
  t.after(() => helper.close());
  const initial = await fetch(helper.origin + '/preview/');
  const cookie = initial.headers.get('set-cookie').split(';')[0]; await initial.text();
  const result = await fetch(helper.origin + '/manager-capacities', {method: 'POST',
    headers: {Origin: helper.origin, Cookie: cookie, 'Content-Type': 'application/json'}, body: '{"action":"begin"}'});
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('location'), null);
});
