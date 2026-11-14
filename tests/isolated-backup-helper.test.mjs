import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startHelper} from '../host/browser-helper.mjs';
import {parseIsolatedBackupResult} from '../host/isolated-backup-protocol.mjs';

// Source-derived synthetic frames. This exercises the actual loopback bridge;
// it is neither a live Drive account nor a Rust-produced package fixture.
const json = value => Buffer.from(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const backup = 'db766c9e-d346-41fd-aad4-17d754fd50c7';
const device = '3696d8c3-8889-4b67-917d-ea52b54cefe1';
const raw = json({isolated_backup_version: 1, data_backup: {bytes: 20, sha256: 'a'.repeat(64)},
  portable_configuration: {bytes: 10, sha256: 'b'.repeat(64)}});
const file = (id, size, properties) => ({id, size: String(size), spaces: ['appDataFolder'],
  mimeType: 'application/octet-stream', trashed: false,
  appProperties: {buddy_isolated: '1', root: 'PrivateRoot', backup, ...properties}});
const root = file('PrivateRoot', 0, {kind: 'root', device, grant: 'c'.repeat(64)});
const marker = file('PrivateMarker', raw.length, {kind: 'marker', predecessor: root.id, sha256: sha(raw)});
const scan = {version: 1, action: 'scan'};
const status = operation => ({version: 1, action: 'status', operation});
const cancel = operation => ({version: 1, action: 'cancel', operation});

async function open(t, {qualified = false, delayed = false, downloads} = {}) {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'manager-backup-helper-'));
  await writeFile(path.join(directory, 'index.html'), '<main>fixture</main>');
  const authority = new AbortController(), reads = [], captures = [];
  let tabletCalls = 0, driveDisposals = 0;
  const driveAuth = {
    openBackupRead(signal) {
      captures.push(signal);
      if (!qualified) return {status: 'unqualified'};
      const combined = AbortSignal.any([signal, authority.signal]);
      const binding = {
        isCurrent: () => !combined.aborted,
        list(query) {
          reads.push(query);
          if (delayed) return new Promise(() => {});
          return json({files: [query.kind === 'root' ? root : marker], incompleteSearch: false});
        },
        readMetadata: query => json(query.kind === 'root' ? root : marker),
        readMarker: () => raw,
      };
      return {status: 'qualified', binding, signal: combined};
    },
    dispose() { driveDisposals++; authority.abort(); },
  };
  const observer = {generation: 0, cancel() {}, observe() { tabletCalls++; throw Error('Unexpected tablet access'); }};
  const helper = await startHelper({root: directory, observer, driveAuth, downloads});
  const {close} = helper;
  t.after(async () => {
    await close();
    assert.equal(tabletCalls, 0);
    assert.equal(await realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    await rm(directory, {recursive: true});
  });
  const page = await fetch(helper.origin + '/preview/');
  const headers = {Origin: helper.origin, Cookie: page.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json'};
  await page.text();
  const send = (value, route = '/manager-isolated-backup', override = {}) => fetch(helper.origin + route, {
    method: 'POST', headers: {...headers, ...override}, body: typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  });
  const result = async value => {
    const response = await send(value);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return parseIsolatedBackupResult(await response.json(), value);
  };
  const settle = async operation => {
    for (let i = 0; i < 100; i++) {
      const value = await result(status(operation));
      if (!['scanning', 'selecting'].includes(value.status)) return value;
    }
    assert.fail('Original operation did not settle');
  };
  return {
    origin: helper.origin, server: helper.server, headers, send, result, settle, reads, captures, authority, close,
    get driveDisposals() { return driveDisposals; },
  };
}

async function navigate(h) {
  await new Promise((resolve, reject) => {
    const request = httpRequest(h.origin + '/preview/', {headers: {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'}}, response => {
      response.resume(); response.on('end', resolve);
    });
    request.on('error', reject); request.end();
  });
}

test('actual backup bridge enforces origin/session/closed bytes before admission and stays unqualified by default', async t => {
  const h = await open(t);
  assert.equal((await h.send(scan, undefined, {Origin: 'http://other.invalid'})).status, 403);
  assert.equal((await h.send(scan, undefined, {Cookie: 'wrong'})).status, 403);
  assert.equal((await h.send(scan, undefined, {'Content-Type': 'text/plain'})).status, 403);
  assert.equal((await h.send(scan, '/manager-isolated-backup?qualification=true')).status, 403);
  assert.equal((await fetch(h.origin + '/manager-isolated-backup')).status, 403);
  for (const input of [null, {...scan, authorizationId: 'a'.repeat(64)}, {...scan, path: '/private'},
    '{"version":1,"action":"scan","action":"scan"}', Buffer.from([255])]) {
    assert.equal((await h.send(input)).status, 400);
  }
  assert.equal((await h.send(' '.repeat(513))).status, 413);
  assert.equal(h.captures.length, 0);
  const begun = await h.result(scan);
  assert.equal(begun.status, 'scanning');
  assert.equal((await h.settle(begun.operation)).status, 'unqualified');
  assert.equal(h.captures.length, 1);
});

test('actual backup bridge retains the exact inspection and selection; stale cancel cannot revoke a newer operation', async t => {
  const h = await open(t, {qualified: true});
  const begun = await h.result(scan), observed = await h.settle(begun.operation);
  assert.equal(observed.status, 'observed');
  const choice = observed.backups[0].revisions[0];
  const selectedStart = await h.result({version: 1, action: 'select', inspection: begun.operation, choice: choice.reference});
  assert.equal(selectedStart.status, 'selecting');
  const selected = await h.settle(selectedStart.operation);
  assert.equal(selected.status, 'selected');
  assert.equal(selected.selection.sha256, sha(raw));
  for (const privateValue of ['PrivateRoot', 'PrivateMarker', 'appProperties', 'grant', 'access_token']) {
    assert.equal(JSON.stringify([observed, selected]).includes(privateValue), false);
  }
  await h.result(cancel(begun.operation));
  assert.equal((await h.result(status(selected.operation))).status, 'selected');
  h.authority.abort();
  assert.equal((await h.result(status(selected.operation))).status, 'invalidated');
});

test('actual browser navigation and helper disposal abort original reads without requiring a tablet', async t => {
  const h = await open(t, {qualified: true, delayed: true});
  const first = await h.result(scan);
  assert.equal(h.reads.length, 1);
  await navigate(h);
  assert.equal(h.reads[0].signal.aborted, true);
  assert.equal((await h.result(status(first.operation))).status, 'invalidated');
  const next = await h.result(scan);
  assert.notEqual(next.operation, first.operation);
  assert.equal(h.reads.length, 2);
  await h.result(cancel(first.operation));
  assert.equal(h.reads[1].signal.aborted, false);
  await h.close();
  assert.equal(h.reads[1].signal.aborted, true);
});

test('concurrent helper closes stop admission and join an active release download once', async t => {
  const download = Promise.withResolvers();
  let disposed = 0, settled = false;
  const h = await open(t, {qualified: true, delayed: true, downloads: {
    active: {promise: download.promise},
    dispose() { disposed++; },
  }});
  try {
    assert.equal((await h.result(scan)).status, 'scanning');
    assert.equal(h.reads.length, 1);
    const first = h.close(), second = h.close();
    assert.equal(second, first);
    const completion = first.then(() => { settled = true; });
    await assert.rejects(h.send(scan), TypeError);
    assert.equal(h.server.listening, false);
    assert.equal(h.captures.length, 1);
    assert.equal(h.reads[0].signal.aborted, true);
    assert.equal(h.driveDisposals, 1);
    assert.equal(disposed, 1);
    assert.equal(settled, false);
    download.resolve();
    await completion;
    assert.equal(settled, true);
    assert.equal(h.close(), first);
    assert.equal(h.driveDisposals, 1);
    assert.equal(disposed, 1);
  } finally {
    download.resolve();
  }
});

test('a partially received backup request cannot start work after document navigation', async t => {
  const h = await open(t, {qualified: true});
  const admitted = Promise.withResolvers();
  h.server.prependOnceListener('request', request => {
    assert.equal(request.url, '/manager-isolated-backup');
    admitted.resolve();
  });
  let pending;
  const completed = new Promise((resolve, reject) => {
    pending = httpRequest(h.origin + '/manager-isolated-backup', {method: 'POST', headers: h.headers}, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    pending.on('error', reject);
    pending.write('{"version":1,');
  });
  t.after(() => pending.destroy());
  await admitted.promise;
  await navigate(h);
  pending.end('"action":"scan"}');
  assert.equal(await completed, 409);
  assert.equal(h.captures.length, 0);
  const next = await h.result(scan);
  assert.equal((await h.settle(next.operation)).status, 'observed');
  assert.equal(h.captures.length, 1);
});
