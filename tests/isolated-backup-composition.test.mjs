import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import {DRIVE_SCOPE} from '../host/drive-auth.mjs';
import {createIsolatedBackupComposition} from '../host/isolated-backup-composition.mjs';
import {IsolatedBackupStaging} from '../host/isolated-backup-staging.mjs';
import {IsolatedBackupVerifier} from '../host/isolated-backup-verifier.mjs';

const json = value => Buffer.from(JSON.stringify(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = bytes => ({bytes: bytes.length, sha256: hash(bytes)});
const backup = '12345678-1234-4123-8123-123456789abc';
const device = '98765432-4321-4321-8321-cba987654321';
const data = json({format: 1, manifests: [{}], objects: [], complete_media: true, config_snapshot: null});
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

function setup(t, {stageConfigured = true, hold = null, unavailable = false, unbound = false} = {}) {
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
    return Buffer.concat([json({report_version: 1, operation: 'inspect-isolated', status: 'ok', incomplete: false,
      activation_performed: false, data: {isolated_package: {
        marker_sha256: hash(markerBytes), data_backup: ref(data), portable_configuration: ref(preferences),
        declared_settings: 0, data: {format: 1, manifests: 1, objects: 0, selected_scopes: 0, selection_receipts: 0,
          complete_media: true, configuration_included: false},
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
    async release() {
      events.push('stage-release');
      releaseEntered.resolve();
      await releaseDone.promise;
      files.clear();
    },
  }));

  const composition = createIsolatedBackupComposition({hostRoot: path.resolve('synthetic-host'), store,
    stagingParent: stageConfigured ? path.dirname(stageRoot) : null,
    backupReadFactory: unbound ? null : capture => {
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
    },
  });
  composition.driveAuth.oauth = () => ({setCredentials() {}, refreshAccessToken() { assert.fail('Unexpected refresh'); }});
  composition.driveAuth.account = async () => ({account: grant.account, tokens: grant.tokens});
  return {composition, events, captures, files, entered, drained, releaseEntered, releaseDone};
}

async function status(host, operation) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = host.request({version: 1, action: 'status', operation});
    if (!['scanning', 'selecting'].includes(value.status)) return value;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Backup operation did not settle');
}

async function selection(composition) {
  const {isolatedBackup: host, driveAuth} = composition;
  assert.equal((await driveAuth.check()).status, 'connected');
  const inspected = await status(host, host.request(scan).operation);
  assert.equal(inspected.status, 'observed');
  const selected = host.request({version: 1, action: 'select', inspection: inspected.operation,
    choice: inspected.backups[0].revisions[0].reference});
  const result = await status(host, selected.operation);
  assert.equal(result.status, 'selected');
  return [result.operation, result.selection.reference];
}

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
  assert.equal(result.inspection.completeMedia, true);
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
