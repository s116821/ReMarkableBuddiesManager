import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
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
import {portableFixture, artifact as portableArtifact, selected as manualArtifact} from './fixtures/portable-configuration.mjs';
import {IsolatedBackupPreferences} from '../host/isolated-backup-preferences.mjs';
import {MemoryForgetHost} from '../host/memory-forget.mjs';
import {createIsolatedStageDestination} from '../host/isolated-stage-transport.mjs';
import {WiredObserver} from '../host/observer.mjs';

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
  readFactory, portableBytes = preferences, holdMemberRead, onMemberRead, memberChunk, retained} = {}) {
  const dataBytes = retained?.members.get('data/backup.json') ?? data;
  portableBytes = retained?.members.get('portable-configuration.json') ?? portableBytes;
  const packageMarker = retained?.members.get('isolated-backup.json') ?? (portableBytes === preferences ? markerBytes :
    json({isolated_backup_version: 1, data_backup: ref(dataBytes), portable_configuration: ref(portableBytes)}));
  const packageMarkerFile = file(marker.id, packageMarker.length, {kind: 'marker', predecessor: root.id, sha256: hash(packageMarker)});
  const bodies = [dataBytes, portableBytes, ...(retained ?
    [...retained.members].filter(([name]) => name.startsWith('data/objects/')).map(([, bytes]) => bytes) : [])];
  const packageObjects = bodies.map((bytes, index) =>
    file('Object' + index, bytes.length, {kind: 'object', sha256: hash(bytes)}));
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
    assert.equal(markerSha256, hash(packageMarker));
    assert.deepEqual(Buffer.concat(files.get('isolated-backup.json')), packageMarker);
    assert.deepEqual(Buffer.concat(files.get('data/backup.json')), dataBytes);
    assert.deepEqual(Buffer.concat(files.get('portable-configuration.json')), portableBytes);
    if (hold === 'verifier') await holdUntilJoined(signal);
    if (retained) return Buffer.concat([json(retained.expected_report), Buffer.from('\n')]);
    return Buffer.concat([json({report_version: 1, operation: 'inspect-isolated', status: 'ok', incomplete: true,
      activation_performed: false, data: {isolated_package: {
        marker_sha256: hash(packageMarker), data_backup: ref(data), portable_configuration: ref(portableBytes),
        declared_settings: Object.keys(JSON.parse(portableBytes).settings).length, data: {format: 1, manifests: 1, objects: 0, selected_scopes: 0, selection_receipts: 0,
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
      onMemberRead?.(member);
      if (holdMemberRead && member.name === 'portable-configuration.json') {
        await holdMemberRead(bounds);
      }
      for (const chunk of chunks) {
        bounds().signal.throwIfAborted();
        await write(Buffer.from(memberChunk ? memberChunk(member, chunk) : chunk));
      }
      bounds().signal.throwIfAborted();
    },
    async release() {
      events.push('stage-release');
      releaseEntered.resolve();
      await beforeRelease?.();
      await releaseDone.promise;
      files.clear();
    },
  }));

  const composition = createIsolatedBackupComposition({hostRoot: path.resolve('synthetic-host'), store,
    stagingParent: stageConfigured ? path.dirname(stageRoot) : null,
    backupReadFactory: unbound ? null : (readFactory ?? (capture => {
      captures.push(capture);
      return {
        list: ({kind}) => json({files: [kind === 'root' ? root : packageMarkerFile], incompleteSearch: false}),
        readMetadata: ({kind}) => json(kind === 'root' ? root : packageMarkerFile),
        readMarker() { events.push('marker'); return packageMarker; },
        listObject(query) {
          events.push('object-list');
          assert.equal(query.rootId, root.id);
          assert.equal(query.backup, backup);
          return json({files: packageObjects.filter(item => item.appProperties.sha256 === query.sha256), incompleteSearch: false});
        },
        readObjectMetadata: ({id}) => json(packageObjects.find(item => item.id === id)),
        async *streamObject({id, signal}) {
          if (hold === 'stream') await holdUntilJoined(signal);
          else {
            const bytes = bodies[packageObjects.findIndex(item => item.id === id)];
            if (bytes.length) yield bytes;
          }
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

async function stagedRestore(t, {digest = hash(data), completeMedia = false, ...options} = {}) {
  const f = setup(t, options);
  const restore = restoreFixture({report(selector, body, state) {
    const report = restoreReport(selector, body, state);
    if (selector === 'prepare') {
      report.data.intent.archive_sha256 = digest;
      report.data.intent.complete_media = completeMedia;
      report.data.intent.staged_configuration_sha256 = null;
      report.data.preview.source.complete_media = completeMedia;
      report.data.preview.target.complete_media = completeMedia;
      report.data.preview.source.configuration_included = false;
      report.data.preview.target.configuration_included = false;
    } else if (report.data?.inspection) {
      report.data.inspection.configuration_included = false;
      if (completeMedia) report.data.inspection.complete_media = true;
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

test('restore preview adopts one exact destination and explicit Confirm preserves original Status', {timeout: 6000}, async t => {
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
  const releaseEntered = Promise.withResolvers(), releaseDone = Promise.withResolvers();
  t.after(() => releaseDone.resolve());
  const release = f.prepared.release;
  f.prepared.release = async () => {
    releaseEntered.resolve();
    await releaseDone.promise;
    return release();
  };
  const confirmed = f.restore.use('confirm', ref);
  await releaseEntered.promise;
  try {
    assert.equal(f.restore.io.revoke(), false);
    assert.equal((await f.restore.prepare()).ordinary_restore.state, 'busy');
  } finally { releaseDone.resolve(); }
  assert.equal((await confirmed).ordinary_restore.state, 'unknown');
  assert.deepEqual(f.restoreEvents.slice(-2), ['destination-check', 'destination-release']);
  const input = f.restore.calls.find(call => call.selector === 'apply').input;
  f.restore.state.status = 'desired-generation-observed';
  const reconciled = (await f.restore.use('status', ref)).ordinary_restore;
  assert.equal(reconciled.state, 'desired-generation-observed');
  assert.equal(reconciled.apply_outcome, 'unknown');
  assert.equal(f.restore.calls.at(-1).input, input);
  assert.equal(await f.restore.host.dispose(), false);
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

test('pre-receipt stage uncertainty survives handoff failure and repeated disposal', async t => {
  for (const warning of [true, false, 'true']) {
    await t.test(JSON.stringify(warning), async t => {
      const f = await stagedRestore(t);
      f.releaseDone.resolve();
      let transfers = 0;
      const result = await f.prepare(async () => {
        transfers++;
        throw Object.assign(new Error('Stage reply unavailable'), {cleanupPending: warning});
      });
      assert.deepEqual(result, {status: 'unavailable', preview: null, cleanupPending: warning === true});
      assert.equal(transfers, 1);
      assert.deepEqual(f.restore.calls, []);
      assert.equal(f.events.includes('stage-release'), true);
      assert.equal(f.restoreEvents.includes('destination-release'), false);
      const disposal = f.restore.host.dispose();
      assert.equal(f.restore.host.dispose(), disposal);
      assert.equal(await disposal, warning === true);
      assert.equal(transfers, 1);
    });
  }
});

test('disposal joins a failed receive before retaining its pre-receipt cleanup warning', {timeout: 5000}, async t => {
  const entered = Promise.withResolvers(), drained = Promise.withResolvers();
  t.after(() => drained.resolve());
  const f = await stagedRestore(t);
  f.releaseDone.resolve();
  const pending = f.prepare(async () => {
    entered.resolve();
    await drained.promise;
    throw Object.assign(new Error('Original receive result lost'), {cleanupPending: true});
  });
  await entered.promise;
  const disposal = f.restore.host.dispose();
  assert.equal(f.restore.host.dispose(), disposal);
  let settled = false;
  void disposal.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.events.includes('stage-release'), false);
  drained.resolve();
  assert.deepEqual(await pending, {status: 'invalidated', preview: null, cleanupPending: true});
  assert.equal(await disposal, true);
  assert.deepEqual(f.restore.calls, []);
  assert.equal(f.events.includes('stage-release'), true);
  assert.equal(f.restoreEvents.includes('destination-release'), false);
});

test('cancelled or expired handoff joins local work without assuming remote Prepare ended', {timeout: 5000}, async t => {
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
      const uncertain = mode === 'cancel-prepare';
      const result = await pending;
      assert.equal(result.status, 'invalidated');
      assert.equal(result.cleanupPending, uncertain);
      assert.equal(f.events.includes('stage-release'), true);
      assert.equal(f.restoreEvents.includes('destination-release'), !uncertain);
      assert.deepEqual(f.restore.calls.map(call => call.selector), mode === 'cancel-prepare' ? ['prepare'] : []);
    });
  }
});


test('private Prepare permits checked retirement after a terminal refusal and withholds it on ambiguous replies', {timeout: 8000}, async t => {
  for (const mode of ['refusal', 'lost', 'malformed', 'wrong-operation']) {
    await t.test(mode, async t => {
      const f = await stagedRestore(t);
      f.releaseDone.resolve();
      f.restore.state.onRaw = report => {
        if (mode === 'lost') throw Error('Original transport lost');
        if (mode === 'malformed') return '{malformed';
        if (mode === 'wrong-operation') {
          report.data.intent.operation = '66666666-6666-4666-8666-666666666666';
          return report;
        }
        return {...report, status: 'busy', outcome: 'not-dispatched', data: null};
      };
      const result = await f.prepare();
      const ambiguous = mode !== 'refusal';
      assert.equal(result.status, 'unavailable');
      assert.equal(result.preview, null);
      assert.equal(result.cleanupPending, ambiguous);
      assert.equal(await f.restore.host.dispose(), ambiguous);
      assert.deepEqual(f.restore.calls.map(call => call.selector), ['prepare']);
      assert.equal(f.restoreEvents.filter(event => event === 'destination-release').length, Number(!ambiguous));
    });
  }
});

test('ambiguous stage-backed Apply retains original Status and never releases the destination', {timeout: 8000}, async t => {
  for (const mode of ['lost', 'malformed', 'cancelled']) {
    await t.test(mode, async t => {
      const f = await stagedRestore(t);
      f.releaseDone.resolve();
      const prepared = await f.prepare();
      assert.equal(prepared.status, 'ready');
      const reference = prepared.preview.ordinary_restore.reference;
      const entered = Promise.withResolvers(), drained = Promise.withResolvers();
      t.after(() => drained.resolve());
      f.restore.state.onRaw = async (report, request) => {
        if (request.selector !== 'apply') return report;
        if (mode === 'lost') throw Error('Original transport lost');
        if (mode === 'malformed') return '{malformed';
        entered.resolve();
        await drained.promise;
        return report;
      };
      const pending = f.restore.use('confirm', reference);
      if (mode === 'cancelled') {
        await entered.promise;
        try {
          const {observer, io, host} = f.restore;
          const wrapped = new MemoryForgetHost({observer, io, beforeIO: () => host.invalidate()}).wrap();
          assert.equal(wrapped.cancel().status, 'cancelled');
          assert.throws(() => wrapped.run('ordinary-restore', {}), /draining/);
          assert.equal((await f.restore.prepare()).ordinary_restore.state, 'busy');
          assert.equal(f.restoreEvents.includes('destination-release'), false);
        } finally { drained.resolve(); }
      }
      assert.equal((await pending).ordinary_restore.state, 'unknown');
      assert.equal(f.restoreEvents.includes('destination-release'), false);
      const original = f.restore.calls.find(call => call.selector === 'apply').input;
      f.restore.state.status = 'desired-generation-observed';
      const status = (await f.restore.use('status', reference)).ordinary_restore;
      assert.equal(status.state, 'desired-generation-observed');
      assert.equal(status.apply_outcome, 'unknown');
      assert.equal(f.restore.calls.at(-1).input, original);
      assert.deepEqual(f.restore.calls.map(call => call.selector), ['prepare', 'apply', 'status']);
      const disposal = f.restore.host.dispose();
      assert.equal(f.restore.host.dispose(), disposal);
      assert.equal(await disposal, true);
      assert.equal(f.restoreEvents.includes('destination-release'), false);
    });
  }
});

test('backup bridge cancellation remains effective through the joined retirement and preserves its warning', {timeout: 6000}, async t => {
  const releaseEntered = Promise.withResolvers(), releaseDone = Promise.withResolvers();
  t.after(() => releaseDone.resolve());
  const f = await stagedPreferences(t, {beforeRelease: async () => {
    releaseEntered.resolve();
    await releaseDone.promise;
    throw Error('Synthetic stage release failure');
  }});
  f.releaseDone.resolve();
  const owner = new IsolatedBackupPreferences({composition: f.composition, isolatedBackup: f.composition.isolatedBackup,
    portable: f.portable, observer: f.observer});
  const document = Symbol();
  const callerCurrent = () => true;
  const [operation, reference] = f.original;
  const request = {version: 1, action: 'preview-preferences', operation, reference, ...identity};
  const pending = owner.request(request, {document, callerCurrent});
  await releaseEntered.promise;
  const cancel = owner.request({version: 1, action: 'cancel', operation}, {document, callerCurrent});
  let settled = false;
  void cancel.then(() => { settled = true; });
  assert.equal((await f.portable.request({action: 'export', ...identity})).portable_configuration.state, 'busy');
  assert.equal(settled, false);
  releaseDone.resolve();
  const result = owner.deliver(await pending, request, callerCurrent);
  assert.equal(result.status, 'invalidated');
  assert.equal(result.preview, null);
  assert.equal(result.cleanupPending, true);
  assert.equal((await cancel).cleanupPending, true);
  assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
  assert.equal(f.calls.some(call => call.selector === 'apply'), false);
});

test('discard is scoped to an issued still-ready backup and leaves original Status after possible Apply', {timeout: 6000}, async t => {
  for (const mode of ['discard', 'manual-successor', 'possible-apply', 'backup-cancel-after-dispatch']) {
    await t.test(mode, async t => {
      const f = await stagedPreferences(t);
      f.releaseDone.resolve();
      const owner = new IsolatedBackupPreferences({composition: f.composition, isolatedBackup: f.composition.isolatedBackup,
        portable: f.portable, observer: f.observer});
      const context = {document: Symbol(), callerCurrent: () => true};
      const [operation, selectedReference] = f.original;
      const request = {version: 1, action: 'preview-preferences', operation, reference: selectedReference, ...identity};
      const ready = owner.deliver(await owner.request(request, context), request, context.callerCurrent);
      assert.equal(ready.status, 'ready');
      const {reference} = ready.preview.portable_configuration;
      if (mode === 'discard') {
        assert.equal(f.portable.discardHandoffPreview(structuredClone(ready.preview)), false);
        assert.equal(f.portable.discardHandoffPreview(ready.preview), true);
        assert.equal((await f.portable.request({action: 'confirm', ...identity, reference})).portable_configuration.state, 'unavailable');
      } else if (mode === 'manual-successor') {
        const manual = await f.portable.request({action: 'prepare', ...identity, artifact_base64: manualArtifact});
        assert.equal(manual.portable_configuration.state, 'ready');
        assert.equal(f.portable.discardHandoffPreview(ready.preview), false);
        assert.equal(f.portable.assertCurrent(manual), manual);
      } else {
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        t.after(() => release.resolve());
        f.portableState.onApply = async report => { entered.resolve(); await release.promise; return report; };
        f.portableState.mode = 'lost';
        const pending = f.portable.request({action: 'confirm', ...identity, reference});
        await entered.promise;
        assert.equal(f.portable.discardHandoffPreview(ready.preview), false);
        if (mode === 'backup-cancel-after-dispatch') {
          const cancelled = await owner.request({version: 1, action: 'cancel', operation}, context);
          assert.equal(cancelled.status, 'invalidated');
        }
        release.resolve();
        assert.equal((await pending).portable_configuration.state, 'unknown');
        f.portableState.mode = 'normal';
        assert.equal((await f.portable.request({action: 'status', ...identity, reference})).portable_configuration.state,
          'desired-file-observed');
      }
      assert.equal(f.calls.filter(call => call.selector === 'apply').length, Number(mode === 'possible-apply' || mode === 'backup-cancel-after-dispatch'));
    });
  }
});

async function stagedPreferences(t, options = {}) {
  const f = setup(t, {portableBytes: json(portableArtifact), ...options});
  const target = portableFixture();
  const original = await selection(f.composition);
  const [operation, reference] = original;
  const host = f.composition.isolatedBackup;
  assert.equal(host.request({version: 1, action: 'download', operation, reference}).status, 'downloading');
  const deadline = performance.now() + 3000;
  let receipt;
  do {
    receipt = host.request({version: 1, action: 'status', operation});
    if (receipt.status !== 'downloading') break;
    await delay(5);
  } while (performance.now() < deadline);
  assert.equal(receipt.status, 'verified');
  assert.equal(host.canHandoff(operation, reference), true);
  t.after(() => {
    f.releaseDone.resolve();
    return Promise.all([f.composition.dispose(), target.portable.dispose()]);
  });
  const prepare = (observation = identity) =>
    f.composition.preparePreferences(...original, {portable: target.portable, target: observation});
  return {...f, ...target, original, prepare};
}

test('verified preferences use one sealed member and wait for retirement before explicit Confirm', {timeout: 10000}, async t => {
  for (const noop of [false, true]) {
    await t.test(noop ? 'no change' : 'ready', async t => {
      const members = [];
      const f = await stagedPreferences(t, {onMemberRead: member => members.push(member)});
      f.portableState.noop = noop;
      const [operation, reference] = f.original;
      const host = f.composition.isolatedBackup;
      assert.equal((await f.composition.preparePreferences(operation, reference)).status, 'unavailable');
      const restore = f.io.acquire('ordinary-restore', 'prepare', 'prepare');
      assert.ok(restore);
      assert.equal((await f.prepare()).status, 'busy');
      f.io.release(restore);
      assert.equal((await f.prepare({...identity, boot_id: 'c'.repeat(36)})).status, 'invalidated');
      assert.equal(host.canHandoff(operation, reference), true);
      assert.deepEqual(f.calls, []);

      const actions = () => f.calls.map(call => call.selector);
      const pending = f.prepare();
      let published = false;
      void pending.then(() => { published = true; });
      await f.releaseEntered.promise;
      assert.equal(published, false);
      assert.equal(f.io.acquire('ordinary-restore', 'prepare', 'prepare'), null);
      assert.deepEqual(actions(), ['inspect', 'prepare']);
      assert.deepEqual(members, [{name: 'portable-configuration.json', ...ref(json(portableArtifact))}]);
      assert.deepEqual(f.calls[1].body.artifact, portableArtifact);
      assert.deepEqual(
        {connection_id: f.portableState.packets[1].connection_id, boot_id: f.portableState.packets[1].boot_id},
        identity
      );

      f.releaseDone.resolve();
      const result = await pending;
      assert.equal(result.cleanupPending, false);
      const preview = result.preview.portable_configuration;
      assert.equal(result.status, noop ? 'no-change' : 'ready');
      assert.equal(preview.state, result.status);
      assert.equal(preview.export_file, null);
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PORTABLE'), false);
      assert.equal(JSON.stringify(result).includes('artifact_base64'), false);
      assert.equal(host.canHandoff(operation, reference), false);
      assert.equal((await f.prepare()).status, 'invalidated');
      assert.deepEqual(actions(), ['inspect', 'prepare']);
      if (noop) {
        assert.equal(preview.reference, null);
      } else {
        const confirmed = await f.portable.request({action: 'confirm', ...identity, reference: preview.reference});
        assert.equal(confirmed.portable_configuration.state, 'verified');
        assert.deepEqual(actions(), ['inspect', 'prepare', 'apply']);
        const original = f.portableState.prepared.get(f.calls[1].body.operation);
        assert.deepEqual(f.calls[2].body, {intent: original.intent, artifact: portableArtifact});
      }
      assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
    });
  }
});

test('preferences preview refuses a lost source, changed target or uncertain cleanup', {timeout: 10000}, async t => {
  const readbackFaults = {
    'wrong-readback': (_, bytes) => Buffer.alloc(bytes.length, 7),
    'short-readback': (_, bytes) => bytes.subarray(0, bytes.length - 1),
    'excess-readback': (_, bytes) => Buffer.concat([bytes, Buffer.from([0])]),
  };
  for (const mode of ['missing-member', 'changed-member', ...Object.keys(readbackFaults),
    'unsupported', 'source', 'target', 'cleanup-pending']) {
    await t.test(mode, async t => {
      const f = await stagedPreferences(t, {memberChunk: readbackFaults[mode]});
      if (mode === 'missing-member') f.files.delete('portable-configuration.json');
      if (mode === 'changed-member') f.files.set('portable-configuration.json', [Buffer.from('wrong bytes')]);
      if (mode === 'unsupported') {
        const run = f.observer.run;
        f.observer.run = async function(action, request) {
          const value = await run.call(this, action, request);
          return {...value, portable_configuration_raw: {status: 'unsupported', stdout_base64: null}};
        };
      }
      const pending = f.prepare();
      await f.releaseEntered.promise;
      if (mode === 'source') f.composition.isolatedBackup.invalidate();
      if (mode === 'target') f.observer.lastObservation.boot_id = 'c'.repeat(36);
      if (mode === 'cleanup-pending') f.releaseDone.reject(Error('Unconfirmed cleanup'));
      else f.releaseDone.resolve();

      const {status, preview, cleanupPending} = await pending;
      const expected = {unsupported: 'unsupported', source: 'invalidated', target: 'invalidated'};
      assert.equal(status, expected[mode] ?? 'unavailable');
      assert.equal(preview, null);
      assert.equal(cleanupPending, mode === 'cleanup-pending');
      if (mode === 'cleanup-pending') {
        const [operation] = f.original;
        const retired = await f.composition.isolatedBackup.request({version: 1, action: 'cancel', operation});
        assert.equal(retired.cleanupPending, true);
      }
      const actions = f.calls.map(call => call.selector);
      const invalidMember = ['missing-member', 'changed-member'].includes(mode) || Object.hasOwn(readbackFaults, mode);
      assert.deepEqual(actions, mode === 'unsupported' ? ['inspect'] : invalidMember ? [] : ['inspect', 'prepare']);
      assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
    });
  }
});

test('private preferences keep the lane through canceled read, late command and repeated disposal', {timeout: 12000}, async t => {
  for (const phase of ['read', 'inspect', 'prepare']) {
    await t.test(phase, async t => {
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
      const aborted = Promise.withResolvers();
      t.after(() => proceed.resolve());
      const f = await stagedPreferences(t, {holdMemberRead: phase === 'read' ? async bounds => {
        bounds().signal.addEventListener('abort', aborted.resolve, {once: true});
        entered.resolve();
        await proceed.promise;
      } : undefined});
      const hold = async value => {
        entered.resolve();
        await proceed.promise;
        return value;
      };
      if (phase === 'inspect') {
        f.portableState.onInspect = hold;
        f.portable.budgetMs = 1000;
      }
      if (phase === 'prepare') f.portableState.onPrepare = hold;
      const rawCancel = f.observer.cancel;
      f.observer.cancel = function() {
        if (phase === 'inspect' && f.calls.length === 1) aborted.resolve();
        return rawCancel.call(this);
      };
      let externalCalls = 0;
      const observe = f.observer.observe;
      f.observer.observe = function(...args) {
        externalCalls++;
        return observe.apply(this, args);
      };
      const wrapped = f.forget.wrap();
      const pending = f.prepare();
      await entered.promise;
      let disposal;
      if (phase === 'read') {
        const cancels = f.observer.cancels;
        assert.equal(wrapped.cancel().status, 'cancelled');
        assert.equal(f.observer.cancels, cancels);
        await aborted.promise;
      } else if (phase === 'inspect') {
        await aborted.promise; // Original deadline expires while Inspect is pending.
      } else {
        disposal = f.portable.dispose();
        assert.equal(f.portable.dispose(), disposal);
      }
      assert.throws(() => wrapped.observe(), /Maintenance operation is draining/);
      assert.equal(externalCalls, 0);
      assert.equal(f.io.acquire('ordinary-restore', 'prepare', 'prepare'), null);
      assert.equal(f.events.includes('stage-release'), false);

      let settled = false;
      if (disposal) void disposal.then(() => { settled = true; });
      proceed.resolve();
      await f.releaseEntered.promise;
      assert.equal(f.io.acquire('ordinary-restore', 'prepare', 'prepare'), null);
      assert.equal(settled, false);
      f.releaseDone.resolve();
      assert.deepEqual(await pending, {status: 'invalidated', preview: null, cleanupPending: false});
      await disposal;
      assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
      assert.deepEqual(f.calls.map(call => call.selector),
        phase === 'read' ? [] : phase === 'inspect' ? ['inspect'] : ['inspect', 'prepare']);
      await wrapped.observe();
      assert.equal(externalCalls, 1);
      const next = f.io.acquire('ordinary-restore', 'prepare', 'prepare');
      assert.ok(next);
      f.io.release(next);
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

async function retainedStagePackage() {
  const root = new URL('./fixtures/isolated-backup-actual/', import.meta.url);
  const bytes = await readFile(new URL('receipt.json', root));
  assert.equal(hash(bytes), 'e90a495bb2e3a8c914a301b47b96d93b5946c9644bee4c3be8b06ede7c32f8b3');
  const retained = JSON.parse(bytes).cases.complete;
  const members = new Map();
  for (const [name, expected] of Object.entries(retained.files)) {
    const content = await readFile(new URL(retained.directory + '/' + name, root));
    assert.deepEqual(ref(content), expected);
    members.set(name, content);
  }
  return {...retained, members};
}

function assertRetainedStageFrame(retained, h, raw) {
  const objectNames = [...retained.members.keys()].filter(name => name.startsWith('data/objects/')).sort();
  assert.equal(h.object_count, objectNames.length);
  const inventory = createHash('sha256').update('remarkable-buddies-restore-stage-inventory-v1\0');
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objectNames.length);
  inventory.update(count);
  let offset = 0, payloadBytes = 0;
  for (const name of ['data/backup.json', ...objectNames, 'portable-configuration.json', 'isolated-backup.json']) {
    const expected = retained.members.get(name);
    const descriptor = raw.subarray(offset, offset + 40);
    inventory.update(descriptor);
    assert.equal(descriptor.readBigUInt64BE(), BigInt(expected.length), name);
    assert.equal(descriptor.subarray(8).toString('hex'), hash(expected), name);
    offset += 40;
    assert.deepEqual(raw.subarray(offset, offset + expected.length), expected);
    offset += expected.length;
    payloadBytes += expected.length;
  }
  assert.equal(raw.length, offset);
  assert.equal(h.payload_bytes, payloadBytes);
  assert.equal(h.inventory_sha256, inventory.digest('hex'));
}

function stagePeer(f, retained, outcome = 'sealed') {
  const selectors = [];
  let receipt;
  f.restore.observer.runIsolatedStage = async function(request, bounds, body) {
    assert.ok(bounds.current() && !bounds.signal.aborted && bounds.remainingMs() > 0);
    assert.deepEqual({connection_id: request.connection_id, boot_id: request.boot_id}, identity);
    selectors.push(request.selector);
    let settlement, status, responseReceipt, wrote = true;
    if (request.selector === 'receive-isolated-stage') {
      const h = request.header;
      assert.equal(h.marker_sha256, retained.marker_sha256);
      assert.match(h.stage_id, /^[a-f0-9-]{14}4[a-f0-9-]{21}$/);
      if (outcome === 'lost') return {dispatch: 'possible', stdout: null, wrote: false};
      if (!['sealed', 'wrong-receipt'].includes(outcome)) {
        settlement = outcome;
        status = outcome === 'no-output' ? 'unavailable' : 'failed';
        responseReceipt = null;
        wrote = false;
      } else {
        const chunks = [];
        const cutoff = performance.now() + Math.min(12000, bounds.remainingMs());
        const remaining = () => Math.min(bounds.remainingMs(), Math.floor(cutoff - performance.now()));
        await body(async chunk => { chunks.push(Buffer.from(chunk)); }, bounds.signal, remaining);
        const raw = Buffer.concat(chunks);
        assertRetainedStageFrame(retained, h, raw);
        receipt = responseReceipt = {version: 1, stage_id: h.stage_id, boot_id: h.boot_id,
          marker_sha256: h.marker_sha256, inventory_sha256: outcome === 'wrong-receipt' ? '0'.repeat(64) : h.inventory_sha256,
          custody_sha256: 'c'.repeat(64),
          root: '/home/root/.local/share/.remarkable-buddies-restore-stage-v1/restore-v1-' + h.stage_id};
        settlement = 'sealed';
        status = 'ok';
      }
    } else {
      assert.equal(body, undefined);
      assert.deepEqual(JSON.parse(Buffer.from(request.input_base64, 'base64')), receipt);
      settlement = request.selector === 'check-isolated-stage' ? 'verified' : 'released';
      status = 'ok';
      responseReceipt = receipt;
    }
    const report = {report_version: 1, operation: request.selector, status, incomplete: status !== 'ok',
      activation_performed: false, data: {settlement, receipt: responseReceipt}};
    const envelope = {contract_version: 1, status: 'observed', observation: this.lastObservation, dispatch: 'possible',
      stdout_base64: Buffer.from(JSON.stringify(report) + '\n').toString('base64')};
    return {dispatch: 'possible', stdout: Buffer.from(JSON.stringify(envelope) + '\n'), wrote};
  };
  return selectors;
}

function stageHelperFixture(trace, sample) {
  const fs = require('node:fs');
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const stdin = Buffer.concat(chunks);
    const boundary = stdin.indexOf(10);
    if (boundary === -1) throw Error('Fixture did not receive a control line');
    const control = stdin.subarray(0, boundary + 1);
    const body = stdin.subarray(boundary + 1);
    const request = JSON.parse(control);
    const settlement = {
      'receive-isolated-stage': 'sealed',
      'check-isolated-stage': 'verified',
      'release-isolated-stage': 'released',
    }[request.selector];
    if (!settlement) throw Error('Unexpected fixture selector');
    const h = request.header;
    const receipt = h ? {version: 1, stage_id: h.stage_id, boot_id: h.boot_id, marker_sha256: h.marker_sha256,
      inventory_sha256: h.inventory_sha256, custody_sha256: 'c'.repeat(64),
      root: '/home/root/.local/share/.remarkable-buddies-restore-stage-v1/restore-v1-' + h.stage_id} :
      JSON.parse(Buffer.from(request.input_base64, 'base64'));
    fs.appendFileSync(trace, JSON.stringify({control: control.toString('base64'), body: body.toString('base64'), receipt}) + '\n');
    const report = {report_version: 1, operation: request.selector, status: 'ok', incomplete: false,
      activation_performed: false, data: {settlement, receipt}};
    const envelope = {contract_version: 1, status: 'observed', observation: sample, dispatch: 'possible',
      stdout_base64: Buffer.from(JSON.stringify(report) + '\n').toString('base64')};
    process.stdout.write(JSON.stringify(envelope) + '\n');
  });
  process.stdout.write('RE');
  setImmediate(() => process.stdout.write('ADY\n'));
}

test('wired stage adapter composes the real supervised pipe with Prepare, Confirm and release', {timeout: 12000}, async t => {
  const retained = await retainedStagePackage();
  const f = await stagedRestore(t, {retained, digest: retained.files['data/backup.json'].sha256, completeMedia: true});
  f.releaseDone.resolve();
  const folder = await mkdtemp(path.join(tmpdir(), 'manager-composed-stage-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const trace = path.join(folder, 'stage-wire');
  const sample = f.restore.observer.lastObservation;
  await writeFile(path.join(folder, 'isolated_stage_transport.py'),
    '(' + stageHelperFixture.toString() + ')(' + JSON.stringify(trace) + ',' + JSON.stringify(sample) + ');');
  const wired = new WiredObserver({config: path.join(folder, 'fixture'), python: process.execPath,
    script: path.join(folder, 'wired_observer.py')});
  wired.lastObservation = structuredClone(sample);
  f.restore.host.observer = wired;

  const sequence = [];
  const start = wired.runIsolatedStage.bind(wired);
  wired.runIsolatedStage = async (request, bounds, body) => {
    assert.equal(wired.active, null);
    let writerFinished = !body;
    const pending = start(request, bounds, body && (async (...args) => {
      await body(...args);
      writerFinished = true;
    }));
    const child = wired.active;
    assert.ok(child?.pid);
    let closed = false;
    child.once('close', () => { closed = true; });
    const reply = await pending;
    assert.ok(writerFinished && closed);
    assert.ok(reply.wrote);
    assert.equal(child.exitCode, 0);
    assert.equal(wired.active, null);
    sequence.push(request.selector);
    return reply;
  };
  wired.run = (action, request) => {
    assert.equal(wired.active, null);
    sequence.push(request.selector);
    return f.restore.observer.run(action, request);
  };

  const result = await f.prepare(createIsolatedStageDestination(wired));
  assert.equal(result.status, 'ready');
  assert.equal(result.cleanupPending, false);
  assert.equal(result.preview.ordinary_restore.preview.source.complete_media, true);
  assert.doesNotMatch(JSON.stringify(result), /restore-v1-|custody_sha256|inventory_sha256/);
  assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
  f.restore.state.apply = 'restored';
  assert.equal((await f.restore.use('confirm', result.preview.ordinary_restore.reference)).ordinary_restore.state, 'restored');
  assert.deepEqual(sequence, ['receive-isolated-stage', 'check-isolated-stage', 'prepare', 'check-isolated-stage',
    'check-isolated-stage', 'apply', 'release-isolated-stage']);
  assert.equal(await f.restore.host.dispose(), false);
  assert.equal(wired.active, null);

  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 5);
  const decoded = calls.map(call => {
    const control = Buffer.from(call.control, 'base64').toString('utf8');
    const request = JSON.parse(control);
    assert.equal(control, JSON.stringify(request) + '\n');
    assert.ok(Number.isInteger(request.budget_ms) && request.budget_ms > 0 && request.budget_ms <= 12000);
    assert.deepEqual({connection_id: request.connection_id, boot_id: request.boot_id}, identity);
    return {request, body: Buffer.from(call.body, 'base64'), receipt: call.receipt};
  });
  const [received, ...subsequent] = decoded;
  const {header, selector} = received.request;
  assert.equal(selector, 'receive-isolated-stage');
  assert.deepEqual(Object.keys(received.request).sort(), ['boot_id', 'budget_ms', 'connection_id', 'header', 'selector']);
  assert.deepEqual(Object.keys(header).sort(),
    ['boot_id', 'inventory_sha256', 'marker_sha256', 'object_count', 'payload_bytes', 'stage_id', 'version']);
  assert.equal(header.version, 1);
  assert.equal(header.boot_id, identity.boot_id);
  assert.equal(header.marker_sha256, retained.marker_sha256);
  assert.match(header.stage_id, /^[a-f0-9-]{14}4[a-f0-9-]{21}$/);
  assertRetainedStageFrame(retained, header, received.body);
  assert.deepEqual(received.receipt, {version: 1, stage_id: header.stage_id, boot_id: header.boot_id,
    marker_sha256: header.marker_sha256, inventory_sha256: header.inventory_sha256, custody_sha256: 'c'.repeat(64),
    root: '/home/root/.local/share/.remarkable-buddies-restore-stage-v1/restore-v1-' + header.stage_id});
  assert.equal(f.restore.calls[0].body.source, received.receipt.root + '/data');
  assert.equal(f.restore.calls[1].body.source, received.receipt.root + '/data');
  assert.deepEqual(subsequent.map(call => call.request.selector),
    ['check-isolated-stage', 'check-isolated-stage', 'check-isolated-stage', 'release-isolated-stage']);
  for (const {request, body, receipt} of subsequent) {
    assert.deepEqual(Object.keys(request).sort(), ['boot_id', 'budget_ms', 'connection_id', 'input_base64', 'selector']);
    assert.equal(request.input_base64, Buffer.from(JSON.stringify(received.receipt)).toString('base64'));
    assert.deepEqual(receipt, received.receipt);
    assert.equal(body.length, 0);
  }
});


test('wired stage adapter reduces failed receives and preserves possible creation through disposal', {timeout: 6000}, async t => {
  const retained = await retainedStagePackage();
  for (const outcome of ['no-output', 'cleaned', 'unconfirmed', 'lost', 'wrong-receipt']) {
    await t.test(outcome, async t => {
      const f = await stagedRestore(t, {retained, digest: retained.files['data/backup.json'].sha256, completeMedia: true});
      f.releaseDone.resolve();
      const selectors = stagePeer(f, retained, outcome);
      const result = await f.prepare(createIsolatedStageDestination(f.restore.observer));
      const cleanupPending = ['lost', 'unconfirmed', 'wrong-receipt'].includes(outcome);
      assert.deepEqual(result, {status: 'unavailable', preview: null, cleanupPending});
      assert.deepEqual(selectors, ['receive-isolated-stage']);
      assert.deepEqual(f.restore.calls, []);
      assert.equal(await f.restore.host.dispose(), cleanupPending);
      assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
    });
  }
});

test('wired stage adapter retires a later preview only under an idle joined lease', {timeout: 6000}, async t => {
  const retained = await retainedStagePackage();
  for (const busy of [false, true]) {
    await t.test(busy ? 'competing lease' : 'idle lease', async t => {
      const f = await stagedRestore(t, {retained, digest: retained.files['data/backup.json'].sha256, completeMedia: true});
      f.releaseDone.resolve();
      const selectors = stagePeer(f, retained);
      assert.equal((await f.prepare(createIsolatedStageDestination(f.restore.observer))).status, 'ready');
      const competing = busy && f.restore.io.acquire('competing', 'original', 'check', {joined: true});
      if (busy) assert.ok(competing);
      const disposal = f.restore.host.dispose();
      assert.equal(await disposal, busy);
      if (competing) f.restore.io.release(competing);
      assert.equal(f.restore.host.dispose(), disposal);
      assert.equal(selectors.filter(selector => selector === 'release-isolated-stage').length, busy ? 0 : 1);
      assert.equal(f.restore.observer.cancels, 0);
    });
  }
});


test('wired stage disposal joins the cancelled sealed member read before retiring its source', {timeout: 6000}, async t => {
  const retained = await retainedStagePackage();
  const entered = Promise.withResolvers(), stopped = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const f = await stagedRestore(t, {retained, digest: retained.files['data/backup.json'].sha256, completeMedia: true,
    holdMemberRead: async bounds => {
      const {signal, timeoutMs} = bounds();
      assert.ok(timeoutMs <= 12000);
      signal.addEventListener('abort', stopped.resolve, {once: true});
      entered.resolve();
      await finish.promise;
      signal.throwIfAborted();
    }});
  f.releaseDone.resolve();
  const selectors = stagePeer(f, retained);
  const transfer = f.prepare(createIsolatedStageDestination(f.restore.observer));
  await entered.promise;
  const disposal = f.restore.host.dispose();
  await stopped.promise;
  assert.equal(f.events.includes('stage-release'), false);
  assert.equal(f.restore.io.revoke(), false);
  finish.resolve();
  assert.deepEqual(await transfer, {status: 'invalidated', preview: null, cleanupPending: true});
  assert.equal(await disposal, true);
  assert.deepEqual(selectors, ['receive-isolated-stage']);
  assert.deepEqual(f.restore.calls, []);
  assert.equal(f.events.filter(event => event === 'stage-release').length, 1);
});

test('expired active stage check cannot turn its retirement into a new lease', {timeout: 6000}, async t => {
  const retained = await retainedStagePackage();
  const f = await stagedRestore(t, {retained, digest: retained.files['data/backup.json'].sha256, completeMedia: true});
  f.releaseDone.resolve();
  let now = performance.now();
  f.restore.host.now = () => now;
  const selectors = stagePeer(f, retained);
  const result = await f.prepare(createIsolatedStageDestination(f.restore.observer));
  assert.equal(result.status, 'ready');
  const original = f.restore.observer.runIsolatedStage;
  f.restore.observer.runIsolatedStage = async function(...args) {
    const reply = await original.apply(this, args);
    if (args[0].selector === 'check-isolated-stage') now += 20000;
    return reply;
  };
  const confirmed = await f.restore.use('confirm', result.preview.ordinary_restore.reference);
  assert.equal(confirmed.ordinary_restore.state, 'not-dispatched');
  assert.deepEqual(f.restore.calls.map(call => call.selector), ['prepare']);
  assert.equal(await f.restore.host.dispose(), true);
  assert.deepEqual(selectors, ['receive-isolated-stage', 'check-isolated-stage', 'check-isolated-stage', 'check-isolated-stage']);
});
