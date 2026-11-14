import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {createIsolatedBackupDrive} from '../host/isolated-backup-drive.mjs';

const TOKEN = 'synthetic-token';
const SHA = 'a'.repeat(64);
const BACKUP = '12345678-1234-4123-8123-123456789abc';
const PREFIX = '/drive/v3/files';
const FIELDS = 'id,appProperties,size,mimeType,trashed,spaces';
const REFUSED = {message: 'Drive backup read refused'};

function capture(signal) {
  return {grant: {tokens: {access_token: TOKEN, token_type: 'Bearer', refresh_token: 'never transmitted'}}, signal};
}

async function setup(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({method: req.method, url: new URL(req.url, 'http://127.0.0.1'), headers: req.headers});
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const authority = new AbortController();
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {drive: createIsolatedBackupDrive(capture(authority.signal), {origin}), requests, authority};
}

function bounds(maxBytes, signal = new AbortController().signal) {
  return {maxBytes, timeoutMs: 2000, signal};
}

function streamRequest(options = bounds(10)) {
  return {id: 'object_1', sha256: SHA, ...options};
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function properties(object) {
  return ['trashed = false', ...Object.entries({buddy_isolated: '1', ...object}).map(([key, value]) =>
    "appProperties has { key='" + key + "' and value='" + value + "' }")].join(' and ');
}

test('fixed Drive calls use GET and exact projections with private captured auth', async t => {
  const json = Buffer.from(' { "files" : [], "incompleteSearch":false }\n');
  const marker = Buffer.from(' { "bytes" : 10 } \n');
  const object = Buffer.from([0, 255, 7, 23, 128]);
  const results = [json, json, json, json, json, marker, object, Buffer.alloc(0)];
  let index = 0;
  const {drive, requests} = await setup(t, (_req, res) => res.end(results[index++]));
  const list = {pageToken: null, maxEntries: 100, ...bounds(128)};
  const pageToken = "opaque+'&? /";
  assert.deepEqual(await drive.list({kind: 'root', rootId: null, ...list}), json);
  assert.deepEqual(await drive.list({kind: 'marker', rootId: 'root_1', ...list, pageToken}), json);
  assert.deepEqual(await drive.listObject({rootId: 'root_1', backup: BACKUP, sha256: SHA, ...list}), json);
  assert.deepEqual(await drive.readMetadata({kind: 'marker', id: 'marker_1', ...bounds(128)}), json);
  assert.deepEqual(await drive.readObjectMetadata({id: 'object_1', ...bounds(128)}), json);
  assert.deepEqual(await drive.readMarker({id: 'marker_1', ...bounds(marker.length)}), marker);
  assert.deepEqual(Buffer.concat(await collect(drive.streamObject(streamRequest(bounds(object.length))))), object);
  assert.deepEqual(await collect(drive.streamObject(streamRequest(bounds(0)))), []);

  const common = {spaces: 'appDataFolder', pageSize: '100', fields: 'files(' + FIELDS + '),nextPageToken,incompleteSearch'};
  const expected = [
    [PREFIX, {...common, q: properties({kind: 'root'})}],
    [PREFIX, {...common, q: properties({kind: 'marker', root: 'root_1'}), pageToken}],
    [PREFIX, {...common, q: properties({kind: 'object', root: 'root_1', backup: BACKUP, sha256: SHA})}],
    [PREFIX + '/marker_1', {fields: FIELDS}],
    [PREFIX + '/object_1', {fields: FIELDS}],
    [PREFIX + '/marker_1', {alt: 'media'}],
    [PREFIX + '/object_1', {alt: 'media'}],
    [PREFIX + '/object_1', {alt: 'media'}],
  ];
  assert.deepEqual(requests.map(req => [req.url.pathname, Object.fromEntries(req.url.searchParams)]), expected);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.equal(request.headers.cookie, undefined);
    assert.ok(!request.url.href.includes(TOKEN));
  }
  assert.ok(!JSON.stringify(drive).includes(TOKEN));
});

test('validates path, filters, bounds and fixture origin before sending', async t => {
  const {drive, requests} = await setup(t, (_req, res) => res.end());
  const list = {kind: 'marker', rootId: "x' or trashed = true", pageToken: null, maxEntries: 100, ...bounds(10)};
  assert.throws(() => drive.list(list), REFUSED);
  assert.throws(() => drive.list({...list, rootId: 'ok', pageToken: 'bad\npage'}), REFUSED);
  assert.throws(() => drive.list({...list, rootId: 'ok', maxEntries: 101}), REFUSED);
  assert.throws(() => drive.readMarker({id: '../other', ...bounds(10)}), REFUSED);
  await assert.rejects(drive.readMarker({id: 'ok', ...bounds(16385)}), REFUSED);
  assert.throws(() => createIsolatedBackupDrive(capture(new AbortController().signal),
    {origin: 'http://localhost:42'}), REFUSED);
  assert.deepEqual(requests, []);
});

test('refuses oversize, interrupted, encoded, redirected and non-success bodies without retry', async t => {
  const {drive, requests} = await setup(t, (req, res) => {
    const id = req.url.slice(PREFIX.length + 1).split('?')[0];
    if (id === 'declared') {
      res.writeHead(200, {'Content-Length': 8});
      res.end('12345678');
    } else if (id === 'chunked') {
      res.write('123');
      res.end('456');
    } else if (id === 'short') {
      res.writeHead(200, {'Content-Length': 6});
      res.end('abc');
    } else if (id === 'encoded') {
      res.writeHead(200, {'Content-Encoding': 'gzip'});
      res.end('abc');
    } else if (id === 'redirect') {
      res.writeHead(302, {Location: PREFIX + '/redirect_target'});
      res.end(TOKEN);
    } else {
      res.writeHead(id === 'server_error' ? 503 : 401);
      res.end(TOKEN);
    }
  });
  for (const id of ['declared', 'chunked', 'short']) {
    await assert.rejects(drive.readObjectMetadata({id, ...bounds(id === 'short' ? 6 : 5)}), REFUSED);
  }
  for (const id of ['encoded', 'redirect', 'unauthorized', 'server_error']) {
    await assert.rejects(drive.readMarker({id, ...bounds(64)}), REFUSED);
  }
  assert.deepEqual(requests.map(req => req.url.pathname),
    ['declared', 'chunked', 'short', 'encoded', 'redirect', 'unauthorized', 'server_error'].map(id => PREFIX + '/' + id));
});

test('streams bounded chunks and refuses extra bytes even for a zero-byte request', async t => {
  const data = Buffer.alloc(192 * 1024 + 7, 231);
  const {drive} = await setup(t, (_req, res) => res.end(data));
  const chunks = await collect(drive.streamObject(streamRequest(bounds(data.length))));
  assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.length <= 64 * 1024));
  assert.deepEqual(Buffer.concat(chunks), data);
  await assert.rejects(collect(drive.streamObject(streamRequest(bounds(0)))), REFUSED);
});

test('abort, iterator return and timeout close the original request', {timeout: 10000}, async t => {
  for (const mode of ['before-headers', 'request-abort', 'authority-abort', 'return-pending', 'return-after-yield', 'timeout']) {
    await t.test(mode, async t => {
      let started, ended;
      const entered = new Promise(resolve => { started = resolve; });
      const close = new Promise(resolve => { ended = resolve; });
      const {drive, authority, requests} = await setup(t, (_req, res) => {
        res.once('close', ended);
        if (mode === 'return-after-yield') res.write('first');
        else if (mode !== 'before-headers') res.flushHeaders();
        started();
      });
      const controller = new AbortController();
      const iterator = drive.streamObject(streamRequest({...bounds(10, controller.signal),
        timeoutMs: mode === 'timeout' ? 250 : 2000}));
      const pending = iterator.next();
      const result = mode === 'return-after-yield' ? pending : assert.rejects(pending, REFUSED);
      await entered;
      if (mode === 'request-abort' || mode === 'before-headers') controller.abort();
      if (mode === 'authority-abort') authority.abort();
      if (mode === 'return-pending') assert.equal((await iterator.return()).done, true);
      if (mode === 'return-after-yield') {
        assert.deepEqual(await result, {value: Buffer.from('first'), done: false});
        assert.equal((await iterator.return()).done, true);
      }
      await result;
      await close;
      assert.equal(requests.length, 1);
      assert.equal((await iterator.next()).done, true);
    });
  }
});
