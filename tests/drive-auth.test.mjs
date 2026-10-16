import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { DriveAuth, DRIVE_SCOPE } = await import(process.env.MANAGER_DRIVE_BUNDLE ? pathToFileURL(path.resolve(process.env.MANAGER_DRIVE_BUNDLE)).href : '../host/drive-auth.mjs');
import { DriveStore } from '../host/drive-store.mjs';

const CLIENT = '123456789012-fixture.apps.googleusercontent.com';
const config = { schema: 1, type: 'google-desktop', clientId: CLIENT, clientSecret: null };
const secret = 'synthetic-refresh-credential-only';
const python = process.env.MANAGER_DRIVE_PYTHON ?? (process.platform === 'linux' ? '/usr/bin/python3' : null);
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'manager-drive-auth-'));
  if (process.platform === 'win32') {
    // Native custody has its own real NTFS fixtures; protocol tests use a plain in-memory store below.
    await rm(root, { recursive: true });
  } else { await chmod(root, 0o700); await writeFile(path.join(root, 'client.json'), JSON.stringify(config), { mode: 0o600 }); }
  const state = { requests: [], scope: DRIVE_SCOPE, account: 'fixture-account', label: 'fixture@example.invalid', tokens: 0, gate: null };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1'); let body = ''; for await (const chunk of req) body += chunk;
    state.requests.push({ method: req.method, path: u.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/token') {
      const fields = new URLSearchParams(body); state.tokens++;
      if (fields.get('grant_type') === 'authorization_code') {
        assert.equal(fields.get('client_id'), CLIENT); assert.equal(fields.get('code'), 'synthetic-code');
        assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), state.challenge);
      } else assert.equal(fields.get('refresh_token'), secret);
      if (state.gate) await state.gate.promise;
      if (state.oversize) return res.end('x'.repeat(65537));
      if (state.redirect) { res.writeHead(302, { Location: '/forbidden' }).end(); return; }
      res.end(JSON.stringify({ access_token: 'synthetic-access-token', refresh_token: secret, expires_in: 3600, token_type: 'Bearer', scope: state.scope }));
    } else if (u.pathname === '/tokeninfo') res.end(JSON.stringify({ aud: state.audience ?? CLIENT, scope: state.scope, expires_in: 3600 }));
    else if (u.pathname === '/about') res.end(JSON.stringify({ user: { permissionId: state.account, emailAddress: state.label } }));
    else if (u.pathname === '/revoke') {
      assert.equal(u.searchParams.get('token'), secret);
      res.writeHead(state.revokeFail ? 503 : 200).end(state.revokeFail ? JSON.stringify({ error: secret }) : '{}');
    } else { res.writeHead(404).end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let store;
  if (process.platform === 'win32') {
    let saved = null, digest = null;
    store = { client: () => ({ value: config, digest: 'fixture-client' }), grant: () => ({ value: saved, digest }),
      save: (value, clientDigest, previous) => { assert.equal(clientDigest, 'fixture-client'); assert.equal(previous, digest); saved = value; digest = createHash('sha256').update(JSON.stringify(value)).digest('hex'); return { committed: true, digest }; },
      disconnect: (_, expected) => { assert.equal(expected, digest); saved = null; digest = null; return { committed: true, digest }; } };
  } else store = new DriveStore({ root, python });
  const auth = new DriveAuth({ store, endpoints: Object.fromEntries(['authorization', 'token', 'tokenInfo', 'revoke', 'about'].map((key, i) => [key, origin + ['/authorize', '/token', '/tokeninfo', '/revoke', '/about'][i]])), ...options });
  t.after(async () => { auth.dispose(); state.gate?.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (process.platform !== 'win32') await rm(root, { recursive: true, force: true }); });
  async function begin() {
    const result = await auth.begin(); assert.equal(result.state.status, 'connecting');
    const url = new URL(result.authorizationUrl); state.challenge = url.searchParams.get('code_challenge');
    assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(url.searchParams.get('redirect_uri')); callback.searchParams.set('state', url.searchParams.get('state'));
    return { result, callback };
  }
  async function signIn() { const { callback } = await begin(); callback.searchParams.set('code', 'synthetic-code'); assert.equal((await fetch(callback)).status, 200); await settled(auth); }
  return { auth, root, store, state, begin, signIn };
}
async function settled(auth) { for (let i = 0; i < 200 && ['connecting', 'checking', 'revoking'].includes(auth.state.status); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(!['connecting', 'checking', 'revoking'].includes(auth.state.status)); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

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
  const expired = structuredClone(original.value); expired.tokens.expiry_date = Date.now() - 1;
  f.store.save(expired, f.store.client().digest, original.digest); f.state.requests.length = 0;
  assert.equal((await f.auth.check()).status, 'connected'); assert.deepEqual(f.state.requests.map(r => r.path), ['/token', '/tokeninfo', '/about']);
  original = f.store.grant(); f.state.account = 'different-account'; assert.equal((await f.auth.check()).status, 'authorization-failed'); assert.equal(f.store.grant().digest, original.digest);
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
