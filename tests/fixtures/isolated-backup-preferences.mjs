import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createIsolatedBackupComposition} from '../../host/isolated-backup-composition.mjs';
import {IsolatedBackupStaging} from '../../host/isolated-backup-staging.mjs';
import {IsolatedBackupVerifier} from '../../host/isolated-backup-verifier.mjs';
import {DRIVE_SCOPE} from '../../host/drive-auth.mjs';
import {artifact, hostFixture, identity} from './portable-configuration.mjs';

export {identity};
const json = value => Buffer.from(JSON.stringify(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = bytes => ({bytes: bytes.length, sha256: hash(bytes)});
const record = value => ({value: structuredClone(value), digest: hash(json(value))});

export async function backupPreferencesFixture(directory, {beforeRelease} = {}) {
  const target = hostFixture();
  const data = json({format: 1, manifests: [{}], objects: [], complete_media: false, config_snapshot: null});
  const prefs = json(artifact);
  const markerBytes = json({isolated_backup_version: 1, data_backup: ref(data), portable_configuration: ref(prefs)});
  const backup = 'db766c9e-d346-41fd-aad4-17d754fd50c7';
  const device = '3696d8c3-8889-4b67-917d-ea52b54cefe1';
  const file = (id, size, properties) => ({id, size: String(size), spaces: ['appDataFolder'], trashed: false,
    mimeType: 'application/octet-stream', appProperties: {buddy_isolated: '1', root: 'Root', backup, ...properties}});
  const root = file('Root', 0, {kind: 'root', device, grant: 'a'.repeat(64)});
  const marker = file('Marker', markerBytes.length, {kind: 'marker', predecessor: root.id, sha256: hash(markerBytes)});
  const objects = [data, prefs].map((bytes, index) => file('Object' + index, bytes.length, {kind: 'object', sha256: hash(bytes)}));
  const registration = {schema: 1, type: 'google-desktop', clientId: '123456789012-fixture.apps.googleusercontent.com',
    clientSecret: null};
  let grant = {schema: 1, clientId: registration.clientId, account: {permissionId: 'fixture', label: 'fixture@example.invalid'},
    checkedAt: Date.now(), tokens: {token_type: 'Bearer', access_token: 'synthetic', refresh_token: 'synthetic-refresh',
      scope: DRIVE_SCOPE, expiry_date: Date.now() + 900000}};
  const store = {
    root: path.join(directory, 'drive'), python: path.join(directory, 'unreachable-python'),
    client: () => record(registration), grant: () => record(grant),
    save(value) { grant = structuredClone(value); return {committed: true, digest: record(grant).digest}; },
  };
  const stageRoot = path.join(directory, 'staging', 'stage');
  const files = new Map();
  let releases = 0;
  const overrides = [
    [IsolatedBackupStaging, 'available', async () => true],
    [IsolatedBackupStaging, 'freeBytes', async () => 1024 ** 3],
    [IsolatedBackupStaging, 'create', async () => ({
      root: stageRoot,
      async openExclusive(name) {
        assert.equal(files.has(name), false);
        const chunks = [];
        files.set(name, chunks);
        return {async write(bytes) { chunks.push(Buffer.from(bytes)); }, async sync() {}, async close() {}};
      },
      async assertOwned(names) { return names.length === files.size && names.every(name => files.has(name)); },
      async readVerified(member, _names, bounds, write) {
        const bytes = Buffer.concat(files.get(member.name));
        assert.deepEqual(ref(bytes), {bytes: member.bytes, sha256: member.sha256});
        bounds().signal.throwIfAborted();
        await write(bytes);
      },
      async release() {
        releases++;
        try { await beforeRelease?.(); }
        finally { files.clear(); }
      },
    })],
    [IsolatedBackupVerifier, 'available', async () => true],
    [IsolatedBackupVerifier, 'verify', async ({root, markerSha256}) => {
      assert.equal(root, stageRoot);
      assert.equal(markerSha256, hash(markerBytes));
      for (const [name, bytes] of [['isolated-backup.json', markerBytes], ['data/backup.json', data], ['portable-configuration.json', prefs]]) {
        assert.deepEqual(Buffer.concat(files.get(name)), bytes);
      }
      return Buffer.concat([json({report_version: 1, operation: 'inspect-isolated', status: 'ok', incomplete: true,
        activation_performed: false, data: {isolated_package: {
          marker_sha256: hash(markerBytes), data_backup: ref(data), portable_configuration: ref(prefs),
          declared_settings: 3, data: {format: 1, manifests: 1, objects: 0, selected_scopes: 0, selection_receipts: 0,
            complete_media: false, configuration_included: false},
        }}}), Buffer.from('\n')]);
    }],
  ];
  const originals = overrides.map(([owner, name, method]) => {
    const original = owner.prototype[name];
    owner.prototype[name] = method;
    return [owner, name, original];
  });
  const composition = createIsolatedBackupComposition({hostRoot: directory, store, stagingParent: path.dirname(stageRoot),
    backupReadFactory: () => ({
      list: ({kind}) => json({files: [kind === 'root' ? root : marker], incompleteSearch: false}),
      readMetadata: ({kind}) => json(kind === 'root' ? root : marker),
      readMarker: () => Buffer.from(markerBytes),
      listObject: ({sha256}) => json({files: objects.filter(object => object.appProperties.sha256 === sha256), incompleteSearch: false}),
      readObjectMetadata: ({id}) => json(objects.find(object => object.id === id)),
      async *streamObject({id}) { yield Buffer.from(id === objects[0].id ? data : prefs); },
    }),
  });
  composition.driveAuth.oauth = () => ({setCredentials() {}, refreshAccessToken() { assert.fail('Unexpected refresh'); }});
  composition.driveAuth.account = async () => ({account: grant.account, tokens: grant.tokens});
  const close = async () => {
    try { await Promise.all([composition.dispose(), target.f.portable.dispose()]); }
    finally { for (const [owner, name, original] of originals) owner.prototype[name] = original; }
  };
  try { assert.equal((await composition.driveAuth.check()).status, 'connected'); }
  catch (error) { await close(); throw error; }
  const snapshot = () => ({...target.snapshot(), releases,
    prepareOperation: target.f.calls.find(call => call.action === 'portable-configuration' && call.selector === 'prepare')?.body?.operation ?? null});
  return {composition, observer: target.f.observer, target, close, snapshot};
}
