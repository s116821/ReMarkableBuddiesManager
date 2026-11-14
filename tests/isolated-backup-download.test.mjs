import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import {IsolatedBackupDownload} from '../host/isolated-backup-download.mjs';

// Source-derived synthetic frames and memory staging. Neither filesystem
// privacy nor actual Buddy executable verification follows from this fixture.
const MiB = 1024 * 1024;
const FREE = 1024 * MiB;
const root = {id: 'PrivateRoot', backup: 'db766c9e-d346-41fd-aad4-17d754fd50c7'};
const operation = 'a'.repeat(64), reference = 'b'.repeat(64);
const stageRoot = path.resolve('synthetic-stage-does-not-exist');
const dataName = 'data/backup.json', preferencesName = 'portable-configuration.json', markerName = 'isolated-backup.json';
const json = value => Buffer.from(JSON.stringify(value));
const objectRef = value => ({bytes: value.length, sha256: createHash('sha256').update(value).digest('hex')});
const deferred = () => Promise.withResolvers();

function fixture({
  objects = [Buffer.alloc(0), Buffer.from('synthetic-object')],
  manifestChange = () => {}, wireManifest = json, mockBytes = [], free = () => FREE,
  completeMedia = false,
} = {}) {
  const source = objects.map(bytes => ({bytes, ref: objectRef(bytes)}));
  const manifest = {format: 1, manifests: [{}], objects: mockBytes.length ? mockBytes : source.map(item => item.ref),
    complete_media: completeMedia, config_snapshot: null};
  manifestChange(manifest);
  const prefs = Buffer.from('{"portable_configuration_version":1,"settings":{}}');
  const data = wireManifest(manifest);
  const components = {data: objectRef(data), preferences: objectRef(prefs)};
  const markerBytes = json({isolated_backup_version: 1, data_backup: components.data, portable_configuration: components.preferences});
  source.push({bytes: data, ref: components.data}, {bytes: prefs, ref: components.preferences});
  const metadata = source.map(({ref}, i) => ({id: 'PrivateObject' + i, size: String(ref.bytes),
    spaces: ['appDataFolder'], mimeType: 'application/octet-stream', trashed: false,
    appProperties: {buddy_isolated: '1', kind: 'object', root: root.id, backup: root.backup, sha256: ref.sha256}}));
  const controller = new AbortController();
  const selection = {root, marker: {id: 'PrivateMarker', ...objectRef(markerBytes)}, components, markerBytes, signal: controller.signal};
  let current = true, now = 0;
  const calls = [], events = [], staged = new Map();
  const binding = {
    isCurrent: () => current,
    async checkCurrent() { if (!current) throw new Error('Original authority changed'); },
    async listObject(q) {
      calls.push(['list', q]);
      return json({files: metadata.filter(item => item.appProperties.sha256 === q.sha256), incompleteSearch: false});
    },
    async readObjectMetadata(q) {
      calls.push(['metadata', q]);
      return json(metadata.find(item => item.id === q.id));
    },
    async *streamObject(q) {
      calls.push(['stream', q]);
      const bytes = source[Number(q.id.slice('PrivateObject'.length))].bytes;
      if (bytes.length) yield bytes;
    },
  };
  const stage = {
    root: stageRoot,
    async openExclusive(name, bounds) {
      assert.equal(bounds.signal.aborted, false);
      assert.ok(!staged.has(name));
      const chunks = [];
      staged.set(name, chunks);
      events.push('open:' + name);
      return {
        write: async value => { chunks.push(Buffer.from(value)); },
        sync: async () => { events.push('sync:' + name); },
        close: async () => { events.push('close:' + name); },
      };
    },
    async assertOwned(names) {
      events.push('assertOwned');
      return names.join() === [...staged.keys()].join();
    },
    async release() { events.push('release'); staged.clear(); },
  };
  const staging = {
    available: async () => true,
    async freeBytes(target) { events.push('space'); return free(target, events); },
    async create() { events.push('create'); return stage; },
  };
  const report = {report_version: 1, operation: 'inspect-isolated', status: 'ok', incomplete: !completeMedia,
    activation_performed: false, data: {isolated_package: {
      marker_sha256: selection.marker.sha256, data_backup: components.data, portable_configuration: components.preferences,
      declared_settings: 0, data: {format: 1, manifests: 1, objects: source.length - 2,
        selected_scopes: 0, selection_receipts: 0, complete_media: completeMedia, configuration_included: false},
    }}};
  const verifier = {
    available: async () => true,
    async verify(bounds) {
      events.push('verify');
      assert.equal(bounds.root, stageRoot);
      assert.equal(bounds.markerSha256, selection.marker.sha256);
      assert.equal(bounds.maxBytes, 16384);
      assert.deepEqual(Buffer.concat(staged.get(markerName)), markerBytes);
      return Buffer.from(JSON.stringify(report) + '\n');
    },
  };
  const worker = new IsolatedBackupDownload({staging, verifier, now: () => now});
  const args = {operation, reference, selection, current: () => current, binding};
  return {args, worker, calls, events, staged, staging, stage, verifier, report, controller,
    expire() { controller.abort(); }, change() { current = false; }, advance(ms) { now += ms; },
    read: name => Buffer.concat(staged.get(name)), run: () => worker.download(args)};
}

test('complete exact staging, zero-byte object, marker last and one private handoff', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'verified');
  assert.equal(result.inspection.completeMedia, false);
  assert.equal(result.inspection.objects, 2);
  assert.doesNotMatch(JSON.stringify(result), /Private|synthetic-stage|portable_configuration/);
  assert.deepEqual([ ...f.staged.keys() ].map(name => name.startsWith('data/objects/') ? 'object' : name),
    [dataName, 'object', 'object', preferencesName, markerName]);
  assert.equal(f.read('data/objects/' + objectRef(Buffer.alloc(0)).sha256).length, 0);
  assert.equal(await f.worker.handoff('0'.repeat(64), reference, () => {}).then(value => value.status), 'invalidated');
  assert.equal(f.staged.size, 5);
  const output = await f.worker.handoff(operation, reference, async value => {
    assert.equal(value.root, stageRoot);
    assert.equal(value.signal.aborted, false);
    assert.deepEqual(f.read(markerName), f.args.selection.markerBytes);
  });
  assert.equal(output.status, 'handed-off');
  assert.equal(f.events.at(-1), 'release');
  assert.equal(f.staged.size, 0);
  assert.equal((await f.worker.handoff(operation, reference, () => assert.fail())).status, 'invalidated');
});

test('unavailable stage, verifier, or disk refuses before any binding call', async () => {
  const absent = new IsolatedBackupDownload();
  assert.equal((await absent.download({})).status, 'unavailable');
  for (const unavailable of ['staging', 'verifier']) {
    const f = fixture();
    f[unavailable].available = async () => false;
    assert.equal((await f.run()).status, 'unavailable');
    assert.deepEqual(f.calls, []);
    assert.equal(f.events.includes('create'), false);
  }
  for (const free of [null, 256 * MiB]) {
    const f = fixture({free: () => free});
    assert.equal((await f.run()).status, 'insufficient-space');
    assert.equal(f.events.includes('create'), false);
    assert.deepEqual(f.calls, []);
  }
});

test('unknown create rollback remains a cleanup warning without a stage or cleanup retry', async () => {
  const f = fixture();
  let attempts = 0;
  f.staging.create = async () => {
    attempts++;
    throw Object.assign(new Error('Private staging unavailable'), {cleanupPending: true});
  };
  const result = await f.run();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.cleanupPending, true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.includes('release'), false);
  assert.equal((await f.worker.release(operation, reference)).cleanupPending, true);
  assert.equal((await f.worker.dispose()).cleanupPending, true);
  assert.equal(attempts, 1);
});

test('asynchronous original authority refusal occurs before staging or provider admission', async () => {
  const f = fixture();
  f.args.binding.checkCurrent = async () => { throw new Error('Original authority unavailable'); };
  assert.equal((await f.run()).status, 'unavailable');
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.includes('create'), false);
  assert.equal(f.events.includes('verify'), false);
});

test('external authority changes during local readiness or verification cannot yield a verified stage', async () => {
  for (const phase of ['readiness', 'create', 'before-verifier', 'verifier', 'membership']) {
    const f = fixture();
    let original = true, membership = 0;
    f.args.binding.checkCurrent = async () => { if (!original) throw Error('Protected records changed'); };
    if (phase === 'readiness') f.verifier.available = async () => { original = false; return true; };
    if (phase === 'create') {
      const create = f.staging.create;
      f.staging.create = async (...args) => { const stage = await create(...args); original = false; return stage; };
    }
    if (phase === 'verifier') {
      const verify = f.verifier.verify;
      f.verifier.verify = async (...args) => { const result = await verify(...args); original = false; return result; };
    }
    if (phase === 'before-verifier' || phase === 'membership') {
      const assertOwned = f.stage.assertOwned;
      f.stage.assertOwned = async (...args) => {
        const owned = await assertOwned(...args);
        if (++membership === (phase === 'before-verifier' ? 1 : 2)) original = false;
        return owned;
      };
    }
    const result = await f.run();
    assert.notEqual(result.status, 'verified', phase);
    assert.equal(result.inspection, null, phase);
    assert.equal((await f.worker.handoff(operation, reference, () => assert.fail())).status, 'invalidated');
    if (phase === 'readiness') assert.equal(f.events.includes('create'), false);
    else assert.equal(f.events.at(-1), 'release');
    if (phase === 'before-verifier') assert.equal(f.events.includes('verify'), false);
  }
});

test('handoff checks protected authority before and after the joined recipient', async () => {
  for (const phase of ['before', 'membership', 'during']) {
    const f = fixture();
    let original = true, consumed = 0;
    f.args.binding.checkCurrent = async () => { if (!original) throw Error('Protected records changed'); };
    assert.equal((await f.run()).status, 'verified');
    if (phase === 'before') original = false;
    if (phase === 'membership') f.stage.assertOwned = async () => { original = false; return true; };
    const result = await f.worker.handoff(operation, reference, async () => {
      consumed++;
      original = false;
    });
    assert.notEqual(result.status, 'handed-off', phase);
    assert.equal(consumed, phase === 'during' ? 1 : 0, phase);
    assert.equal(f.events.at(-1), 'release');
    assert.equal((await f.worker.handoff(operation, reference, () => assert.fail())).status, 'invalidated');
  }
});

test('closed ordinary inventory and aggregate/disk refusal precede content downloads', async () => {
  for (const manifestChange of [
    value => { value.format = 2; },
    value => { value.feedback_history = null; },
    value => { value.selected_history = {}; },
    value => { value.config_snapshot = {}; },
    value => { value.objects.push(value.objects[0]); },
    value => { value.objects[0].bytes = 256 * MiB + 1; },
    value => { value.objects = Array(4097).fill(value.objects[0]); },
  ]) {
    const f = fixture({manifestChange});
    assert.equal((await f.run()).status, 'invalid');
    assert.equal(f.calls.filter(([method]) => method === 'stream').length, 1);
    assert.equal(f.events.includes('verify'), false);
  }
  const large = fixture({mockBytes: [1, 2, 3].map(n => ({bytes: 200 * MiB, sha256: String(n).repeat(64)}))});
  assert.equal((await large.run()).status, 'incomplete');
  assert.equal(large.calls.filter(([method]) => method === 'stream').length, 1);
  const disk = fixture({free: target => target ? 256 * MiB : FREE});
  assert.equal((await disk.run()).status, 'insufficient-space');
  assert.equal(disk.calls.filter(([method]) => method === 'stream').length, 1);
});

test('inventory rejects decimal version and lengths even when JSON.parse rounds them to integers', async () => {
  for (const [before, after] of [['"format":1', '"format":1.0'], ['"bytes":0', '"bytes":0e0'],
    ['"bytes":16', '"bytes":16.0000000000000001']]) {
    const f = fixture({wireManifest: manifest => {
      const raw = json(manifest).toString();
      assert.ok(raw.includes(before));
      return Buffer.from(raw.replace(before, after));
    }});
    assert.equal((await f.run()).status, 'invalid');
    assert.equal(f.calls.filter(([method]) => method === 'stream').length, 1);
  }
});

test('object lookup completes pagination and refuses duplicate, incomplete and substituted metadata', async () => {
  for (const outcome of ['healthy', 'duplicate', 'incomplete', 'repeated-token', 'wrong-id', 'wrong-size']) {
    const f = fixture();
    const list = f.args.binding.listObject, meta = f.args.binding.readObjectMetadata;
    f.args.binding.listObject = async query => {
      const page = JSON.parse(await list(query));
      if (outcome === 'duplicate') page.files.push(page.files[0]);
      if (outcome === 'incomplete') page.incompleteSearch = true;
      if (outcome === 'repeated-token') return json({...page, files: [], nextPageToken: 'repeat'});
      if (outcome === 'healthy' && !query.pageToken) return json({...page, files: [], nextPageToken: 'page-2'});
      return json(page);
    };
    f.args.binding.readObjectMetadata = async q => {
      const value = JSON.parse(await meta(q));
      if (outcome === 'wrong-id') value.id = 'Replacement';
      if (outcome === 'wrong-size') value.size = '0';
      return json(value);
    };
    const result = await f.run();
    assert.equal(result.status, outcome === 'healthy' ? 'verified' : outcome === 'incomplete' ? 'incomplete' : 'invalid');
    if (outcome === 'healthy') await f.worker.dispose();
    else assert.equal(f.calls.some(([method]) => method === 'stream'), false);
  }
});

test('metadata and call ceilings are shared across provider pagination', async () => {
  const bytes = fixture();
  const first = json({files: [], incompleteSearch: false, nextPageToken: 'next'});
  bytes.args.binding.listObject = async q => q.pageToken ? Buffer.alloc(4, ' ') :
    Buffer.concat([first, Buffer.alloc(q.maxBytes - first.length - 3, ' ')]);
  assert.equal((await bytes.run()).status, 'incomplete');
  const calls = fixture();
  let count = 0;
  calls.args.binding.listObject = async () => json({files: [], incompleteSearch: false, nextPageToken: String(++count)});
  assert.equal((await calls.run()).status, 'incomplete');
  assert.equal(count, 16384);
});

test('stream exact EOF, length and original hash are required', async () => {
  for (const scenario of ['short', 'long', 'corrupt', 'extra-after-exact']) {
    const f = fixture();
    f.args.binding.streamObject = async function* () {
      const expected = json({format: 1, manifests: [{}], objects: [objectRef(Buffer.alloc(0)), objectRef(Buffer.from('synthetic-object'))],
        complete_media: false, config_snapshot: null});
      if (scenario === 'short') yield expected.subarray(1);
      if (scenario === 'long') yield Buffer.concat([expected, Buffer.from('!')]);
      if (scenario === 'corrupt') yield Buffer.alloc(expected.length, 'x');
      if (scenario === 'extra-after-exact') { yield expected; yield Buffer.from('!'); }
    };
    assert.equal((await f.run()).status, 'invalid', scenario);
    assert.equal(f.events.includes('verify'), false);
    assert.equal(f.events.at(-1), 'release');
  }
});

test('bad chunk aborts the producer before joining iterator teardown', async () => {
  const f = fixture();
  f.args.binding.streamObject = async function* ({signal}) {
    try { yield Buffer.alloc(65537); }
    finally {
      assert.equal(signal.aborted, true);
      f.events.push('stream-joined');
    }
  };
  assert.equal((await f.run()).status, 'invalid');
  assert.ok(f.events.indexOf('stream-joined') < f.events.indexOf('release'));
  assert.ok(f.events.includes('stream-joined'));
});

test('selection expiry/authority changes stop current read and cleanup follows join', async () => {
  for (const action of ['expire', 'change', 'deadline']) {
    const f = fixture();
    const started = deferred(), next = deferred();
    f.args.binding.streamObject = async function* ({signal}) {
      try {
        started.resolve(signal);
        await next.promise;
        yield Buffer.from('synthetic late bytes');
      } finally { f.events.push('joined'); }
    };
    const pending = f.run();
    const signal = await started.promise;
    if (action === 'deadline') f.advance(120000); else f[action]();
    if (action === 'expire') assert.equal(signal.aborted, true);
    assert.equal(f.events.includes('release'), false);
    next.resolve();
    assert.equal((await pending).status, action === 'deadline' ? 'incomplete' : 'invalidated');
    assert.ok(f.events.indexOf('joined') < f.events.indexOf('release'));
  }
});

test('verifier refusal, stale report and unsafe cleanup never yield a usable stage', async () => {
  for (const action of ['failure', 'mismatch', 'invalid-report', 'identity-replaced']) {
    const f = fixture();
    if (action === 'failure') f.verifier.verify = async () => { throw Error('private child detail'); };
    if (action === 'mismatch') f.report.data.isolated_package.marker_sha256 = 'c'.repeat(64);
    if (action === 'invalid-report') f.verifier.verify = async () => Buffer.from('broken\n');
    if (action === 'identity-replaced') {
      f.stage.assertOwned = async () => false;
      f.stage.release = async () => { throw Error('replacement preserved'); };
    }
    const result = await f.run();
    assert.equal(result.status === 'verified', false);
    assert.equal(result.cleanupPending, action === 'identity-replaced');
    assert.equal((await f.worker.handoff(operation, reference, () => assert.fail())).status, 'invalidated');
    assert.doesNotMatch(JSON.stringify(result), /private child|replacement preserved/);
  }
});

test('cancel joins a pending verifier and preserves replacement residue', async () => {
  const f = fixture();
  const started = deferred(), verifierExit = deferred();
  f.verifier.verify = async bounds => {
    started.resolve(bounds.signal);
    await verifierExit.promise;
    f.events.push('verifier-joined');
    return Buffer.from(JSON.stringify(f.report) + '\n');
  };
  const pending = f.run();
  const signal = await started.promise;
  f.stage.release = async () => {
    assert.equal(f.events.at(-1), 'verifier-joined');
    throw Error('stage replaced');
  };
  const release = f.worker.release(operation, reference);
  assert.equal(signal.aborted, true);
  verifierExit.resolve();
  const result = await pending;
  assert.deepEqual(result, {status: 'invalidated', inspection: null, cleanupPending: true});
  assert.equal((await release).cleanupPending, true);
});

test('disposal aborts and joins the host-only handoff before releasing staging', async () => {
  const f = fixture({completeMedia: true});
  assert.equal((await f.run()).inspection.completeMedia, true);
  const entered = deferred(), receiverExit = deferred();
  const transfer = f.worker.handoff(operation, reference, async value => {
    entered.resolve(value.signal);
    await receiverExit.promise;
    assert.equal(f.staged.size, 5);
    f.events.push('receiver-joined');
  });
  const signal = await entered.promise;
  const dispose = f.worker.dispose();
  assert.ok(signal.aborted);
  receiverExit.resolve();
  assert.equal((await transfer).status, 'invalidated');
  await dispose;
  assert.deepEqual(f.events.slice(-2), ['receiver-joined', 'release']);
});
