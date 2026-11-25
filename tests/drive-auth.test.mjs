import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, chmod, symlink, mkdir, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { DriveAuth, DRIVE_SCOPE } = await import(process.env.MANAGER_DRIVE_BUNDLE ? pathToFileURL(path.resolve(process.env.MANAGER_DRIVE_BUNDLE)).href : '../host/drive-auth.mjs');
import { DriveStore } from '../host/drive-store.mjs';

const CLIENT = '123456789012-fixture.apps.googleusercontent.com';
const config = { schema: 1, type: 'google-desktop', clientId: CLIENT, clientSecret: null };
const secret = 'synthetic-refresh-credential-only';
const python = process.env.MANAGER_DRIVE_PYTHON ?? process.env.MANAGER_WIRED_PYTHON ?? (process.platform === 'linux' ? '/usr/bin/python3' : null);
async function fixture(t, options = {}) {
  const root = options.store?.root ?? await mkdtemp(path.join(tmpdir(), 'manager-drive-auth-'));
  if (!options.store && process.platform === 'win32') {
    // Native custody has its own real NTFS fixtures; protocol tests use a plain in-memory store below.
    await rm(root, { recursive: true });
  } else if (!options.store) { await chmod(root, 0o700); await writeFile(path.join(root, 'client.json'), JSON.stringify(config), { mode: 0o600 }); }
  const state = { requests: [], refreshRequests: [], scope: DRIVE_SCOPE, clientId: CLIENT, account: 'fixture-account',
    label: 'fixture@example.invalid', tokens: 0, gate: null };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1'); let body = ''; for await (const chunk of req) body += chunk;
    state.requests.push({ method: req.method, path: u.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/token') {
      const fields = new URLSearchParams(body); state.tokens++;
      const signingIn = fields.get('grant_type') === 'authorization_code';
      if (signingIn) {
        assert.equal(fields.get('client_id'), state.clientId); assert.equal(fields.get('code'), 'synthetic-code');
        assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), state.challenge);
      } else state.refreshRequests.push(fields.get('refresh_token'));
      if (!signingIn && state.refreshFailure) {
        res.writeHead(state.refreshFailure.status);
        return res.end(JSON.stringify({error: state.refreshFailure.code, error_description: 'private provider detail'}));
      }
      if (state.gate) await state.gate.promise;
      if (state.oversize) return res.end('x'.repeat(65537));
      if (state.redirect) { res.writeHead(302, { Location: '/forbidden' }).end(); return; }
      const signInRefreshToken = Object.hasOwn(state, 'signInRefreshToken') ? state.signInRefreshToken : secret;
      const refreshToken = signingIn ? signInRefreshToken : state.refreshToken;
      res.end(JSON.stringify({ access_token: 'synthetic-access-token', refresh_token: refreshToken,
        expires_in: 3600, token_type: 'Bearer', scope: state.scope }));
    } else if (u.pathname === '/tokeninfo') res.end(JSON.stringify({ aud: state.audience ?? state.clientId, scope: state.scope, expires_in: 3600 }));
    else if (u.pathname === '/about') {
      await state.beforeAbout?.();
      res.end(JSON.stringify({ user: { permissionId: state.account, emailAddress: state.label } }));
    }
    else if (u.pathname === '/revoke') {
      assert.equal(u.searchParams.get('token'), secret);
      res.writeHead(state.revokeFail ? 503 : 200).end(state.revokeFail ? JSON.stringify({ error: secret }) : '{}');
    } else { res.writeHead(404).end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let store = options.store;
  if (!store && process.platform === 'win32') {
    let saved = null, digest = null;
    store = { client: () => ({ value: config, digest: 'fixture-client' }), grant: () => ({ value: saved, digest }),
      save: (value, clientDigest, previous) => { assert.equal(clientDigest, 'fixture-client'); assert.equal(previous, digest); saved = value; digest = createHash('sha256').update(JSON.stringify(value)).digest('hex'); return { committed: true, digest }; },
      disconnect: (_, expected) => { assert.equal(expected, digest); saved = null; digest = null; return { committed: true, digest }; } };
  } else if (!store) store = new DriveStore({ root, python });
  const auth = new DriveAuth({ store, endpoints: Object.fromEntries(['authorization', 'token', 'tokenInfo', 'revoke', 'about'].map((key, i) => [key, origin + ['/authorize', '/token', '/tokeninfo', '/revoke', '/about'][i]])), ...options });
  t.after(async () => { auth.dispose(); state.gate?.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (!options.store && process.platform !== 'win32') await rm(root, { recursive: true, force: true }); });
  async function begin(purpose = 'host') {
    const result = await (purpose === 'tablet' ? auth.beginTabletAuthorization() : auth.begin()); assert.equal(result.state.status, 'connecting');
    const url = new URL(result.authorizationUrl); state.challenge = url.searchParams.get('code_challenge');
    assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(url.searchParams.get('redirect_uri')); callback.searchParams.set('state', url.searchParams.get('state'));
    return { result, callback };
  }
  async function signIn(purpose = 'host') { const { callback } = await begin(purpose); callback.searchParams.set('code', 'synthetic-code'); assert.equal((await fetch(callback)).status, 200); await settled(auth); }
  return { auth, root, store, state, begin, signIn };
}
async function settled(auth) { for (let i = 0; i < 200 && ['connecting', 'checking', 'revoking'].includes(auth.state.status); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(!['connecting', 'checking', 'revoking'].includes(auth.state.status)); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

const tabletRefresh = 'synthetic-independent-tablet-refresh';
const collection = 'f52f35a1-1ccd-4544-9e22-5c1e87b6ca44';

test('a distributed desktop client signs in two fresh profiles to their own Drive accounts', {skip: !python}, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'manager-public-desktop-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const host = path.join(temp, 'host');
  await mkdir(host);
  for (const file of ['drive-store.mjs', 'drive_store.py', 'drive-read-guard.mjs', 'drive-read-guard.py', 'windows_wired.py', 'wired_observer.py']) {
    await copyFile(new URL('../host/' + file, import.meta.url), path.join(host, file));
  }
  const registrationFile = path.join(host, 'google-drive-client-id');
  await writeFile(registrationFile, CLIENT + '\n');
  const {DriveStore: InstalledStore} = await import(pathToFileURL(path.join(host, 'drive-store.mjs')).href);
  const profile = name => new InstalledStore({root: path.join(temp, name, 'drive-auth'), python});
  const first = profile('first'), second = profile('second');
  const a = await fixture(t, {store: first}), b = await fixture(t, {store: second});
  assert.equal(a.auth.status().status, 'disconnected');
  await a.begin();
  a.auth.cancel();
  await assert.rejects(readdir(path.dirname(first.root)), {code: 'ENOENT'});
  await a.signIn();
  assert.equal(a.auth.status().account.label, a.state.label);
  assert.deepEqual(await readdir(first.root), ['grant.json']);
  const firstGrant = first.grant();
  assert.equal(firstGrant.value.clientId, CLIENT);
  assert.equal(b.auth.status().status, 'disconnected');
  await assert.rejects(readdir(path.dirname(second.root)), {code: 'ENOENT'});
  b.state.account = 'second-account';
  b.state.label = 'second@example.invalid';
  b.state.signInRefreshToken = 'second-synthetic-refresh';
  await b.signIn();
  assert.equal(b.auth.status().account.label, b.state.label);
  assert.deepEqual(first.grant(), firstGrant);
  assert.notEqual(second.grant().digest, firstGrant.digest);
  assert.deepEqual(await readdir(second.root), ['grant.json']);
  const signal = new AbortController().signal;
  const guard = await first.openReadGuard({clientDigest: first.client().digest, grantDigest: firstGrant.digest, signal});
  const replacement = '1234567890-replacement.apps.googleusercontent.com';
  try {
    await guard.check({signal, timeoutMs: 5000});
    await writeFile(registrationFile, replacement + '\n');
    await assert.rejects(guard.check({signal, timeoutMs: 5000}));
    assert.deepEqual(first.grant(), firstGrant);
  } finally { await guard.close(); }
  assert.equal(a.auth.status().status, 'disconnected');
  assert.equal(a.auth.status().error, 'authorization-required');
  const originalRequests = a.state.requests.length;
  assert.equal((await a.auth.check()).error, 'authorization-required');
  assert.equal((await a.auth.beginTabletAuthorization()).authorizationUrl, null);
  await a.begin();
  a.auth.cancel();
  assert.deepEqual(first.grant(), firstGrant);
  assert.equal(a.state.requests.length, originalRequests);
  a.state.clientId = replacement;
  a.state.signInRefreshToken = 'synthetic-new-client-refresh';
  await a.signIn();
  assert.equal(first.grant().value.clientId, replacement);
  assert.equal(a.auth.status().account.label, a.state.label);
  assert.equal(second.grant().value.clientId, CLIENT);
  const otherRequests = b.state.requests.length;
  assert.equal(b.auth.disconnect().status, 'disconnected');
  assert.equal(second.grant().value, null);
  assert.equal(b.state.requests.length, otherRequests);
  assert.equal(first.grant().value.clientId, replacement);
});

test('separate tablet consent preserves the host grant and supplies one private V1 credential', async t => {
  const f = await fixture(t); await f.signIn();
  const original = structuredClone(f.store.grant());
  f.state.signInRefreshToken = tabletRefresh;
  await f.signIn('tablet');
  assert.deepEqual(f.store.grant(), original);
  assert.equal(f.auth.status().status, 'cached');
  const ready = f.auth.tabletAuthorizationStatus();
  assert.equal(ready.status, 'ready'); assert.match(ready.reference, /^[a-f0-9]{64}$/);
  assert.deepEqual(ready.account, { label: 'fixture@example.invalid' });
  assert.equal(JSON.stringify(ready).includes(tabletRefresh), false);
  assert.equal(f.auth.takeTabletAuthorization('0'.repeat(64), collection), null);
  assert.throws(() => f.auth.takeTabletAuthorization(ready.reference, '00000000-0000-0000-0000-000000000000'));
  const credential = f.auth.takeTabletAuthorization(ready.reference, collection);
  const { expires_at, ...fields } = credential;
  assert.deepEqual(fields, { credential_version: 1, client_id: CLIENT, client_secret: null,
    access_token: 'synthetic-access-token', refresh_token: tabletRefresh, scopes: [DRIVE_SCOPE],
    account_permission_id: 'fixture-account', collection });
  assert.ok(Number.isSafeInteger(expires_at) && expires_at > Date.now() / 1000 && expires_at < Date.now() / 1000 + 3700);
  assert.equal(f.auth.takeTabletAuthorization(ready.reference, collection), null);
  assert.deepEqual(f.auth.tabletAuthorizationStatus(), { status: 'consumed', reference: null, account: null });
  assert.deepEqual(f.store.grant(), original);
});

test('tablet authorization requires an existing host grant before opening consent', async t => {
  const f = await fixture(t);
  const result = await f.auth.beginTabletAuthorization();
  assert.equal(result.authorizationUrl, null);
  assert.equal(f.auth.tabletAuthorizationStatus().status, 'unavailable');
  assert.deepEqual(f.state.requests, []);
});

test('tablet exchange refuses duplicate or absent refresh grants and mismatched account, audience or scope', async t => {
  for (const mismatch of ['duplicate', 'missing', 'account', 'audience', 'scope', 'extra-scope']) {
    const f = await fixture(t); await f.signIn(); const original = structuredClone(f.store.grant());
    f.state.signInRefreshToken = mismatch === 'duplicate' ? secret : mismatch === 'missing' ? null : tabletRefresh;
    if (mismatch === 'account') f.state.account = 'other-user';
    if (mismatch === 'audience') f.state.audience = 'other-client';
    if (mismatch === 'scope') f.state.scope = 'openid';
    if (mismatch === 'extra-scope') f.state.scope = `${DRIVE_SCOPE} openid`;
    await f.signIn('tablet');
    assert.equal(f.auth.tabletAuthorizationStatus().status, 'unavailable', mismatch);
    assert.equal(f.auth.takeTabletAuthorization('0'.repeat(64), collection), null);
    assert.deepEqual(f.store.grant(), original);
  }
});

test('changed protected host records fence tablet exchange and later private take', async t => {
  for (const when of ['exchange', 'take']) {
    for (const record of ['client', 'grant']) {
      const f = await fixture(t); await f.signIn(); f.state.signInRefreshToken = tabletRefresh;
      const change = () => {
        if (record === 'client') {
          const original = f.store.client();
          f.store.client = () => ({ value: { ...original.value, clientSecret: 'synthetic-new-registration' }, digest: 'changed-client' });
        } else {
          const original = f.store.grant(); const changed = structuredClone(original.value);
          changed.checkedAt++;
          f.store.save(changed, f.store.client().digest, original.digest);
        }
      };
      if (when === 'exchange') f.state.beforeAbout = change;
      await f.signIn('tablet');
      const reference = f.auth.tabletAuthorizationStatus().reference;
      if (when === 'take') { assert.ok(reference); change(); }
      assert.equal(f.auth.takeTabletAuthorization(reference, collection), null);
      assert.equal(f.auth.tabletAuthorizationStatus().status, 'unavailable');
      assert.equal(f.store.grant().value.tokens.refresh_token, secret);
    }
  }
});

test('authentication ownership changes retire a ready tablet grant', async t => {
  for (const action of ['cancel', 'check', 'begin', 'disconnect', 'revoke', 'dispose']) {
    const f = await fixture(t); await f.signIn(); f.state.signInRefreshToken = tabletRefresh;
    await f.signIn('tablet'); const ready = f.auth.tabletAuthorizationStatus();
    assert.equal(ready.status, 'ready');
    await f.auth[action](f.auth.status().authorizationId);
    assert.equal(f.auth.takeTabletAuthorization(ready.reference, collection), null, action);
    assert.equal(f.auth.tabletAuthorizationStatus().reference, null);
  }
});

test('cancelled tablet exchange cannot restore pending credentials after a late response', async t => {
  const f = await fixture(t); await f.signIn(); const original = structuredClone(f.store.grant());
  f.state.signInRefreshToken = tabletRefresh; f.state.gate = deferred();
  const { callback } = await f.begin('tablet'); callback.searchParams.set('code', 'synthetic-code'); await fetch(callback);
  for (let i = 0; i < 100 && f.state.tokens < 2; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.state.tokens, 2); f.auth.cancel(); f.state.gate.resolve();
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(f.auth.tabletAuthorizationStatus(), { status: 'cancelled', reference: null, account: null });
  assert.deepEqual(f.store.grant(), original);
});

test('ready tablet grant expires without changing the saved host credentials', async t => {
  const f = await fixture(t); await f.signIn(); const original = structuredClone(f.store.grant());
  f.state.signInRefreshToken = tabletRefresh; f.auth.ttlMs = 200;
  await f.signIn('tablet'); const ready = f.auth.tabletAuthorizationStatus(); assert.equal(ready.status, 'ready');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(f.auth.tabletAuthorizationStatus().status, 'expired');
  assert.equal(f.auth.takeTabletAuthorization(ready.reference, collection), null);
  assert.deepEqual(f.store.grant(), original);
});

test('expiry during synchronous protected reads refuses the private handoff', async t => {
  const f = await fixture(t); await f.signIn();
  let now = Date.now(); const started = now;
  t.mock.method(Date, 'now', () => now);
  f.auth.ttlMs = 1000; f.state.signInRefreshToken = tabletRefresh;
  await f.signIn('tablet'); const ready = f.auth.tabletAuthorizationStatus();
  assert.equal(ready.status, 'ready');
  const client = f.store.client.bind(f.store);
  f.store.client = () => { now += 2; return client(); };
  now = started + 999;
  assert.equal(f.auth.takeTabletAuthorization(ready.reference, collection), null);
  assert.deepEqual(f.auth.tabletAuthorizationStatus(), { status: 'expired', reference: null, account: null });
});
function expireGrant(store) {
  const original = store.grant();
  const expired = structuredClone(original.value);
  expired.tokens.expiry_date = Date.now() - 1;
  store.save(expired, store.client().digest, original.digest);
  return store.grant();
}

test('actual maintained PKCE/token/scope/about flow commits guarded host grant; restart is cached, never backup-ready', async t => {
  const f = await fixture(t); assert.equal(f.auth.status().status, 'disconnected'); await f.signIn();
  assert.equal(f.auth.status().status, 'connected'); assert.equal(f.auth.status().account.label, 'fixture@example.invalid');
  assert.equal(f.auth.status().backupReady, false); assert.equal(JSON.stringify(f.auth.status()).includes(secret), false);
  const saved = f.store.grant(); assert.equal(saved.value.tokens.refresh_token, secret);
  assert.deepEqual(f.state.requests.map(r => r.path), ['/token', '/tokeninfo', '/about']);
  const restarted = new DriveAuth({ store: f.store }); assert.equal(restarted.status().status, 'cached'); restarted.dispose();
});
test('callback state, duplicate state, wrong path, and denial do not call token API or replace a prior grant', async t => {
  const f = await fixture(t); await f.signIn(); const original = f.store.grant().digest; f.state.requests.length = 0;
  const { callback } = await f.begin(); const wrong = new URL(callback); wrong.searchParams.set('state', '0'.repeat(64)); wrong.searchParams.set('code', 'synthetic-code');
  assert.equal((await fetch(wrong)).status, 400);
  const duplicate = new URL(callback); duplicate.searchParams.append('state', duplicate.searchParams.get('state')); duplicate.searchParams.set('code', 'synthetic-code'); assert.equal((await fetch(duplicate)).status, 400);
  const wrongPath = new URL(callback); wrongPath.pathname = '/other'; wrongPath.searchParams.set('code', 'synthetic-code'); assert.equal((await fetch(wrongPath)).status, 400);
  callback.searchParams.set('error', 'access_denied'); assert.equal((await fetch(callback)).status, 200);
  assert.equal(f.auth.status().status, 'denied'); assert.equal(f.store.grant().digest, original); assert.deepEqual(f.state.requests, []);
});
test('wrong actual token scope or audience refuses even a successful token endpoint response', async t => {
  for (const mismatch of ['scope', 'audience']) {
    const f = await fixture(t); if (mismatch === 'scope') f.state.scope = 'openid'; else f.state.audience = 'wrong-client';
    await f.signIn(); assert.equal(f.auth.state.status, 'authorization-failed'); assert.equal(f.store.grant().value, null);
    assert.equal(f.state.requests.some(r => r.path === '/about'), false);
  }
});
test('deferred actual token response after cancel or disconnect cannot resurrect credentials', async t => {
  for (const action of ['cancel', 'disconnect']) {
    const f = await fixture(t); f.state.gate = deferred(); const { callback } = await f.begin(); callback.searchParams.set('code', 'synthetic-code'); await fetch(callback);
    for (let i = 0; i < 100 && !f.state.tokens; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(f.state.tokens, 1);
    f.auth[action](); f.state.gate.resolve(); await new Promise(r => setTimeout(r, 30)); assert.equal(f.store.grant().value, null);
    assert.equal(f.state.requests.some(r => r.path === '/about'), false);
  }
});
test('reauth/account failure preserves prior bytes; actual provider refresh and changed-account checks are distinct', async t => {
  const f = await fixture(t); await f.signIn(); let original = f.store.grant();
  f.state.scope = 'openid'; await f.signIn(); assert.equal(f.store.grant().digest, original.digest);
  f.state.scope = DRIVE_SCOPE;
  expireGrant(f.store); f.state.requests.length = 0;
  assert.equal((await f.auth.check()).status, 'connected'); assert.deepEqual(f.state.requests.map(r => r.path), ['/token', '/tokeninfo', '/about']);
  original = f.store.grant(); f.state.account = 'different-account'; assert.equal((await f.auth.check()).status, 'authorization-failed'); assert.equal(f.store.grant().digest, original.digest);
});
test('actual provider rotation is saved and the next refresh uses it even when the response omits a token', async t => {
  const f = await fixture(t);
  await f.signIn();
  const replacement = 'synthetic-rotated-refresh-credential';
  f.state.refreshToken = replacement;
  expireGrant(f.store);
  const refreshed = await f.auth.check();
  assert.equal(refreshed.status, 'connected');
  assert.equal(f.store.grant().value.tokens.refresh_token, replacement);
  assert.equal(JSON.stringify(refreshed).includes(replacement), false);

  delete f.state.refreshToken;
  expireGrant(f.store);
  assert.equal((await f.auth.check()).status, 'connected');
  assert.deepEqual(f.state.refreshRequests, [secret, replacement]);
  assert.equal(f.store.grant().value.tokens.refresh_token, replacement);
});
test('only a rejected refresh grant asks for a new sign-in and preserves the saved account', async t => {
  const f = await fixture(t);
  await f.signIn();
  const original = expireGrant(f.store);
  for (const [status, code, detail] of [
    [400, 'invalid_grant', 'authorization-required'],
    [503, 'temporarily_unavailable', 'authorization-failed'],
    [400, 'invalid_client', 'authorization-failed'],
  ]) {
    f.state.refreshFailure = {status, code};
    const result = await f.auth.check();
    assert.equal(result.status, 'authorization-failed');
    assert.equal(result.error, detail);
    assert.equal(result.checkedAt, new Date(original.value.checkedAt).toISOString());
    assert.equal(f.store.grant().digest, original.digest);
    assert.equal(JSON.stringify(result).includes('private provider detail'), false);
  }
});
test('a malformed refresh token or a changed account preserves the original grant', async t => {
  for (const [replacement, account] of [[null, 'fixture-account'], ['synthetic-rotation', 'different-account']]) {
    const f = await fixture(t);
    await f.signIn();
    const original = expireGrant(f.store);
    f.state.refreshToken = replacement;
    f.state.account = account;
    const result = await f.auth.check();
    assert.equal(result.status, 'authorization-failed');
    assert.equal(f.store.grant().digest, original.digest);
  }
});
test('cancellation after receiving a rotated token preserves the original grant', async t => {
  const f = await fixture(t);
  await f.signIn();
  const original = expireGrant(f.store);
  f.state.refreshToken = 'synthetic-cancelled-rotation';
  const reachedAbout = deferred();
  const releaseAbout = deferred();
  f.state.beforeAbout = () => { reachedAbout.resolve(); return releaseAbout.promise; };
  const checking = f.auth.check();
  try {
    await Promise.race([reachedAbout.promise, checking.then(() => assert.fail('Account check did not start'))]);
    assert.equal(f.auth.cancel().status, 'cancelled');
  } finally {
    releaseAbout.resolve();
  }
  assert.equal((await checking).status, 'cancelled');
  assert.equal(f.store.grant().digest, original.digest);
});
test('local disconnect never calls revoke; explicit failed revoke preserves custody and reports uncertainty without leaking errors', async t => {
  const f = await fixture(t); await f.signIn(); const original = f.store.grant().digest; f.state.revokeFail = true;
  const outcome = await f.auth.revoke(f.auth.status().authorizationId); assert.equal(outcome.status, 'revocation-unconfirmed'); assert.equal(JSON.stringify(outcome).includes(secret), false); assert.equal(f.store.grant().digest, original);
  const calls = f.state.requests.length; f.auth.disconnect(); assert.equal(f.store.grant().value, null); assert.equal(f.state.requests.length, calls);
  f.state.revokeFail = false; await f.signIn(); assert.equal((await f.auth.revoke(f.auth.status().authorizationId)).status, 'disconnected'); assert.equal(f.store.grant().value, null);
});
test('oversized or redirected actual OAuth response refuses without following the redirect', async t => {
  for (const flag of ['oversize', 'redirect']) { const f = await fixture(t); f.state[flag] = true; await f.signIn(); assert.equal(f.auth.state.status, 'authorization-failed'); assert.equal(f.store.grant().value, null); assert.equal(f.state.requests.length, 1); }
});
test('interactive TTL closes the owned callback listener without publishing credentials', async t => {
  const f = await fixture(t, { ttlMs: 30 }); const { callback } = await f.begin(); await new Promise(r => setTimeout(r, 60)); assert.equal(f.auth.status().status, 'expired'); await assert.rejects(fetch(callback)); assert.equal(f.store.grant().value, null);
});
test('real private storage refuses insecure modes, links, stale CAS without widening permissions', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t); await f.signIn(); const before = await readFile(path.join(f.root, 'grant.json'));
  assert.throws(() => f.store.save({}, '0'.repeat(64), f.store.grant().digest), /storage-unavailable/); assert.deepEqual(await readFile(path.join(f.root, 'grant.json')), before);
  await chmod(path.join(f.root, 'grant.json'), 0o644); assert.throws(() => f.store.grant(), /storage-unavailable/); await chmod(path.join(f.root, 'grant.json'), 0o600);
  await rm(path.join(f.root, 'grant.json')); await symlink(path.join(f.root, 'client.json'), path.join(f.root, 'grant.json')); assert.throws(() => f.store.grant(), /storage-unavailable/);
});

test('opaque confirmation refuses a changed grant or stale account before provider revocation', async t => {
  const f = await fixture(t); await f.signIn(); const id = f.auth.status().authorizationId; const saved = f.store.grant();
  const changed = structuredClone(saved.value); changed.account.permissionId = 'newer-account'; changed.account.label = 'newer@example.invalid';
  f.store.save(changed, f.store.client().digest, saved.digest); const count = f.state.requests.length;
  assert.equal((await f.auth.revoke(id)).status, 'revocation-unconfirmed'); assert.equal(f.state.requests.length, count);
  assert.equal(f.store.grant().value.account.permissionId, 'newer-account');
});
