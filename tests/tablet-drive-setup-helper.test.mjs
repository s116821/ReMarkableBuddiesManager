import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {startHelper} from '../host/browser-helper.mjs';
import {isManagerMainFrame} from '../host/isolated-backup-preferences.mjs';
import {parseTabletDriveSetupRequest, parseTabletDriveSetupResult} from '../host/tablet-drive-setup-protocol.mjs';
import {fixture, identity, consentUrl} from './fixtures/tablet-drive-setup.mjs';

const route = '/manager-tablet-drive';
const channel = 'manager:tabletDriveSetup';
const retained = {action: 'retained'};
const begin = intent => ({action: 'begin', ...identity, intent});
const use = (action, reference) => ({action, ...identity, reference});
const privateFields = ['synthetic-access', 'synthetic-refresh', 'synthetic-client-secret', 'synthetic-account',
  'access_token', 'refresh_token', 'account_permission_id', 'credential_b64', 'binding_sha256', 'mode_token',
  'parent_identity_sha256', 'local_mode_raw'];

function reduced(text) {
  assert.ok(Buffer.byteLength(text) <= 8192);
  for (const field of privateFields) assert.equal(text.includes(field), false, field);
}

async function open(t, f) {
  const helper = await startHelper({root: fileURLToPath(new URL('./fixtures/', import.meta.url)),
    observer: f.observer, driveAuth: f.auth, downloads: {dispose() {}}});
  t.after(() => helper.close());
  const page = await fetch(helper.origin + '/preview/');
  const headers = {Origin: helper.origin, Cookie: page.headers.get('set-cookie').split(';')[0],
    'Content-Type': 'application/json'};
  await page.text();
  const send = (q, suffix = '', override = headers) => fetch(helper.origin + route + suffix, {
    method: 'POST', headers: override, body: typeof q === 'string' || Buffer.isBuffer(q) ? q : JSON.stringify(q)
  });
  const call = async q => {
    const reply = await send(q);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const text = await reply.text();
    reduced(text);
    return parseTabletDriveSetupResult(JSON.parse(text), q).tablet_drive;
  };
  return {...helper, headers, send, call};
}

function rawHttp(url, options, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, reply => {
      reply.resume();
      reply.on('end', () => resolve(reply.statusCode));
      reply.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('actual tablet Drive helper enforces origin, cookie, method, query, strict shape and the 512-byte bound', async t => {
  const f = fixture(), h = await open(t, f);
  for (const headers of [{}, {...h.headers, Origin: 'https://foreign.invalid'},
    {...h.headers, Cookie: 'manager_session=wrong'}, {...h.headers, 'Content-Type': 'text/plain'}]) {
    assert.equal((await h.send(retained, '', headers)).status, 403);
  }
  assert.equal((await fetch(h.origin + route, {headers: h.headers})).status, 403);
  assert.equal((await h.send(retained, '?action=confirm')).status, 403);
  assert.equal(await rawHttp(h.origin + route, {method: 'POST', headers: {...h.headers, Host: 'foreign.invalid'}},
    JSON.stringify(retained)), 403);
  for (const bad of [null, [retained], {action: 'retained', credential_b64: 'synthetic-secret'},
    {...begin('connect'), device: f.original.device}, '{"action":"retained","action":"retained"}', Buffer.from([0xff])]) {
    assert.equal((await h.send(bad)).status, 400);
  }
  const boundary = JSON.stringify(retained).padEnd(512);
  assert.equal((await h.send(boundary)).status, 200);
  assert.equal((await h.send(boundary + ' ')).status, 413);
  assert.equal((await h.send('é'.repeat(257))).status, 413);
  assert.equal(f.auth.generation, 0);
  assert.equal(f.calls.length, 0);
});

test('actual helper exposes reduced connect, confirmation and removal replies', async t => {
  const f = fixture(), h = await open(t, f);
  const authorizing = await h.call(begin('connect'));
  assert.equal(authorizing.state, 'authorizing');
  assert.equal(authorizing.authorizationUrl, consentUrl);
  f.setAuthReady();
  const ready = await h.call(use('poll', authorizing.reference));
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.account, {label: 'Synthetic account'});
  assert.equal((await h.call(use('confirm', ready.reference))).installed, true);
  await h.call(use('confirm', ready.reference));
  assert.equal(f.applyCount, 1);
  const generation = f.auth.generation;
  const remove = await h.call(begin('remove'));
  assert.equal(remove.state, 'ready');
  const removed = await h.call(use('confirm', remove.reference));
  assert.equal(removed.state, 'verified');
  assert.equal(removed.installed, false);
  assert.equal(f.auth.generation, generation);
  assert.deepEqual(f.calls.filter(call => call.request?.action === 'apply').map(call => call.request.change.kind),
    ['create', 'remove']);
});

test('actual helper refuses to deliver a reduced reply above 8 KiB', async t => {
  const f = fixture(), h = await open(t, f);
  const start = f.auth.beginTabletAuthorization;
  const large = consentUrl + '界'.repeat(3000);
  assert.ok(large.length < 4096 && Buffer.byteLength(large) > 8192);
  f.auth.beginTabletAuthorization = async () => ({...await start(), authorizationUrl: large});
  f.auth.ownsAuthorizationUrl = url => url === large;
  const reply = await h.send(begin('connect'));
  assert.equal(reply.status, 409);
  assert.equal(await reply.text(), '');
  assert.equal(f.applyCount, 0);
});

test('actual helper recovers lost acknowledgement by readback after restart without retrying Apply', async t => {
  const f = fixture({lostReply: true}), first = await open(t, f);
  const authorizing = await first.call(begin('connect'));
  f.setAuthReady();
  const ready = await first.call(use('poll', authorizing.reference));
  const uncertain = await first.call(use('confirm', ready.reference));
  assert.equal(uncertain.state, 'unknown');
  assert.equal(f.applyCount, 1);
  const originalReadback = structuredClone(f.store.value.originals[0].readback);
  await first.close();
  const next = await open(t, f);
  const pending = await next.call(retained);
  assert.deepEqual(pending.retained, [{...identity, reference: ready.reference, status_available: true}]);
  await next.call(use('confirm', ready.reference));
  assert.equal(f.applyCount, 1);
  const checked = await next.call(use('check', ready.reference));
  assert.equal(checked.state, 'observed');
  assert.equal(checked.installed, true);
  assert.deepEqual(checked.retained, []);
  const readback = f.calls.at(-1).request;
  assert.equal(readback.action, 'readback');
  assert.deepEqual(readback, originalReadback);
  assert.equal(JSON.stringify(readback).includes('credential_b64'), false);
  assert.equal(f.auth.takes, 1);
});

test('actual helper reload retires an unused ready reference', async t => {
  const f = fixture(), h = await open(t, f);
  const start = await h.call(begin('connect'));
  f.setAuthReady();
  const ready = await h.call(use('poll', start.reference));
  assert.equal(ready.state, 'ready');
  const original = f.observer.cancels;
  await rawHttp(h.origin + '/preview/', {headers: {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'}});
  assert.ok(f.observer.cancels > original);
  const result = await h.call(use('confirm', ready.reference));
  assert.ok(['invalidated', 'unavailable'].includes(result.state));
  assert.equal(f.applyCount, 0);
});

// The Tablet Drive main handler is inline. Evaluate that registration and the
// actual preload in the same stubbed pattern as the other guarded handlers.
// No Electron process, renderer profile, real frame, transport, or shell opens.
async function electronBridge(f, {openExternal = async () => {}, testMode = false} = {}) {
  const main = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const inline = main.match(/^  ipcMain\.handle\('manager:tabletDriveSetup', [\s\S]+?^  \}\);$/m)?.[0];
  assert.ok(inline, 'Expected the actual Tablet Drive registration');
  const ui = 'file:///synthetic/manager/index.html';
  const frame = {url: ui};
  const contents = {mainFrame: frame};
  const window = {isDestroyed: () => false, webContents: contents};
  const event = {sender: contents, senderFrame: frame};
  let handler, preload;
  const opens = [], invokes = [];
  runInNewContext(inline, {
    ipcMain: {handle(name, fn) { assert.equal(name, channel); handler = fn; }},
    authorized: (caller, args) => args.length === 0 && isManagerMainFrame(caller, window, ui, false),
    parseTabletDriveSetupRequest, parseTabletDriveSetupResult, tabletDrive: f.host, driveAuth: f.auth,
    shell: {openExternal: async url => { opens.push(url); await openExternal(url); }},
    process: {env: testMode ? {MANAGER_TEST: '1'} : {}}, backupDocument: () => frame
  });
  runInNewContext(await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {exposeInMainWorld(name, api) { assert.equal(name, 'managerHost'); preload = api; }},
        ipcRenderer: {invoke(name, ...args) { invokes.push(name); assert.equal(name, channel); return handler(event, ...args); }}
      };
    }
  });
  return {handler, preload, event, contents, opens, invokes, replaceFrame: () => { contents.mainFrame = {url: ui}; }};
}

test('actual Electron handler source and preload reject wrong arity, caller and shape before work', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const bridge = await electronBridge(f);
  await assert.rejects(bridge.preload.tabletDriveSetup(), /arity refused/);
  await assert.rejects(bridge.preload.tabletDriveSetup(retained, retained), /arity refused/);
  assert.deepEqual(bridge.invokes, []);
  await assert.rejects(bridge.handler(bridge.event), /caller refused/);
  await assert.rejects(bridge.handler(bridge.event, retained, retained), /caller refused/);
  await assert.rejects(bridge.handler({sender: bridge.contents, senderFrame: {url: bridge.event.senderFrame.url}}, begin('connect')),
    /caller refused/);
  await assert.rejects(bridge.preload.tabletDriveSetup({...begin('connect'), path: '/synthetic'}), /setup refused/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(bridge.opens, []);
  const result = await bridge.preload.tabletDriveSetup(retained);
  assert.equal(result.tablet_drive.state, 'none');
  reduced(JSON.stringify(result));
});

test('Electron handler calls the mocked external shell only for a host-owned Begin consent URL', async t => {
  for (const options of [{owned: true, testMode: false}, {owned: false, testMode: false}, {owned: true, testMode: true}]) {
    const f = fixture(); t.after(() => f.host.dispose());
    if (!options.owned) f.auth.ownsAuthorizationUrl = () => false;
    const bridge = await electronBridge(f, options);
    const authorizing = await bridge.preload.tabletDriveSetup(begin('connect'));
    const expected = options.owned && !options.testMode ? [consentUrl] : [];
    assert.equal(authorizing.tablet_drive.state, 'authorizing');
    assert.deepEqual(bridge.opens, expected);
    await bridge.preload.tabletDriveSetup(use('poll', authorizing.tablet_drive.reference));
    assert.deepEqual(bridge.opens, expected);
    reduced(JSON.stringify(authorizing));
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test('Electron handler rechecks the caller after the host reply and after opening the owned URL', {timeout: 5000}, async t => {
  for (const phase of ['host', 'shell']) {
    const f = fixture(); t.after(() => f.host.dispose());
    const entered = deferred(), release = deferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (phase === 'host') {
      const request = f.host.request.bind(f.host);
      f.host.request = async (...args) => { const value = await request(...args); await hold(); return value; };
    }
    const bridge = await electronBridge(f, phase === 'shell' ? {openExternal: hold} : {});
    const pending = bridge.preload.tabletDriveSetup(begin('connect'));
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail('Expected the controlled await'))]);
      bridge.replaceFrame();
    } finally {
      release.resolve();
    }
    await assert.rejects(pending, /Tablet Drive caller changed/);
    assert.deepEqual(bridge.opens, phase === 'shell' ? [consentUrl] : []);
    assert.equal(f.auth.cancels, 1);
    assert.equal(f.applyCount, 0);
  }
});
