import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {IsolatedBackupReader} from '../host/isolated-backup-reader.mjs';

// Source-derived synthetic frames for the published Buddy V1 shape.
// These are not captured producer bytes or actual Drive responses.
const backup = 'db766c9e-d346-41fd-aad4-17d754fd50c7';
const device = '3696d8c3-8889-4b67-917d-ea52b54cefe1';
const manifestDigest = 'f'.repeat(64);
const preferencesDigest = 'c'.repeat(64);
const marker = Buffer.from('{\n  "isolated_backup_version": 1, "data_backup": ' +
  '{"sha256":"' + manifestDigest + '","bytes":8388608},\n' +
  '  "portable_configuration": {"bytes":131072,"sha256":"' + preferencesDigest + '"}\n}\n');
const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));

function file(id, size, appProperties) {
  return {id, size: String(size), appProperties, trashed: false, mimeType: 'application/octet-stream', spaces: ['appDataFolder']};
}

function root(id = 'PrivateRoot', backupId = backup) {
  return file(id, 0, {
    buddy_isolated: '1', kind: 'root', root: id, backup: backupId, device, grant: '0'.repeat(64),
  });
}

function revision(id = 'PrivateFirst', predecessor = 'PrivateRoot', raw = marker) {
  return file(id, raw.length, {
    buddy_isolated: '1', kind: 'marker', root: 'PrivateRoot', backup, predecessor, sha256: sha256(raw),
  });
}

function open({roots = [root()], revisions = [revision()], raw = marker, list, metadata, content, now, timeoutMs} = {}) {
  let current = true;
  const requests = [];
  const respond = (method, query, value) => {
    requests.push({method, ...query});
    return Buffer.isBuffer(value) ? value : json(value);
  };
  const binding = {
    isCurrent: () => current,
    list: query => respond('list', query, list ? list(query) :
      {files: query.kind === 'root' ? roots : revisions, incompleteSearch: false}),
    readMetadata: query => respond('readMetadata', query, metadata ? metadata(query) :
      [...roots, ...revisions].find(file => file.id === query.id)),
    readMarker: query => respond('readMarker', query, content ? content(query) : raw),
  };
  const reader = new IsolatedBackupReader({binding, now, timeoutMs});
  return {reader, requests, binding, expire: () => { current = false; }};
}

async function inspect(fixture) {
  const result = await fixture.reader.inspect();
  assert.equal(result.status, 'observed');
  return result.backups[0].revisions;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return {promise, resolve, reject};
}

test('complete metadata pages establish order; explicit historical selection reads original marker only', async () => {
  const first = revision();
  // Two successive commits may have identical package bytes.
  const next = revision('PrivateSecond', first.id);
  const f = open({revisions: [first, next], list: query => {
    if (query.kind === 'root') return {files: [root()], incompleteSearch: false};
    if (!query.pageToken) return {files: [next], nextPageToken: 'opaque-page', incompleteSearch: false};
    return {files: [first], incompleteSearch: false};
  }});
  const [earlier, later] = await inspect(f);
  assert.equal(earlier.predecessorReference, null);
  assert.equal(later.predecessorReference, earlier.reference);
  assert.equal(earlier.sha256, later.sha256);
  assert.equal(earlier.newestObserved, false);
  assert.equal(later.newestObserved, true);
  assert.deepEqual(f.requests.map(q => q.method), ['list', 'list', 'list']);
  const result = await f.reader.select(earlier.reference);
  assert.equal(result.status, 'selected');
  assert.equal(result.selection.sha256, sha256(marker));
  assert.notEqual(result.selection.reference, earlier.reference);
  assert.deepEqual(f.requests.slice(3).map(q => [q.method, q.id]), [
    ['readMetadata', 'PrivateRoot'], ['readMetadata', first.id], ['readMarker', first.id],
  ]);
  assert.equal(f.requests.at(-1).maxBytes, 16384);
  const selection = f.reader.readSelection(result.selection.reference);
  assert.deepEqual(selection.markerBytes, marker);
  assert.deepEqual(selection.components, {
    data: {bytes: 8388608, sha256: manifestDigest}, preferences: {bytes: 131072, sha256: preferencesDigest},
  });
  selection.markerBytes[0] = 0;
  assert.deepEqual(f.reader.readSelection(result.selection.reference).markerBytes, marker);
  assert.doesNotMatch(JSON.stringify([earlier, later, result]), /PrivateRoot|PrivateFirst|PrivateSecond|grant|completeMedia|restoreEligible/);
  f.reader.dispose();
  assert.ok(selection.signal.aborted);
  assert.equal(f.reader.readSelection(result.selection.reference), null);
});

test('qualified empty is distinct from missing binding, stale authority, unreadable and incomplete', async () => {
  assert.deepEqual(await new IsolatedBackupReader().inspect(), {status: 'unqualified', backups: []});
  assert.deepEqual(await open({roots: []}).reader.inspect(), {status: 'empty', backups: []});
  const emptyRoot = await open({revisions: []}).reader.inspect();
  assert.deepEqual(emptyRoot, {status: 'empty', backups: [{backup, device, revisions: []}]});
  const expired = open();
  expired.expire();
  assert.deepEqual(await expired.reader.inspect(), {status: 'unavailable', backups: []});
  assert.equal(expired.requests.length, 0);
  const refused = open({list: () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); }});
  assert.deepEqual(await refused.reader.inspect(), {status: 'unavailable', backups: []});
  const incomplete = open({list: () => ({files: [root()], incompleteSearch: true})});
  assert.deepEqual(await incomplete.reader.inspect(), {status: 'incomplete', backups: []});
});

test('duplicate IDs, page tokens and corrupt predecessor graphs fail closed', async () => {
  const first = revision();
  for (const revisions of [
    [first, first],
    [revision('PrivateRoot')],
    [first, revision('AlternateChild')],
    [first, revision('Disconnected', 'Unreachable')],
    [revision('PrivateFirst', 'PrivateSecond'), revision('PrivateSecond', 'PrivateFirst')],
    [revision('PrivateFirst', 'PrivateFirst')],
  ]) {
    const f = open({revisions});
    assert.deepEqual(await f.reader.inspect(), {status: 'invalid', backups: []});
  }
  const repeats = open({list: () => ({files: [], nextPageToken: 'repeat', incompleteSearch: false})});
  assert.deepEqual(await repeats.reader.inspect(), {status: 'invalid', backups: []});
  assert.equal(repeats.requests.length, 2);
  const duplicateBackup = open({roots: [root(), root('SecondRoot')]});
  assert.deepEqual(await duplicateBackup.reader.inspect(), {status: 'invalid', backups: []});
});

test('requires canonical closed appData metadata, publisher properties and strict listing JSON', async () => {
  for (const change of [
    value => { value.id = '../root'; },
    value => { value.trashed = true; },
    value => { value.spaces = ['drive']; },
    value => { value.size = 0; },
    value => { value.appProperties.extra = 'unexpected'; },
    value => { value.appProperties.root = 'SubstitutedRoot'; },
    value => { value.appProperties.backup = backup.toUpperCase(); },
    value => { value.appProperties.device = '00000000-0000-0000-0000-000000000000'; },
    value => { value.appProperties.grant = 'A'.repeat(64); },
  ]) {
    const value = root();
    change(value);
    assert.equal((await open({roots: [value]}).reader.inspect()).status, 'invalid');
  }
  const f = open({list: () => Buffer.from('{"files":[],"files":[],"incompleteSearch":false}')});
  assert.equal((await f.reader.inspect()).status, 'invalid');
});

test('entry, call and raw metadata budgets apply to the entire scan', async () => {
  let listing = 0;
  const calls = open({list: () => ({files: [], nextPageToken: String(++listing), incompleteSearch: false})});
  assert.equal((await calls.reader.inspect()).status, 'incomplete');
  assert.equal(calls.requests.length, 128);

  const tooMany = open({list: () => ({files: Array(101).fill(root()), incompleteSearch: false})});
  assert.equal((await tooMany.reader.inspect()).status, 'incomplete');
  assert.equal(tooMany.requests[0].maxEntries, 100);

  const chain = Array.from({length: 4096}, (_, i) => revision('Revision_' + i, i ? 'Revision_' + (i - 1) : 'PrivateRoot'));
  const total = open({list: ({kind, pageToken}) => {
    if (kind === 'root') return {files: [root()], incompleteSearch: false};
    const offset = Number(pageToken ?? 0);
    const result = {files: chain.slice(offset, offset + 100), incompleteSearch: false};
    if (offset + 100 < chain.length) result.nextPageToken = String(offset + 100);
    return result;
  }});
  assert.deepEqual(await total.reader.inspect(), {status: 'incomplete', backups: []});

  const max = 8 * 1024 * 1024;
  const firstPage = json({files: [], nextPageToken: 'next', incompleteSearch: false});
  const padding = Buffer.alloc(max - firstPage.length - 64, ' ');
  const bytes = open({list: query => query.pageToken ? Buffer.alloc(65, ' ') : Buffer.concat([firstPage, padding])});
  assert.equal((await bytes.reader.inspect()).status, 'incomplete');
  assert.deepEqual(bytes.requests.map(q => q.maxBytes), [max, 64]);
});

test('selected root or marker substitution cannot download bytes or leave a usable view', async () => {
  for (const kind of ['root', 'marker']) {
    const f = open({metadata: query => {
      if (query.kind === 'root') {
        const file = root();
        if (kind === 'root') file.appProperties.grant = '1'.repeat(64);
        return file;
      }
      return revision('PrivateFirst', 'OtherPredecessor');
    }});
    const [choice] = await inspect(f);
    assert.deepEqual(await f.reader.select(choice.reference), {status: 'invalid', selection: null});
    assert.equal((await f.reader.select(choice.reference)).status, 'invalidated');
    assert.equal(f.requests.some(q => q.method === 'readMarker'), false);
  }
});

test('closed marker grammar and exact size/hash reject invalid, oversized and unsupported input', async () => {
  const text = marker.toString();
  const fixtures = [
    [Buffer.from(text.replace('"isolated_backup_version": 1', '"isolated_backup_version": 2')), 'unsupported'],
    [Buffer.from(text.replace('"isolated_backup_version": 1', '"isolated_backup_version": 1.0')), 'invalid'],
    [Buffer.from(text.replace('"bytes":8388608', '"bytes":8388608.00000000000001')), 'invalid'],
    [Buffer.from(text.replace('"bytes":131072', '"bytes":131073')), 'invalid'],
    [Buffer.from(text.replace('"bytes":8388608', '"bytes":8388609')), 'invalid'],
    [Buffer.from(text.replace('"bytes":8388608', '"bytes":0')), 'invalid'],
    [Buffer.from(text.replace('"bytes":131072', '"bytes":1e2')), 'invalid'],
    [Buffer.from(text.replace('"bytes":131072', '"bytes":10,"bytes":131072')), 'invalid'],
    [Buffer.from(text.replace('"data_backup"', '"extra":true,"data_backup"')), 'invalid'],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), marker]), 'invalid'],
    [Buffer.concat([Buffer.from([0xff]), marker]), 'invalid'],
  ];
  for (const [raw, status] of fixtures) {
    const f = open({revisions: [revision(undefined, undefined, raw)], raw});
    const [choice] = await inspect(f);
    assert.equal((await f.reader.select(choice.reference)).status, status, raw.toString());
  }
  const changed = Buffer.from(marker);
  changed[1] = 32;
  for (const raw of [changed, marker.subarray(1), Buffer.alloc(16385)]) {
    const f = open({raw});
    const [choice] = await inspect(f);
    assert.equal((await f.reader.select(choice.reference)).status, 'invalid');
  }
  const exact = Buffer.concat([marker, Buffer.alloc(16384 - marker.length, ' ')]);
  const f = open({revisions: [revision(undefined, undefined, exact)], raw: exact});
  const [choice] = await inspect(f);
  const selected = await f.reader.select(choice.reference);
  assert.equal(selected.status, 'selected');
  assert.deepEqual(f.reader.readSelection(selected.selection.reference).markerBytes, exact);
  f.reader.dispose();
});

test('authority changes during read, including rejected reads, invalidate the pending operation', async () => {
  for (const reject of [false, true]) {
    const f = open();
    const gate = deferred(), entered = deferred();
    const [choice] = await inspect(f);
    f.binding.readMarker = () => { entered.resolve(); return gate.promise; };
    const pending = f.reader.select(choice.reference);
    await entered.promise;
    f.expire();
    if (reject) gate.reject(Error('PRIVATE_GRANT_DETAIL')); else gate.resolve(marker);
    assert.deepEqual(await pending, {status: 'invalidated', selection: null});
  }
});

test('cancel and timeout abort the original binding even if its read never settles', async () => {
  for (const action of ['cancel', 'timeout']) {
    const f = open({timeoutMs: 10});
    let signal;
    f.binding.list = query => { signal = query.signal; return new Promise(() => {}); };
    const pending = f.reader.inspect();
    if (action === 'cancel') f.reader.cancel();
    assert.equal((await pending).status, action === 'cancel' ? 'invalidated' : 'incomplete');
    assert.equal(signal.aborted, true);
  }
});

test('one scan deadline crosses pages; fresh scan, authority loss and selection expiry release custody', async () => {
  let time = 0;
  const deadline = open({now: () => time, list: () => {
    time += 30000;
    return {files: [], nextPageToken: String(time), incompleteSearch: false};
  }});
  assert.equal((await deadline.reader.inspect()).status, 'incomplete');
  assert.equal(deadline.requests.length, 2);
  assert.deepEqual(deadline.requests.map(query => query.timeoutMs), [60000, 30000]);
  time = 0;
  const f = open({now: () => time});
  let [choice] = await inspect(f);
  const first = await f.reader.select(choice.reference);
  const original = f.reader.readSelection(first.selection.reference);
  time = 120000;
  assert.equal(f.reader.readSelection(first.selection.reference), null);
  assert.ok(original.signal.aborted);

  const second = await f.reader.select(choice.reference);
  const beforeRescan = f.reader.readSelection(second.selection.reference);
  const staleChoice = choice;
  [choice] = await inspect(f);
  assert.ok(beforeRescan.signal.aborted);
  assert.equal((await f.reader.select(staleChoice.reference)).status, 'invalidated');
  const third = await f.reader.select(choice.reference);
  const beforeExpiry = f.reader.readSelection(third.selection.reference);
  f.expire();
  assert.equal(f.reader.readSelection(third.selection.reference), null);
  assert.ok(beforeExpiry.signal.aborted);
});

test('a later revision does not advance a selected marker and a stale completion cannot replace it', async () => {
  const revisions = [revision()];
  const f = open({revisions});
  let [choice] = await inspect(f);
  revisions.push(revision('PrivateSecond', revisions[0].id));
  const starting = deferred(), response = deferred();
  const read = f.binding.readMarker;
  f.binding.readMarker = () => { starting.resolve(); return response.promise; };
  const stale = f.reader.select(choice.reference);
  await starting.promise;
  [choice] = await inspect(f);
  f.binding.readMarker = read;
  const current = await f.reader.select(choice.reference);
  assert.equal(current.status, 'selected');
  response.resolve(marker);
  assert.equal((await stale).status, 'invalidated');
  const pinned = f.reader.readSelection(current.selection.reference);
  assert.equal(pinned.marker.id, revisions[0].id);
  assert.equal(pinned.signal.aborted, false);
  f.reader.dispose();
});
