// Host-side consent only. The trusted tablet broker owns redemption and tokens.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import * as oauth from 'oauth4webapi';

const ISSUER = 'https://api.capacities.io';
const CALLBACK_PATH = '/oauth/capacities/callback';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 48761;
export const CAPACITIES_REDIRECT = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = ['api:read', 'api:write', 'offline_access'];
const MAX_METADATA = 32768;
const REQUEST_MS = 10000;
const TABLET_READ_MS = 13000;
const TABLET_HANDOFF_MS = 62000;
const CONSENT_MS = 300000;

// A maintainer must record the verified REST client and registered redirect.
// Google, MCP DCR and environment-supplied client IDs have no authority here.
const REGISTRATION = null;

const state = status => Object.freeze({ contract_version: 1, status });
const text = (value, max) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && /^[\x21-\x7e]+$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const keysAre = (object, keys) => Boolean(object && Object.keys(object).length === keys.length &&
  keys.every(key => Object.hasOwn(object, key)));
const require = condition => { if (!condition) throw new Error('Capacities consent refused'); };

function parameters(fixture) {
  if (!fixture) {
    return { issuer: ISSUER, port: CALLBACK_PORT, lifetime: CONSENT_MS, requestMs: REQUEST_MS,
      readMs: TABLET_READ_MS, handoffMs: TABLET_HANDOFF_MS,
      clientId: REGISTRATION?.redirectUri === CAPACITIES_REDIRECT ? REGISTRATION.clientId : null };
  }
  // Constructor-only CI seam. Real broker construction accepts no endpoint or redirect policy.
  const issuer = new URL(fixture.issuer);
  require(issuer.origin === fixture.issuer && issuer.hostname === CALLBACK_HOST &&
    issuer.protocol === 'http:' && issuer.port && text(fixture.clientId, 256));
  const lifetime = fixture.lifetime ?? CONSENT_MS;
  const requestMs = fixture.requestMs ?? REQUEST_MS;
  require(Number.isSafeInteger(lifetime) && lifetime > 0 && lifetime <= CONSENT_MS &&
    Number.isSafeInteger(requestMs) && requestMs > 0 && requestMs <= REQUEST_MS);
  return { issuer: issuer.origin, port: 0, lifetime, requestMs, readMs: requestMs,
    handoffMs: requestMs, clientId: fixture.clientId };
}

function bounded(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Capacities consent interrupted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      require(!signal.aborted);
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function phase(abort, deadline, limit) {
  const stop = Math.min(deadline, performance.now() + limit);
  const remaining = Math.floor(stop - performance.now());
  require(remaining >= 1);
  return { deadline: stop, signal: AbortSignal.any([abort, AbortSignal.timeout(remaining)]) };
}

async function metadata(issuer, signal) {
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
    method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal
  });
  if (response.status !== 200 || !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Capacities metadata refused');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      require(size <= MAX_METADATA);
      chunks.push(value);
    }
  } finally {
    // The abort signal bounds the request. Cancel without waiting for a peer after refusal.
    void reader.cancel().catch(() => {});
  }
  const server = await oauth.processDiscoveryResponse(new URL(issuer),
    new Response(Buffer.concat(chunks, size), { headers: { 'content-type': 'application/json' } }));
  const advertises = (list, expected) => Array.isArray(list) && expected.every(item => list.includes(item));
  require(server.authorization_endpoint === `${issuer}/oauth/authorize` &&
    server.token_endpoint === `${issuer}/oauth/token` &&
    advertises(server.code_challenge_methods_supported, ['S256']) &&
    advertises(server.response_types_supported, ['code']) &&
    advertises(server.grant_types_supported, ['authorization_code']) &&
    advertises(server.token_endpoint_auth_methods_supported, ['none']) &&
    advertises(server.scopes_supported, SCOPES));
  return server;
}

const CAPTURE_KEYS = ['tablet_id', 'connection_id', 'boot_id', 'config_sha256'];
const RECEIPT_KEYS = ['contract_version', ...CAPTURE_KEYS, 'operation_id', 'grant_id', 'status'];
function originalBinding(value, identities) {
  require(keysAre(value, CAPTURE_KEYS) && text(value.tablet_id, 256) &&
    digest(value.connection_id) && uuid(value.boot_id) && digest(value.config_sha256));
  return Object.freeze({ ...value, ...identities });
}
function receiptStatus(value, binding) {
  const committed = value?.status === 'committed';
  const expected = committed ? [...RECEIPT_KEYS, 'installed_config_sha256', 'space_id'] : RECEIPT_KEYS;
  if (!keysAre(value, expected) || value.contract_version !== 1 ||
      !Object.keys(binding).every(key => value[key] === binding[key])) return 'reconcile-required';
  if (committed && digest(value.installed_config_sha256) && uuid(value.space_id)) return 'connected';
  if (value.status === 'not-dispatched') return 'not-dispatched';
  return value.status === 'staged' ? 'staged' : 'reconcile-required';
}

function respond(response, code) {
  response.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Connection': 'close'
  }).end(code === 400 ? 'Sign-in response refused.' : 'Return to the Manager for the sign-in result.');
}

function checkedCallback(request, flow) {
  const host = new URL(flow.redirect).host;
  const hosts = request.headersDistinct.host;
  const lengths = request.headersDistinct['content-length'];
  require(request.method === 'GET' && request.socket.remoteAddress === CALLBACK_HOST &&
    hosts?.length === 1 && hosts[0] === host && !request.headersDistinct['transfer-encoding'] &&
    (!lengths || (lengths.length === 1 && lengths[0] === '0')) &&
    request.url?.startsWith(CALLBACK_PATH + '?') && request.url.length <= 8192);
  const params = new URL(request.url, flow.redirect).searchParams;
  const keys = [...params.keys()];
  const allowed = ['state', 'code', 'iss', 'error', 'error_description', 'error_uri'];
  require(keys.every(key => allowed.includes(key)) && new Set(keys).size === keys.length &&
    params.has('code') !== params.has('error') &&
    (params.has('error') || !(params.has('error_description') || params.has('error_uri'))));
  const actual = params.get('state');
  require(text(actual, 128) && actual.length === flow.state.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(flow.state)));
  try {
    const result = oauth.validateAuthResponse(flow.metadata, { client_id: flow.clientId }, params, flow.state);
    const code = result.get('code');
    require(text(code, 4096));
    return { code };
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError && params.has('error')) {
      return { denial: params.get('error') === 'access_denied' ? 'denied' : 'authorization-failed' };
    }
    throw error;
  }
}

export class CapacitiesConsent {
  #tablet;
  #openAuthorization;
  #policy;
  #flow = null;
  #uncertain = null;
  #statusCheck = null;
  #disposed = false;
  #state;

  constructor({ tablet, openAuthorization, fixture = null } = {}) {
    this.#tablet = tablet;
    this.#openAuthorization = openAuthorization;
    this.#policy = parameters(fixture);
    const ready = text(this.#policy.clientId, 256) && typeof openAuthorization === 'function' &&
      ['capture', 'current', 'handoff', 'status'].every(key => typeof tablet?.[key] === 'function');
    this.#state = state(ready ? 'disconnected' : 'unconfigured');
  }

  status() { return this.#state; }

  #live(flow) {
    return this.#flow === flow && !flow.abort.signal.aborted && performance.now() < flow.deadline;
  }

  #close(flow) {
    flow.server?.close();
    flow.server?.closeAllConnections();
  }

  #finish(flow, status) {
    if (this.#flow !== flow) return;
    this.#flow = null;
    if (status === 'staged' || status === 'reconcile-required') this.#uncertain = flow.binding;
    flow.state = null;
    flow.verifier = null;
    clearTimeout(flow.timer);
    flow.abort.abort();
    this.#close(flow);
    this.#state = state(status);
  }

  cancel() {
    if (this.#flow) {
      this.#finish(this.#flow, this.#flow.dispatched ? 'reconcile-required' : 'canceled');
    }
    return this.#state;
  }

  dispose() {
    this.#disposed = true;
    this.cancel();
    this.#statusCheck?.abort();
  }

  async begin() {
    if (this.#disposed || this.#state.status === 'unconfigured' || this.#flow ||
        this.#uncertain || this.#statusCheck) {
      return this.#state;
    }
    const { clientId, issuer, lifetime, port, requestMs, readMs } = this.#policy;
    const flow = { clientId, abort: new AbortController(), deadline: performance.now() + lifetime,
      state: oauth.generateRandomState(), verifier: oauth.generateRandomCodeVerifier(),
      consumed: false, dispatched: false };
    this.#flow = flow;
    this.#state = state('starting');
    flow.timer = setTimeout(() => this.#finish(flow, flow.dispatched ? 'reconcile-required' : 'expired'), lifetime);
    flow.timer.unref();
    try {
      const identities = Object.freeze({ operation_id: randomUUID(), grant_id: randomUUID() });
      const capture = phase(flow.abort.signal, flow.deadline, readMs);
      const observed = await bounded(() => this.#tablet.capture(identities, capture), capture.signal);
      require(this.#live(flow));
      flow.binding = originalBinding(observed, identities);
      const { signal } = phase(flow.abort.signal, flow.deadline, requestMs);
      flow.metadata = await bounded(() => metadata(issuer, signal), signal);
      const challenge = await oauth.calculatePKCECodeChallenge(flow.verifier);
      require(this.#live(flow));
      flow.server = createServer({ maxHeaderSize: 8192 }, (req, res) => this.#callback(flow, req, res));
      flow.server.requestTimeout = 3000;
      flow.server.headersTimeout = 3000;
      flow.server.maxHeadersCount = 32;
      flow.server.maxRequestsPerSocket = 1;
      flow.server.maxConnections = 4;
      flow.server.setTimeout(3000, socket => socket.destroy());
      await bounded(() => new Promise((resolve, reject) => {
        flow.server.once('error', reject);
        flow.server.listen({ host: CALLBACK_HOST, port, exclusive: true, signal: flow.abort.signal }, resolve);
      }), signal);
      require(this.#live(flow));
      flow.server.on('error', () => this.#finish(flow, flow.dispatched ? 'reconcile-required' : 'authorization-failed'));
      flow.redirect = `http://${CALLBACK_HOST}:${flow.server.address().port}${CALLBACK_PATH}`;
      if (port) require(flow.redirect === CAPACITIES_REDIRECT);
      const url = new URL(flow.metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: flow.redirect, resource: ISSUER,
        scope: SCOPES.join(' '), state: flow.state, code_challenge: challenge, code_challenge_method: 'S256'
      }).toString();
      this.#state = state('awaiting-consent');
      // In browser mode the caller can issue a protected same-origin redirect.
      // Electron main can open the external browser. The URL is not in the result DTO.
      await bounded(() => this.#openAuthorization(url.href, { signal }), signal);
    } catch {
      this.#finish(flow, flow.dispatched ? 'reconcile-required' : 'authorization-failed');
    }
    return this.#state;
  }

  #callback(flow, request, response) {
    if (!this.#live(flow) || flow.consumed) return respond(response, 400);
    let result;
    try {
      result = checkedCallback(request, flow);
    } catch {
      return respond(response, 400);
    }
    flow.consumed = true;
    const verifier = flow.verifier;
    flow.verifier = null;
    flow.state = null;
    // Stop accepting immediately, and let this one bounded response flush.
    let settled = false;
    const continueConsent = () => {
      if (settled || !this.#live(flow)) return;
      settled = true;
      if (result.denial) this.#finish(flow, result.denial);
      else {
        this.#state = state('handing-off');
        void this.#handoff(flow, result.code, verifier);
      }
    };
    response.once('finish', continueConsent);
    response.once('close', continueConsent);
    flow.server.close();
    respond(response, 200);
  }

  async #handoff(flow, code, verifier) {
    try {
      const read = phase(flow.abort.signal, flow.deadline, this.#policy.readMs);
      const current = await bounded(() => this.#tablet.current(flow.binding, read), read.signal);
      require(this.#live(flow) && current === true);
      const proof = Object.freeze({ code, verifier, client_id: flow.clientId,
        redirect_uri: flow.redirect, resource: ISSUER });
      const write = phase(flow.abort.signal, flow.deadline, this.#policy.handoffMs);
      const receipt = await bounded(() => {
        require(this.#live(flow));
        flow.dispatched = true;
        return this.#tablet.handoff(flow.binding, proof, write);
      }, write.signal);
      this.#finish(flow, receiptStatus(receipt, flow.binding));
    } catch {
      this.#finish(flow, flow.dispatched ? 'reconcile-required' : 'selection-changed');
    }
  }

  async reconcile() {
    if (this.#disposed || !this.#uncertain || this.#statusCheck) return this.#state;
    const binding = this.#uncertain;
    const controller = new AbortController();
    this.#statusCheck = controller;
    try {
      const read = phase(controller.signal, Infinity, this.#policy.readMs);
      const receipt = await bounded(() => this.#tablet.status(binding, read), read.signal);
      if (read.signal.aborted) return this.#state;
      const observed = receiptStatus(receipt, binding);
      // A later read of an absent grant cannot settle a possibly sent stdin.
      const status = observed === 'not-dispatched' ? 'reconcile-required' : observed;
      if (status !== 'staged' && status !== 'reconcile-required') this.#uncertain = null;
      this.#state = state(status);
    } catch {
      this.#state = state('reconcile-required');
    } finally {
      this.#statusCheck = null;
    }
    return this.#state;
  }
}
