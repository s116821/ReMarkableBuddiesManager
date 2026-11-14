import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {DRIVE_SCOPE} from '../host/drive-auth.mjs';
import {createIsolatedBackupComposition, createQualifiedBackupReadFactory} from '../host/isolated-backup-composition.mjs';
import {createIsolatedBackupDrive} from '../host/isolated-backup-drive.mjs';
import {IsolatedBackupStaging} from '../host/isolated-backup-staging.mjs';
import {IsolatedBackupVerifier} from '../host/isolated-backup-verifier.mjs';
import {restoreFixture, restoreReport, identity} from './fixtures/ordinary-restore.mjs';

const json = value => Buffer.from(JSON.stringify(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = bytes => ({bytes: bytes.length, sha256: hash(bytes)});
const backup = '12345678-1234-4123-8123-123456789abc';
const device = '98765432-4321-4321-8321-cba987654321';
const data = json({format: 1, manifests: [{}], objects: [], complete_media: false, config_snapshot: null});
const preferences = json({portable_configuration_version: 1, settings: {}});
const markerBytes = json({isolated_backup_version: 1, data_backup: ref(data), portable_configuration: ref(preferences)});
const scan = {version: 1, action: 'scan'};
const stageRoot = path.resolve('fixture-stage', 'owned');

function file(id, size, properties) {
  return {id, size: String(size), spaces: ['appDataFolder'], mimeType: 'application/octet-stream', trashed: false,
    appProperties: {buddy_isolated: '1', root: 'Root', backup, ...properties}};
}

const root = file('Root', 0, {kind: 'root', device, grant: 'a'.repeat(64)});
const marker = file('Marker', markerBytes.length, {kind: 'marker', predecessor: root.id, sha256: hash(markerBytes)});
const objects = [data, preferences].map((bytes, index) =>
  file('Object' + index, bytes.length, {kind: 'object', sha256: hash(bytes)}));

function setup(t, {stageConfigured = true, hold = null, unavailable = false, unbound = false, beforeRelease,
  readFactory} = {}) {
  const registration = {schema: 1, type: 'google-desktop', clientId: '123456789012-fixture.apps.googleusercontent.com',
    clientSecret: null};
  let grant = {schema: 1, clientId: registration.clientId, account: {permissionId: 'fixture', label: 'fixture@example.invalid'},
    checkedAt: Date.now(), tokens: {token_type: 'Bearer', access_token: 'synthetic', refresh_token: 'synthetic-refresh',
      scope: DRIVE_SCOPE, expiry_date: Date.now() + 900000}};
  const record = value => ({value: structuredClone(value), digest: hash(json(value))});
  const store = {
    root: path.resolve('synthetic-drive-root'), python: path.resolve('synthetic-python'),
    client: () => record(registration), grant: () => record(grant),
    save(value) { grant = structuredClone(value); return {committed: true, digest: record(grant).digest}; },
  };

  const events = [], files = new Map(), captures = [];
  const entered = Promise.withResolvers(), drained = Promise.withResolvers();
  const releaseEntered = Promise.withResolvers(), releaseDone = Promise.withResolvers();
  t.after(() => { drained.resolve(); releaseDone.resolve(); });

  async function holdUntilJoined(signal) {
    assert.equal(signal.aborted, false);
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    entered.resolve(signal);
    await aborted;
    await drained.promise;
    events.push(hold + '-joined');
  }

  t.mock.method(IsolatedBackupVerifier.prototype, 'available', async () => !unavailable);
  t.mock.method(IsolatedBackupVerifier.prototype, 'verify', async ({root, markerSha256, signal}) => {
    assert.equal(root, stageRoot);
    assert.equal(markerSha256, hash(markerBytes));
    assert.deepEqual(Buffer.concat(files.get('isolated-backup.json')), markerBytes);
    assert.deepEqual(Buffer.concat(files.get('data/backup.json')), data);
    assert.deepEqual(Buffer.concat(files.get('portable-configuration.json')), preferences);
    if (hold === 'verifier') await holdUntilJoined(signal);
    return Buffer.concat([json({report_version: 1, operation: 'inspect-isolated', status: 'ok', incomplete: true,
      activation_performed: false, data: {isolated_package: {
        marker_sha256: hash(markerBytes), data_backup: ref(data), portable_configuration: ref(preferences),
        declared_settings: 0, data: {format: 1, manifests: 1, objects: 0, selected_scopes: 0, selection_receipts: 0,
          complete_media: false, configuration_included: false},
      }}}), Buffer.from('\n')]);
  });
  t.mock.method(IsolatedBackupStaging.prototype, 'available', async () => true);
  t.mock.method(IsolatedBackupStaging.prototype, 'freeBytes', async () => 1024 ** 3);
  t.mock.method(IsolatedBackupStaging.prototype, 'create', async () => ({
    root: stageRoot,
    async openExclusive(name) {
      assert.equal(files.has(name), false);
      const chunks = [];
      files.set(name, chunks);
      return {async write(bytes) { chunks.push(Buffer.from(bytes)); }, async sync() {}, async close() {}};
    },
    async assertOwned(names) { return names.length === files.size && names.every(name => files.has(name)); },
    async readVerified(member, names, bounds, write) {
      assert.ok(Object.isFrozen(member));
      assert.deepEqual(names, [...files.keys()]);
      const chunks = files.get(member.name);
      assert.deepEqual(ref(Buffer.concat(chunks)), {bytes: member.bytes, sha256: member.sha256});
      for (const chunk of chunks) {
        bounds().signal.throwIfAborted();
        await write(Buffer.from(chunk));
      }
      bounds().signal.throwIfAborted();
    },
    async release() {
      events.push('stage-release');
      releaseEntered.resolve();
      beforeRelease?.();
      await releaseDone.promise;
      files.clear();
    },
  }));

  const composition = createIsolatedBackupComposition({hostRoot: path.resolve('synthetic-host'), store,
    stagingParent: stageConfigured ? path.dirname(stageRoot) : null,
    backupReadFactory: unbound ? null : (readFactory ?? (capture => {
      captures.push(capture);
      return {
        list: ({kind}) => json({files: [kind === 'root' ? root : marker], incompleteSearch: false}),
        readMetadata: ({kind}) => json(kind === 'root' ? root : marker),
        readMarker() { events.push('marker'); return markerBytes; },
        listObject(query) {
          events.push('object-list');
          assert.equal(query.rootId, root.id);
          assert.equal(query.backup, backup);
          return json({files: objects.filter(item => item.appProperties.sha256 === query.sha256), incompleteSearch: false});
        },
        readObjectMetadata: ({id}) => json(objects.find(item => item.id === id)),
        async *streamObject({id, signal}) {
          if (hold === 'stream') await holdUntilJoined(signal);
          else yield id === objects[0].id ? data : preferences;
        },
      };
    })),
  });
  composition.driveAuth.oauth = () => ({setCredentials() {}, refreshAccessToken() { assert.fail('Unexpected refresh'); }});
  composition.driveAuth.account = async () => ({account: grant.account, tokens: grant.tokens});
  return {composition, events, captures, files, entered, drained, releaseEntered, releaseDone, store};
}

async function status(host, operation) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const value = host.request({version: 1, action: 'status', operation});
    if (!['scanning', 'selecting'].includes(value.status)) return value;
    // Pace polling so loopback I/O can progress, then read fresh status.
    await delay(5);
  }
  assert.fail('Backup operation did not settle');
}

async function selection(composition, afterCheck = () => {}) {
  const {isolatedBackup: host, driveAuth} = composition;
  assert.equal((await driveAuth.check()).status, 'connected');
  afterCheck();
  const inspected = await status(host, host.request(scan).operation);
  assert.equal(inspected.status, 'observed');
  const selected = host.request({version: 1, action: 'select', inspection: inspected.operation,
    choice: inspected.backups[0].revisions[0].reference});
  const result = await status(host, selected.operation);
  assert.equal(result.status, 'selected');
  return [result.operation, result.selection.reference];
}

async function loopbackDrive(t) {
  const requests = [];
  const prefix = '/drive/v3/files';
  const records = new Map([[root.id, root], [marker.id, marker], ...objects.map(file => [file.id, file])]);
  const mediaBytes = new Map([[marker.id, markerBytes], [objects[0].id, data], [objects[1].id, preferences]]);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const query = url.searchParams.get('q') ?? '';
    const media = url.searchParams.get('alt') === 'media';
    requests.push({method: req.method, authorization: req.headers.authorization, path: url.pathname, media});
    if (url.pathname === prefix) {
      const properties = [...query.matchAll(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/g)];
      const candidates = [...records.values()].filter(candidate =>
        properties.every(([, key, value]) => candidate.appProperties[key] === value));
      res.end(json({files: candidates, incompleteSearch: false}));
      return;
    }
    const id = url.pathname.slice(prefix.length + 1);
    const candidate = records.get(id);
    const body = media ? mediaBytes.get(id) : candidate && json(candidate);
    if (!url.pathname.startsWith(prefix + '/') || !body) {
      res.writeHead(404).end();
      return;
    }
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return {origin: 'http://127.0.0.1:' + server.address().port, requests};
}

function capturedIdentity(store) {
  const client = store.client(), grant = store.grant();
  return {clientId: client.value.clientId, permissionId: grant.value.account.permissionId,
    clientDigest: client.digest, grantDigest: grant.digest};
}

test('qualified fixed Drive binding uses only the original protected capture', {timeout: 30000}, async t => {
  const {origin, requests} = await loopbackDrive(t);
  for (const options of [{}, {stageConfigured: false}, {unavailable: true}]) {
    await t.test(JSON.stringify(options), async t => {
      let identity;
      const accepted = [], drives = [];
      const readFactory = createQualifiedBackupReadFactory(snapshot => {
        accepted.push(snapshot);
        return Object.keys(identity).every(key => snapshot[key] === identity[key]);
      }, capture => {
        drives.push(capture);
        return createIsolatedBackupDrive(capture, {origin});
      });
      const {composition, store, releaseDone} = setup(t, {...options, readFactory});
      releaseDone.resolve();
      t.after(() => composition.dispose());
      const start = requests.length;
      const original = await selection(composition, () => { identity = capturedIdentity(store); });
      const selectionReads = requests.slice(start);
      assert.equal(selectionReads.filter(request => request.media).length, 1);
      assert.equal(selectionReads.find(request => request.media).path, '/drive/v3/files/Marker');
      const beforeDownload = requests.length;
      const result = await composition.downloadSelection(...original);
      const objectReads = requests.slice(beforeDownload);
      if (options.stageConfigured === false || options.unavailable) {
        assert.equal(result.status, 'unavailable');
        assert.deepEqual(objectReads, []);
      } else {
        assert.equal(result.status, 'verified');
        assert.equal(result.inspection.markerSha256, hash(markerBytes));
        assert.deepEqual(objectReads.map(request => request.path), [
          '/drive/v3/files', '/drive/v3/files/Object0', '/drive/v3/files/Object0',
          '/drive/v3/files', '/drive/v3/files/Object1', '/drive/v3/files/Object1',
        ]);
        assert.deepEqual(objectReads.filter(request => request.media).map(request => request.path),
          ['/drive/v3/files/Object0', '/drive/v3/files/Object1']);
      }
      assert.deepEqual(accepted, [identity]);
      assert.equal(drives.length, 1);
      assert.equal(drives[0].grantDigest, identity.grantDigest);
      assert.equal(drives[0].clientDigest, identity.clientDigest);
      assert.equal(drives[0].signal.aborted, false);
      assert.ok(requests.slice(start).every(request =>
        request.method === 'GET' && request.authorization === 'Bearer ' + drives[0].grant.tokens.access_token));
    });
  }
});

test('missing or non-exact namespace acceptance opens no Drive transport', async t => {
  for (const [name, predicate] of [
    ['missing', null],
    ['wrong registration', (snapshot, identity) => snapshot.clientId === identity.clientId + '-other'],
    ['wrong account', (snapshot, identity) => snapshot.permissionId === identity.permissionId + '-other'],
    ['wrong client digest', (snapshot, identity) => snapshot.clientDigest === hash(identity.clientDigest)],
    ['wrong grant digest', (snapshot, identity) => snapshot.grantDigest === hash(identity.grantDigest)],
    ['throws', () => { throw new Error('Qualification unavailable'); }],
    ['truthy', () => 1],
    ['async true', async () => true],
    ['async rejection', async () => { throw new Error('Qualification unavailable'); }],
  ]) {
    await t.test(name, async t => {
      let identity, constructed = 0;
      const accept = predicate && (snapshot => predicate(snapshot, identity));
      const readFactory = createQualifiedBackupReadFactory(accept, () => { constructed++; });
      const {composition, store} = setup(t, {readFactory});
      t.after(() => composition.dispose());
      assert.equal((await composition.driveAuth.check()).status, 'connected');
      identity = capturedIdentity(store);
      const host = composition.isolatedBackup;
      assert.equal((await status(host, host.request(scan).operation)).status, 'unqualified');
      assert.equal(constructed, 0);
    });
  }
});

test('default composition is unbound and missing stage or verifier refuses before object reads', async t => {
  for (const options of [{unbound: true}, {stageConfigured: false}, {unavailable: true}]) {
    await t.test(JSON.stringify(options), async t => {
      const {composition, events, captures} = setup(t, options);
      t.after(() => composition.dispose());
      if (options.unbound) {
        assert.equal((await status(composition.isolatedBackup, composition.isolatedBackup.request(scan).operation)).status,
          'unqualified');
        assert.equal((await composition.downloadSelection('a'.repeat(64), 'b'.repeat(64))).status, 'invalidated');
        assert.deepEqual(events, []);
        assert.equal(captures.length, 0);
      } else {
        const original = await selection(composition);
        assert.equal((await composition.downloadSelection(...original)).status, 'unavailable');
        assert.deepEqual(events, ['marker']);
        assert.equal(captures.length, 1);
        composition.isolatedBackup.invalidate();
        assert.equal((await composition.downloadSelection(...original)).status, 'invalidated');
        assert.equal(captures.length, 1);
      }
    });
  }
});

async function stagedRestore(t, {digest = hash(data), ...options} = {}) {
  const f = setup(t, options);
  const restore = restoreFixture({report(selector, body, state) {
    const report = restoreReport(selector, body, state);
    if (selector === 'prepare') {
      report.data.intent.archive_sha256 = digest;
      report.data.intent.complete_media = false;
      report.data.intent.staged_configuration_sha256 = null;
      report.data.preview.source.complete_media = false;
      report.data.preview.target.complete_media = false;
      report.data.preview.source.configuration_included = false;
      report.data.preview.target.configuration_included = false;
    } else if (report.data?.inspection) {
      report.data.inspection.configuration_included = false;
    }
    return report;
  }});
  t.after(() => { f.releaseDone.resolve(); return Promise.all([f.composition.dispose(), restore.host.dispose()]); });
  const original = await selection(f.composition);
  const [operation, reference] = original;
  const {isolatedBackup: host} = f.composition;
  assert.equal(host.request({version: 1, action: 'download', operation, reference}).status, 'downloading');
  for (let i = 0; i < 200; i++) {
    const receipt = await host.request({version: 1, action: 'status', operation});
    if (receipt.status !== 'downloading') { assert.equal(receipt.status, 'verified'); break; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(host.canHandoff(operation, reference), true);
  const destination = '/home/root/fixture/restore-original';
  const events = [];
  const prepared = {root: destination, async assertOwned({signal, connection_id, boot_id, files, markerSha256}) {
    signal.throwIfAborted();
    assert.deepEqual({connection_id, boot_id}, identity);
    assert.equal(markerSha256, hash(markerBytes));
    assert.deepEqual(files, [{name: 'data/backup.json', ...ref(data)},
      {name: 'portable-configuration.json', ...ref(preferences)}, {name: 'isolated-backup.json', ...ref(markerBytes)}]);
    events.push('destination-check');
    return true;
  }, async release() { events.push('destination-release'); return true; }};
  const transfer = async input => {
    assert.equal(Object.hasOwn(input, 'root'), false);
    assert.equal(typeof input.readFile, 'function');
    assert.deepEqual(input.components, {data: ref(data), preferences: ref(preferences)});
    assert.ok(input.timeoutMs > 0 && input.timeoutMs <= 13000);
    assert.ok(restore.io.ownerFor('ordinary-restore', 'prepare'));
    events.push('transfer');
    return prepared;
  };
  const prepare = (stageDestination = transfer, target = identity) =>
    f.composition.prepareRestore(...original, {restore: restore.host, target, stageDestination});
  return {...f, restore, original, prepare, prepared, transfer, destination, restoreEvents: events};
}

test('restore preview adopts one exact destination and explicit Confirm preserves original Status', async t => {
  const f = await stagedRestore(t);
  const preview = f.prepare();
  await f.releaseEntered.promise;
  assert.deepEqual(f.restore.calls.map(call => call.selector), ['prepare']);
  assert.equal(f.restore.calls[0].body.source, f.destination + '/data');
  assert.equal((await f.restore.prepare()).ordinary_restore.state, 'busy');
  assert.deepEqual(f.restoreEvents, ['transfer', 'destination-check', 'destination-check']);
  f.releaseDone.resolve();
  const result = await preview;
  assert.equal(result.status, 'ready');
  assert.equal(result.preview.ordinary_restore.preview.source.complete_media, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture\/restore-original|archive_sha256|source_path_sha256/);
  assert.equal((await f.composition.prepareRestore('e'.repeat(64), f.original[1], {
    restore: f.restore.host, target: identity, stageDestination: () => assert.fail('Stale owner transferred'),
  })).status, 'invalidated');
  // A repeat cannot consume another stage or invalidate the existing preview.
  assert.equal((await f.prepare()).status, 'invalidated');
  const ref = result.preview.ordinary_restore.reference;
  assert.equal((await f.restore.use('confirm', ref)).ordinary_restore.state, 'unknown');
  assert.deepEqual(f.restoreEvents.slice(-2), ['destination-check', 'destination-release']);
  const input = f.restore.calls.find(call => call.selector === 'apply').input;
  f.restore.state.status = 'desired-generation-observed';
  const reconciled = (await f.restore.use('status', ref)).ordinary_restore;
  assert.equal(reconciled.state, 'desired-generation-observed');
  assert.equal(reconciled.apply_outcome, 'unknown');
  assert.equal(f.restore.calls.at(-1).input, input);
  assert.equal(f.restoreEvents.filter(event => event === 'destination-release').length, 1);
});

test('handoff exposes only original members and fences retained and overlapping reads', async t => {
  const f = await stagedRestore(t);
  f.releaseDone.resolve();
  let readFile;
  const preview = await f.prepare(async source => {
    assert.equal(Object.hasOwn(source, 'root'), false);
    assert.ok(Object.isFrozen(source.files));
    readFile = source.readFile;
    await assert.rejects(readFile('../data/backup.json', () => assert.fail()));
    const chunks = [];
    await readFile('data/backup.json', async (chunk, signal) => {
      assert.equal(signal.aborted, false);
      assert.ok(f.restore.io.ownerFor('ordinary-restore', 'prepare'));
      await assert.rejects(readFile('isolated-backup.json', () => assert.fail()));
      chunks.push(chunk);
    });
    assert.deepEqual(Buffer.concat(chunks), data);
    return f.prepared;
  });
  assert.equal(preview.status, 'ready');
  await assert.rejects(readFile('data/backup.json', () => assert.fail()));
});

test('returning during a broker read aborts and joins it before staging release', {timeout: 5000}, async t => {
  const f = await stagedRestore(t);
  f.releaseDone.resolve();
  const entered = Promise.withResolvers(), exited = Promise.withResolvers();
  t.after(() => exited.resolve());
  let reading, reduced;
  const transfer = f.prepare(async source => {
    reading = source.readFile('data/backup.json', async (_chunk, signal) => {
      entered.resolve(signal);
      await exited.promise;
      f.events.push('read-joined');
    });
    reduced = assert.rejects(reading);
    await entered.promise;
    return f.prepared;
  });
  try {
    const signal = await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(f.events.includes('stage-release'), false);
  } finally { exited.resolve(); }
  await reduced;
  assert.equal((await transfer).status, 'unavailable');
  assert.deepEqual(f.events.slice(-2), ['read-joined', 'stage-release']);
});

test('a changed adopted destination refuses Confirm and retires only that destination', async t => {
  const f = await stagedRestore(t);
  f.releaseDone.resolve();
  const preview = await f.prepare();
  assert.equal(preview.status, 'ready');
  f.prepared.assertOwned = async () => false;
  const result = await f.restore.use('confirm', preview.preview.ordinary_restore.reference);
  assert.equal(result.ordinary_restore.state, 'not-dispatched');
  assert.deepEqual(f.restore.calls.map(call => call.selector), ['prepare']);
  assert.equal(f.restoreEvents.filter(event => event === 'destination-release').length, 1);
});

test('destination expiry waits for checked release on disposal and preserves uncertain cleanup', {timeout: 5000}, async t => {
  const f = await stagedRestore(t);
  f.releaseDone.resolve();
  const releaseStarted = Promise.withResolvers(), released = Promise.withResolvers();
  t.after(() => released.resolve(false));
  f.prepared.release = () => { releaseStarted.resolve(); return released.promise; };
  let now = 0;
  f.restore.host.now = () => now;
  const preview = await f.prepare();
  assert.equal(preview.status, 'ready');
  now = 120001;
  assert.throws(() => f.restore.host.assertCurrent(preview.preview), /expired|invalidated/i);
  await releaseStarted.promise;
  const disposed = f.restore.host.dispose();
  let settled = false;
  void disposed.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  released.resolve(false);
  assert.equal(await disposed, true);
});

test('handoff refuses wrong target, corrupt destination and a different Prepare archive digest', async t => {
  for (const mode of ['target', 'corrupt', 'digest', 'lost-authority']) {
    await t.test(mode, async t => {
      let authority;
      const f = await stagedRestore(t, {
        digest: mode === 'digest' ? 'f'.repeat(64) : hash(data),
        beforeRelease: () => { if (mode === 'lost-authority') authority.invalidate(); },
      });
      authority = f.composition.isolatedBackup;
      f.releaseDone.resolve();
      if (mode === 'corrupt') f.prepared.assertOwned = async () => false;
      const result = await f.prepare(f.transfer, mode === 'target' ? {...identity, boot_id: 'c'.repeat(36)} : identity);
      assert.equal(result.preview, null);
      assert.equal(result.status, ['target', 'lost-authority'].includes(mode) ? 'invalidated' : 'unavailable');
      assert.deepEqual(f.restore.calls.map(call => call.selector), ['digest', 'lost-authority'].includes(mode) ? ['prepare'] : []);
      assert.equal(f.restoreEvents.includes('destination-release'), mode !== 'target');
    });
  }
});

test('cancelled or expired handoff joins the original transfer and Prepare before either stage retires', {timeout: 5000}, async t => {
  for (const mode of ['cancel-transfer', 'timeout-transfer', 'cancel-prepare']) {
    await t.test(mode, async t => {
      const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), drained = Promise.withResolvers();
      t.after(() => drained.resolve());
      const f = await stagedRestore(t);
      f.releaseDone.resolve();
      if (mode === 'timeout-transfer') f.restore.host.budgetMs = 50;
      if (mode === 'cancel-prepare') f.restore.state.onRaw = async report => {
        entered.resolve();
        await drained.promise;
        return report;
      };
      const pending = f.prepare(async input => {
        input.signal.addEventListener('abort', aborted.resolve, {once: true});
        const result = await f.transfer(input);
        if (mode !== 'cancel-prepare') {
          entered.resolve();
          await drained.promise;
        }
        return result;
      });
      await entered.promise;
      if (mode !== 'timeout-transfer') f.composition.isolatedBackup.invalidate();
      await aborted.promise;
      assert.equal((await f.restore.prepare()).ordinary_restore.state, 'busy');
      assert.equal(f.events.includes('stage-release'), false);
      assert.equal(f.restoreEvents.includes('destination-release'), false);
      drained.resolve();
      assert.equal((await pending).status, 'invalidated');
      assert.equal(f.events.includes('stage-release'), true);
      assert.equal(f.restoreEvents.includes('destination-release'), true);
      assert.deepEqual(f.restore.calls.map(call => call.selector), mode === 'cancel-prepare' ? ['prepare'] : []);
    });
  }
});

test('the public phase retains one verified stage and cancel waits for its exact cleanup', {timeout: 5000}, async t => {
  const f = setup(t), {composition} = f, host = composition.isolatedBackup;
  const [operation, reference] = await selection(composition);
  const request = {version: 1, action: 'download', operation, reference};
  assert.equal(host.request({...request, reference: 'f'.repeat(64)}).status, 'invalidated');
  assert.equal(host.request(request).status, 'downloading');
  assert.equal(host.request(request).status, 'invalidated');
  let result;
  for (let i = 0; i < 200; i++) {
    result = await host.request({version: 1, action: 'status', operation});
    if (result.status !== 'downloading') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(result.status, 'verified');
  assert.equal(result.inspection.markerSha256, hash(markerBytes));
  assert.equal(result.inspection.completeMedia, false);
  assert.equal(f.files.size, 3);
  assert.equal(f.captures.length, 1);
  assert.equal(f.events.filter(event => event === 'marker').length, 1);
  assert.equal(host.request(request).status, 'invalidated');
  const cancelling = host.request({version: 1, action: 'cancel', operation});
  await f.releaseEntered.promise;
  const successor = host.request(scan);
  let settled = false;
  void cancelling.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  f.releaseDone.reject(Error('Stage identity changed'));
  assert.deepEqual(await cancelling, {version: 1, operation, status: 'invalidated', inspection: null, cleanupPending: true});
  assert.equal((await status(host, successor.operation)).status, 'observed');
  await host.request({version: 1, action: 'cancel', operation});
  assert.equal((await status(host, successor.operation)).status, 'observed');
  assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
  await composition.dispose();
});

test('composition uses the original capture and joins active work before checked stage release', {timeout: 5000}, async t => {
  for (const hold of ['stream', 'verifier']) {
    await t.test(hold, async t => {
      const f = setup(t, {hold});
      const {composition} = f;
      const original = await selection(composition);
      const forged = await composition.downloadSelection(original[0], 'f'.repeat(64));
      assert.equal(forged.status, 'invalidated');
      assert.deepEqual(f.events, ['marker']);
      const download = composition.downloadSelection(...original);
      const workSignal = await Promise.race([f.entered.promise, download.then(result => {
        assert.fail('Download settled before entering ' + hold + ': ' + result.status);
      })]);
      assert.equal(f.captures.length, 1);
      assert.equal(f.events.filter(event => event === 'marker').length, 1);
      const closing = composition.dispose();
      assert.equal(composition.dispose(), closing);
      assert.equal(workSignal.aborted, true);
      assert.equal(f.captures[0].signal.aborted, true);
      assert.equal(composition.isolatedBackup.request(scan).status, 'invalidated');
      assert.equal((await composition.downloadSelection(...original)).status, 'invalidated');
      let closed = false;
      void closing.then(() => { closed = true; });
      assert.equal(f.events.includes('stage-release'), false);
      assert.ok(f.files.size > 0);
      f.drained.resolve();
      await f.releaseEntered.promise;
      assert.deepEqual(f.events.slice(-2), [hold + '-joined', 'stage-release']);
      assert.equal(closed, false);
      f.releaseDone.resolve();
      await closing;
      assert.equal((await download).status, 'invalidated');
      assert.equal(f.files.size, 0);
      assert.equal(closed, true);
    });
  }
});
