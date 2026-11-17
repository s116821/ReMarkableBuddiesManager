import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CAPACITIES_REDIRECT, CapacitiesConsent } from '../host/capacities-consent.mjs';

const CODE = 'synthetic-code-fixture';
const binding = Object.freeze({
  tablet_id: 'development-tablet-fixture',
  connection_id: 'a'.repeat(64),
  boot_id: '018f5725-b86b-4e3d-aafc-930143a21f68',
  config_sha256: 'b'.repeat(64)
});
const committed = original => ({
  contract_version: 1, ...original, status: 'committed',
  installed_config_sha256: 'c'.repeat(64), space_id: randomUUID()
});

async function eventually(broker, status) {
  for (let i = 0; i < 100; i++) {
    if (broker.status().status === status) return;
    await delay(20);
  }
  assert.equal(broker.status().status, status);
}

async function setup(t, options = {}) {
  const requests = [];
  let issuer;
  const server = createServer((req, res) => {
    requests.push([req.method, req.url]);
    if (options.redirect) {
      res.writeHead(302, { Location: issuer + '/outside-discovery' }).end();
      return;
    }
    const metadata = {
      issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
      scopes_supported: ['api:read', 'api:write', 'offline_access'], response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
      ...options.metadata
    };
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(options.oversize ? { ...metadata, pad: 'x'.repeat(32768) } : metadata));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  let authorization;
  let captured;
  const operations = [];
  const broker = new CapacitiesConsent({
    fixture: { issuer, clientId: 'verified-fixture-client', lifetime: options.lifetime, requestMs: 3000 },
    openAuthorization: value => { authorization = new URL(value); },
    tablet: {
      capture: ids => { captured = ids; return binding; },
      current: original => {
        assert.deepEqual(original, { ...binding, ...captured });
        return options.current?.(original) ?? true;
      },
      handoff: (original, proof) => {
        operations.push({ original, proof });
        return options.handoff ? options.handoff(original) : committed(original);
      },
      status: original => {
        assert.deepEqual(original, { ...binding, ...captured });
        return options.status?.(original);
      }
    }
  });
  t.after(async () => {
    broker.dispose();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return {
    broker, issuer, requests, operations, authorization: () => authorization,
    callback(params = {}) {
      const url = new URL(authorization.searchParams.get('redirect_uri'));
      url.search = new URLSearchParams({
        state: authorization.searchParams.get('state'), code: CODE, iss: issuer, ...params
      }).toString();
      return url;
    }
  };
}

function wrongHost(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: 'wrong.invalid' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy());
    req.end();
  });
}

test('production broker has no registered client and performs no consent work', async () => {
  let touched = false;
  const attempt = () => { touched = true; };
  const broker = new CapacitiesConsent({
    tablet: { capture: attempt, current: attempt, handoff: attempt, status: attempt },
    openAuthorization: attempt
  });
  assert.equal(CAPACITIES_REDIRECT, 'http://127.0.0.1:48761/oauth/capacities/callback');
  assert.deepEqual(await broker.begin(), { contract_version: 1, status: 'unconfigured' });
  assert.equal(touched, false);
  broker.dispose();
});

test('exact PKCE callback transfers code only once to the original tablet binding', async t => {
  const f = await setup(t);
  assert.deepEqual(await f.broker.begin(), { contract_version: 1, status: 'awaiting-consent' });
  const url = f.authorization();
  assert.equal(url.origin, f.issuer);
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('resource'), 'https://api.capacities.io');
  assert.equal(url.searchParams.get('scope'), 'api:read api:write offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);

  const duplicate = f.callback();
  duplicate.searchParams.append('code', CODE);
  for (const invalid of [f.callback({ state: 'wrong-state' }), f.callback({ iss: 'https://wrong.invalid' }), duplicate]) {
    const refused = await fetch(invalid, { signal: AbortSignal.timeout(3000) });
    assert.equal(refused.status, 400);
    assert.doesNotMatch(await refused.text(), /synthetic-code/);
  }
  assert.equal(await wrongHost(f.callback()), 400);
  const wrongMethod = await fetch(f.callback(), { method: 'POST', signal: AbortSignal.timeout(3000) });
  assert.equal(wrongMethod.status, 400);
  await wrongMethod.text();
  assert.equal(f.operations.length, 0);
  const callback = f.callback();
  const response = await fetch(callback, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /synthetic-code|verifier/);
  await eventually(f.broker, 'connected');
  assert.equal(f.operations.length, 1);
  const [{ original, proof }] = f.operations;
  assert.equal(original.connection_id, binding.connection_id);
  assert.notEqual(original.operation_id, original.grant_id);
  assert.equal(proof.code, CODE);
  assert.equal(proof.redirect_uri, callback.origin + callback.pathname);
  assert.equal(createHash('sha256').update(proof.verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.deepEqual(f.broker.status(), { contract_version: 1, status: 'connected' });
  try {
    const replay = await fetch(callback, { signal: AbortSignal.timeout(3000) });
    assert.equal(replay.status, 400);
  } catch (error) {
    assert.equal(error.name, 'TypeError'); // The consumed callback listener is closed.
  }
  assert.equal(f.operations.length, 1);
  assert.deepEqual(f.requests, [['GET', '/.well-known/oauth-authorization-server']]);
});

test('validated denial and changed tablet bindings cannot transfer code', async t => {
  const denied = await setup(t);
  await denied.broker.begin();
  const error = denied.callback({ error: 'access_denied', error_description: 'synthetic provider detail' });
  error.searchParams.delete('code');
  const refused = await fetch(error, { signal: AbortSignal.timeout(3000) });
  assert.equal(refused.status, 200);
  assert.doesNotMatch(await refused.text(), /synthetic provider detail/);
  await eventually(denied.broker, 'denied');
  assert.equal(denied.operations.length, 0);

  const changed = await setup(t, { current: () => false });
  await changed.broker.begin();
  const accepted = await fetch(changed.callback(), { signal: AbortSignal.timeout(3000) });
  assert.equal(accepted.status, 200);
  await accepted.text();
  await eventually(changed.broker, 'selection-changed');
  assert.equal(changed.operations.length, 0);
});

test('uncertain handoff keeps the original operation and reconciles without resending', async t => {
  let validReceipt = false;
  const f = await setup(t, {
    handoff() { throw new Error('private transport detail'); },
    status(original) { return committed(validReceipt ? original : { ...original, grant_id: randomUUID() }); }
  });
  await f.broker.begin();
  const response = await fetch(f.callback(), { signal: AbortSignal.timeout(3000) });
  await response.text();
  await eventually(f.broker, 'reconcile-required');
  assert.deepEqual(await f.broker.begin(), { contract_version: 1, status: 'reconcile-required' });
  assert.equal((await f.broker.reconcile()).status, 'reconcile-required');
  validReceipt = true;
  assert.equal((await f.broker.reconcile()).status, 'connected');
  assert.equal(f.operations.length, 1);
  assert.deepEqual(f.requests, [['GET', '/.well-known/oauth-authorization-server']]);
});

test('cancel after confidential dispatch retains uncertainty and ignores a late commit receipt', { timeout: 8000 }, async t => {
  let started;
  let resolveHandoff;
  const dispatched = new Promise(resolve => { started = resolve; });
  const handoff = new Promise(resolve => { resolveHandoff = resolve; });
  const f = await setup(t, {
    handoff(original) { started(original); return handoff; },
    status: committed
  });
  await f.broker.begin();
  const response = await fetch(f.callback(), { signal: AbortSignal.timeout(3000) });
  await response.text();
  const original = await dispatched;
  assert.equal(f.broker.cancel().status, 'reconcile-required');
  resolveHandoff(committed(original));
  await Promise.resolve();
  assert.equal(f.broker.status().status, 'reconcile-required');
  assert.equal((await f.broker.reconcile()).status, 'connected');
  assert.equal(f.operations.length, 1);
});

test('foreign, unsupported, redirected or oversized metadata never opens consent', async t => {
  const faults = [
    { metadata: { token_endpoint: 'https://wrong.invalid/oauth/token' } }, { redirect: true },
    { metadata: { code_challenge_methods_supported: ['plain'] } },
    { metadata: { grant_types_supported: ['refresh_token'] } },
    { metadata: { token_endpoint_auth_methods_supported: ['client_secret_post'] } }, { oversize: true }
  ];
  for (const fault of faults) {
    const f = await setup(t, fault);
    assert.equal((await f.broker.begin()).status, 'authorization-failed');
    assert.equal(f.authorization(), undefined);
    assert.equal(f.operations.length, 0);
    assert.deepEqual(f.requests, [['GET', '/.well-known/oauth-authorization-server']]);
  }
});
