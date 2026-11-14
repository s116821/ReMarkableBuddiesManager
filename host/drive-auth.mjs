import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { DriveStore } from './drive-store.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_ENDPOINTS = Object.freeze({ authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token', tokenInfo: 'https://oauth2.googleapis.com/tokeninfo',
  revoke: 'https://oauth2.googleapis.com/revoke', about: 'https://www.googleapis.com/drive/v3/about' });
const endpointKeys = Object.keys(GOOGLE_ENDPOINTS).sort().join();
const require = (ok, code = 'authorization-failed') => { if (!ok) throw new Error(code); };
const text = (v, maximum = 16384) => typeof v === 'string' && v.length > 0 && v.length <= maximum && /^[\x21-\x7e]+$/.test(v);
function registration(record) {
  if (record.value === null) return null;
  const v = record.value;
  require(v && Object.keys(v).sort().join() === 'clientId,clientSecret,schema,type' && v.schema === 1 && v.type === 'google-desktop' &&
    typeof v.clientId === 'string' && /^[A-Za-z0-9_-]{10,180}\.apps\.googleusercontent\.com$/.test(v.clientId) &&
    (v.clientSecret === null || text(v.clientSecret, 1024)), 'configuration-unavailable');
  return v;
}
function grant(record, config) {
  if (record.value === null) return null;
  const v = record.value;
  require(v && Object.keys(v).sort().join() === 'account,checkedAt,clientId,schema,tokens' && v.schema === 1 && v.clientId === config.clientId &&
    v.account && Object.keys(v.account).sort().join() === 'label,permissionId' && text(v.account.permissionId, 200) &&
    typeof v.account.label === 'string' && v.account.label.length <= 320 && !/[\x00-\x1f\x7f]/.test(v.account.label) &&
    Number.isSafeInteger(v.checkedAt) && v.checkedAt > 0, 'credentials-unavailable');
  tokens(v.tokens, false);
  return v;
}
function tokens(v, fresh = true) {
  require(v && Object.keys(v).sort().join() === 'access_token,expiry_date,refresh_token,scope,token_type' &&
    text(v.access_token) && text(v.refresh_token) && v.token_type === 'Bearer' && typeof v.scope === 'string' &&
    v.scope.split(' ').includes(DRIVE_SCOPE) && Number.isSafeInteger(v.expiry_date) && v.expiry_date > 0 &&
    (!fresh || (v.expiry_date > Date.now() && v.expiry_date <= Date.now() + 86400000)), 'authorization-required');
  return v;
}
const publicState = (status, account = null, checkedAt = null, error = null) => Object.freeze({ contract_version: 1, status,
  account: account ? { label: account.label } : null, checkedAt, error, authorizationId: null, backupReady: false });

export class DriveAuth {
  #readFactory;
  #freshRead = null;
  #disposed = false;
  constructor({ store = new DriveStore(), endpoints = GOOGLE_ENDPOINTS, ttlMs = 300000, requestMs = 15000, backupReadFactory = null } = {}) {
    require(Object.keys(endpoints).sort().join() === endpointKeys, 'configuration-unavailable');
    // Constructor-only trusted test seam. Product callers never receive endpoints/client/path arguments.
    if (endpoints !== GOOGLE_ENDPOINTS) {
      const urls = Object.values(endpoints).map(v => new URL(v));
      require(urls.every(u => u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.origin === urls[0].origin && !u.username && !u.password), 'configuration-unavailable');
    }
    this.store = store; this.endpoints = Object.freeze({ ...endpoints }); this.ttlMs = ttlMs; this.requestMs = requestMs;
    this.generation = 0; this.flow = null; this.work = null; this.state = publicState('unconfigured'); this.freshDigest = null;
    require(backupReadFactory === null || typeof backupReadFactory === 'function', 'configuration-unavailable');
    this.#readFactory = backupReadFactory;
  }
  snapshot() {
    const clientRecord = this.store.client(); const config = registration(clientRecord);
    if (!config) return { config: null, clientRecord, grantRecord: { value: null, digest: null }, saved: null };
    const grantRecord = this.store.grant(); return { config, clientRecord, grantRecord, saved: grant(grantRecord, config) };
  }
  status() {
    if (this.flow || this.work || ['cancelled', 'expired', 'denied', 'authorization-failed', 'revocation-unconfirmed'].includes(this.state.status)) return this.state;
    try {
      const snapshot = this.snapshot(); const { config, saved, grantRecord } = snapshot;
      if (!config) return this.state = publicState('unconfigured');
      if (!saved) return this.state = publicState('disconnected');
      if (this.freshDigest === grantRecord.digest && this.state.status === 'connected' && saved.tokens.expiry_date > Date.now()) return this.state;
      return this.publish('cached', saved.account, saved.checkedAt, snapshot);
    } catch { return this.state = publicState('unavailable', null, null, 'storage-unavailable'); }
  }
  publish(status, account, checkedAt, snapshot) {
    if (!this.authorization || this.authorization.clientDigest !== snapshot.clientRecord.digest || this.authorization.grantDigest !== snapshot.grantRecord.digest) {
      this.authorization = { id: randomBytes(32).toString('hex'), clientDigest: snapshot.clientRecord.digest, grantDigest: snapshot.grantRecord.digest };
    }
    return this.state = Object.freeze({ ...publicState(status, account, new Date(checkedAt).toISOString()), authorizationId: this.authorization.id });
  }
  #recordFreshRead(clientDigest, grantDigest, expiry) {
    if (!this.#readFactory || this.#disposed) return;
    const original = { clientDigest, grantDigest, expiry, generation: this.generation, controller: new AbortController() };
    original.timer = setTimeout(() => {
      if (this.#freshRead === original) this.#invalidateRead();
    }, Math.max(1, expiry - Date.now()));
    original.timer.unref();
    this.#freshRead = original;
  }
  #invalidateRead() {
    const original = this.#freshRead;
    this.#freshRead = null;
    if (original) {
      clearTimeout(original.timer);
      original.controller.abort();
    }
  }
  #readSnapshot(original) {
    if (!original || this.#freshRead !== original || this.#disposed || this.flow || this.work ||
        this.generation !== original.generation || this.state.status !== 'connected') return null;
    try {
      const snapshot = this.snapshot();
      require(snapshot.config && snapshot.saved && snapshot.clientRecord.digest === original.clientDigest &&
        snapshot.grantRecord.digest === original.grantDigest && snapshot.saved.tokens.expiry_date === original.expiry &&
        original.expiry > Date.now());
      return snapshot;
    } catch {
      if (this.#freshRead === original) this.#invalidateRead();
      return null;
    }
  }
  // Host-only. The factory is trusted composition, and can decline namespace
  // qualification for the exact protected registration and grant it receives.
  openBackupRead(signal) {
    if (this.#disposed || signal.aborted) return { status: 'invalidated' };
    if (!this.#readFactory) return { status: 'unqualified' };
    const original = this.#freshRead, snapshot = this.#readSnapshot(original);
    if (!snapshot) return { status: 'unavailable' };
    const authority = AbortSignal.any([signal, original.controller.signal]);
    const current = () => !authority.aborted && !!this.#readSnapshot(original);
    try {
      const binding = this.#readFactory({
        registration: structuredClone(snapshot.config), grant: structuredClone(snapshot.saved),
        clientDigest: original.clientDigest, grantDigest: original.grantDigest, signal: authority,
      });
      if (!current()) return { status: 'invalidated' };
      if (binding === null) return { status: 'unqualified' };
      if (!['list', 'readMetadata', 'readMarker'].every(method => typeof binding?.[method] === 'function')) {
        return { status: 'unavailable' };
      }
      const bind = method => async query => {
        // The reader handles its own request deadline. The protected grant
        // signal also cancels a transport that is still waiting on the provider.
        const active = AbortSignal.any([authority, query.signal]);
        try {
          require(!active.aborted && current());
          return await binding[method]({ ...query, signal: active });
        } finally {
          require(!active.aborted && current());
        }
      };
      const guarded = {
        isCurrent: current, list: bind('list'), readMetadata: bind('readMetadata'), readMarker: bind('readMarker'),
      };
      // Optional private download capabilities use this exact capture. A
      // metadata-only adapter cannot silently acquire a replacement grant.
      if (['listObject', 'readObjectMetadata', 'streamObject'].every(method => typeof binding[method] === 'function')) {
        guarded.listObject = bind('listObject');
        guarded.readObjectMetadata = bind('readObjectMetadata');
        guarded.streamObject = async function* (query) {
          const controller = new AbortController();
          const active = AbortSignal.any([authority, query.signal, controller.signal]);
          let iterator, completed = false;
          try {
            require(!active.aborted && current());
            const source = await binding.streamObject({...query, signal: active});
            // Take custody before checking a late factory result, so an abort
            // while opening the response still closes and joins that response.
            iterator = source?.[Symbol.asyncIterator]?.();
            require(iterator && typeof iterator.next === 'function' && typeof iterator.return === 'function');
            for (;;) {
              require(!active.aborted && current());
              const item = await iterator.next();
              require(!active.aborted && current());
              if (item.done) { completed = true; return; }
              yield item.value;
            }
          } finally {
            // Abort before return(): a producer can be waiting for its abort
            // while its return promise joins the outstanding request.
            controller.abort();
            if (typeof iterator?.return === 'function') await iterator.return();
            if (completed) require(!query.signal.aborted && current());
          }
        };
      }
      return { status: 'qualified', signal: authority, binding: Object.freeze(guarded) };
    } catch { return { status: authority.aborted ? 'invalidated' : 'unavailable' }; }
  }
  stop() {
    this.generation++; this.#invalidateRead(); this.work?.abort(); this.work = null;
    if (this.flow) { clearTimeout(this.flow.timer); this.flow.abort.abort(); this.flow.server?.closeAllConnections(); this.flow.server?.close(); }
    this.flow = null;
  }
  cancel() { const pending = Boolean(this.flow || this.work); this.stop(); if (pending) this.state = publicState('cancelled'); return this.state; }
  ownsAuthorizationUrl(url) { return Boolean(this.flow && this.flow.url === url); }
  oauth(config, redirectUri, signal) {
    const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret ?? undefined, redirectUri,
      useAuthRequestParameters: false, endpoints: { oauth2AuthBaseUrl: this.endpoints.authorization, oauth2TokenUrl: this.endpoints.token,
        oauth2RevokeUrl: this.endpoints.revoke, tokenInfoUrl: this.endpoints.tokenInfo } });
    const original = client.transporter.request.bind(client.transporter);
    client.transporter.request = options => {
      const target = new URL(options.url);
      require(Object.values(this.endpoints).some(v => { const u = new URL(v); return u.origin === target.origin && u.pathname === target.pathname; }));
      // Enforce policy on every library call, overriding its default retry configuration.
      return original({ ...options, signal, timeout: this.requestMs, maxContentLength: 65536, maxRedirects: 0,
        retry: false, retryConfig: { retry: 0 }, responseType: 'json' });
    };
    return client;
  }
  async begin() {
    this.stop(); const generation = this.generation;
    try {
      const baseline = this.snapshot(); require(baseline.config, 'configuration-unavailable');
      const abort = new AbortController(); const oauth = this.oauth(baseline.config, undefined, abort.signal);
      const pkce = await oauth.generateCodeVerifierAsync();
      require(generation === this.generation, 'cancelled');
      const flow = { ...baseline, generation, abort, oauth, verifier: pkce.codeVerifier, state: randomBytes(32).toString('hex'), consumed: false };
      flow.server = createServer((req, res) => this.callback(flow, req, res));
      flow.server.requestTimeout = 3000; flow.server.headersTimeout = 3000; flow.server.maxHeadersCount = 32;
      await new Promise((resolve, reject) => { flow.server.once('error', reject); flow.server.listen(0, '127.0.0.1', resolve); });
      if (generation !== this.generation) { flow.server.close(); throw new Error('cancelled'); }
      flow.redirect = `http://127.0.0.1:${flow.server.address().port}/oauth/callback`;
      flow.oauth.redirectUri = flow.redirect;
      flow.url = flow.oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', scope: DRIVE_SCOPE,
        state: flow.state, code_challenge: pkce.codeChallenge, code_challenge_method: 'S256' });
      require(flow.url.length <= 4096);
      flow.timer = setTimeout(() => { if (this.flow === flow) { this.stop(); this.state = publicState('expired'); } }, this.ttlMs);
      flow.timer.unref(); this.flow = flow; this.state = publicState('connecting');
      return { state: this.state, authorizationUrl: flow.url };
    } catch (error) { if (generation === this.generation) this.state = publicState('unavailable', null, null, ['configuration-unavailable', 'cancelled'].includes(error.message) ? error.message : 'storage-unavailable');
      return { state: this.state, authorizationUrl: null }; }
  }
  callback(flow, req, res) {
    const finish = code => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }).end(code === 200 ? 'Return to the Manager to see the sign-in result.' : 'Sign-in response refused.'); };
    try {
      require(this.flow === flow && flow.generation === this.generation && !flow.consumed && req.method === 'GET' &&
        req.socket.remoteAddress === '127.0.0.1' && req.headers.host === new URL(flow.redirect).host &&
        !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0') && req.url.length <= 8192);
      const u = new URL(req.url, flow.redirect); require(u.pathname === '/oauth/callback');
      const permitted = new Set(['state', 'code', 'scope', 'authuser', 'prompt', 'iss', 'error', 'error_description', 'error_uri']);
      const keys = [...u.searchParams.keys()]; require(keys.every(k => permitted.has(k)) && new Set(keys).size === keys.length);
      const state = u.searchParams.get('state'); require(typeof state === 'string' && state.length === flow.state.length &&
        timingSafeEqual(Buffer.from(state), Buffer.from(flow.state)));
      require(!u.searchParams.has('iss') || u.searchParams.get('iss') === 'https://accounts.google.com');
      require(u.searchParams.has('error') !== u.searchParams.has('code'));
      if (u.searchParams.has('error')) {
        flow.consumed = true; finish(200); this.stop(); this.state = publicState('denied'); return;
      }
      const code = u.searchParams.get('code'); require(text(code, 4096));
      flow.consumed = true; finish(200); flow.server.close();
      void this.exchange(flow, code);
    } catch { finish(400); }
  }
  current(flow) { return this.flow === flow && this.generation === flow.generation && !flow.abort.signal.aborted; }
  async account(oauth, credentials, expectedClient, priorAccount = null) {
    require(text(credentials.access_token), 'authorization-required');
    const info = await oauth.getTokenInfo(credentials.access_token);
    require(info.aud === expectedClient && Array.isArray(info.scopes) && info.scopes.includes(DRIVE_SCOPE) &&
      Number.isSafeInteger(info.expiry_date) && info.expiry_date > Date.now() && info.expiry_date <= Date.now() + 86400000, 'scope-or-client-refused');
    const about = new URL(this.endpoints.about); about.searchParams.set('fields', 'user(permissionId,emailAddress,displayName)');
    const response = await oauth.transporter.request({ url: about.href, method: 'GET', headers: { Authorization: `Bearer ${credentials.access_token}` } });
    const user = response.data?.user;
    require(user && text(user.permissionId, 200) && (!priorAccount || user.permissionId === priorAccount.permissionId), 'account-refused');
    const label = user.emailAddress ?? user.displayName ?? 'Google account';
    require(typeof label === 'string' && label.length > 0 && label.length <= 320 && !/[\x00-\x1f\x7f]/.test(label), 'account-refused');
    const clean = { access_token: credentials.access_token, refresh_token: credentials.refresh_token,
      expiry_date: info.expiry_date, token_type: 'Bearer', scope: [...new Set(info.scopes)].sort().join(' ') };
    tokens(clean); return { account: { permissionId: user.permissionId, label }, tokens: clean };
  }
  save(flow, observed) {
    require(this.current(flow), 'cancelled');
    const value = { schema: 1, clientId: flow.config.clientId, ...observed, checkedAt: Date.now() };
    const committed = this.store.save(value, flow.clientRecord.digest, flow.grantRecord.digest);
    require(committed.committed && typeof committed.digest === 'string', 'storage-unavailable');
    this.freshDigest = committed.digest; this.publish('connected', value.account, value.checkedAt, { clientRecord: flow.clientRecord, grantRecord: { digest: committed.digest } });
    this.#recordFreshRead(flow.clientRecord.digest, committed.digest, value.tokens.expiry_date);
  }
  async exchange(flow, code) {
    try {
      const response = await flow.oauth.getToken({ code, codeVerifier: flow.verifier, redirect_uri: flow.redirect });
      require(this.current(flow), 'cancelled'); require(text(response.tokens.refresh_token), 'authorization-required');
      const observed = await this.account(flow.oauth, response.tokens, flow.config.clientId);
      this.save(flow, observed);
    } catch { if (this.current(flow)) this.state = publicState('authorization-failed', flow.saved?.account ?? null, flow.saved ? new Date(flow.saved.checkedAt).toISOString() : null, 'authorization-failed'); }
    finally { if (this.flow === flow) { clearTimeout(flow.timer); this.flow = null; } flow.server.close(); }
  }
  async check() {
    this.stop(); const generation = this.generation; let baseline;
    try {
      baseline = this.snapshot(); require(baseline.config && baseline.saved, 'authorization-required');
      const abort = new AbortController(); this.work = abort; this.state = publicState('checking');
      const oauth = this.oauth(baseline.config, undefined, abort.signal); oauth.setCredentials(baseline.saved.tokens);
      let credentials = baseline.saved.tokens;
      if (credentials.expiry_date <= Date.now() + 60000) credentials = (await oauth.refreshAccessToken()).credentials;
      const observed = await this.account(oauth, credentials, baseline.config.clientId, baseline.saved.account);
      require(generation === this.generation && !abort.signal.aborted, 'cancelled');
      const committed = this.store.save({ schema: 1, clientId: baseline.config.clientId, ...observed, checkedAt: Date.now() }, baseline.clientRecord.digest, baseline.grantRecord.digest);
      require(committed.committed && typeof committed.digest === 'string', 'storage-unavailable');
      this.freshDigest = committed.digest; this.publish('connected', observed.account, Date.now(), { clientRecord: baseline.clientRecord, grantRecord: { digest: committed.digest } });
      this.#recordFreshRead(baseline.clientRecord.digest, committed.digest, observed.tokens.expiry_date);
    } catch { if (generation === this.generation) this.state = publicState('authorization-failed', baseline?.saved?.account ?? null, baseline?.saved ? new Date(baseline.saved.checkedAt).toISOString() : null, 'authorization-required'); }
    finally { if (generation === this.generation) this.work = null; }
    return this.state;
  }
  disconnect() {
    this.stop(); this.freshDigest = null;
    try { const s = this.snapshot(); require(s.config, 'configuration-unavailable'); this.store.disconnect(s.clientRecord.digest, s.grantRecord.digest); this.state = publicState('disconnected'); }
    catch { this.state = publicState('unavailable', null, null, 'storage-unavailable'); }
    return this.state;
  }
  async revoke(authorizationId) {
    const expected = this.authorization; this.authorization = null;
    this.stop(); const generation = this.generation; let s;
    try {
      s = this.snapshot(); require(s.config && s.saved && expected && expected.id === authorizationId &&
        expected.clientDigest === s.clientRecord.digest && expected.grantDigest === s.grantRecord.digest, 'authorization-required');
      const abort = new AbortController(); this.work = abort; this.state = publicState('revoking');
      const oauth = this.oauth(s.config, undefined, abort.signal); await oauth.revokeToken(s.saved.tokens.refresh_token);
      require(generation === this.generation && !abort.signal.aborted, 'cancelled');
      this.store.disconnect(s.clientRecord.digest, s.grantRecord.digest); this.freshDigest = null; this.state = publicState('disconnected');
    } catch { if (generation === this.generation) this.state = publicState('revocation-unconfirmed', s?.saved?.account ?? null, s?.saved ? new Date(s.saved.checkedAt).toISOString() : null, 'revocation-unconfirmed'); }
    finally { if (generation === this.generation) this.work = null; }
    return this.state;
  }
  dispose() { this.#disposed = true; this.stop(); }
}
