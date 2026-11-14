import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {IsolatedBackupController} from '../src/isolated-backup.ts';
import {IsolatedBackupHost} from '../host/isolated-backup-host.mjs';

const reference = n => n.toString(16).padStart(64, '0');
const json = value => Buffer.from(JSON.stringify(value));
const backup = 'db766c9e-d346-41fd-aad4-17d754fd50c7';
const device = '3696d8c3-8889-4b67-917d-ea52b54cefe1';
const descriptor = json({
  isolated_backup_version: 1, data_backup: {bytes: 11, sha256: reference(1)},
  portable_configuration: {bytes: 12, sha256: reference(2)},
});
const digest = createHash('sha256').update(descriptor).digest('hex');
const respond = (status, operation, backups = [], selection = null) => ({version: 1, status, operation, backups, selection});
const controls = (status, operation) => ({action: status, version: 1, operation});
const summaries = [{backup, device, revisions: [
  {reference: reference(3), predecessorReference: null, sha256: digest, newestObserved: true},
]}];
const deferred = () => Promise.withResolvers();

function open(t, adapter) {
  const controller = new IsolatedBackupController(adapter, () => {}, 1);
  t.after(() => controller.dispose());
  return controller;
}

async function waitFor(testFn) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (testFn()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Controller did not settle');
}

// Source-derived private-host fixture. No real provider or tablet.
function syntheticHost(t, operations = {}) {
  const file = (id, size, properties) => ({
    id, size: String(size), spaces: ['appDataFolder'], mimeType: 'application/octet-stream', trashed: false,
    appProperties: {backup, buddy_isolated: '1', root: 'PrivateRoot', ...properties},
  });
  const root = file('PrivateRoot', 0, {device, grant: reference(5), kind: 'root'});
  const marker = file('PrivateMarker', descriptor.byteLength, {kind: 'marker', predecessor: root.id, sha256: digest});
  const reads = {
    isCurrent: () => true,
    list: query => json({files: [query.kind === 'root' ? root : marker], incompleteSearch: false}),
    readMetadata: query => json(query.kind === 'root' ? root : marker),
    readMarker: () => descriptor,
  };
  const host = new IsolatedBackupHost({
    driveAuth: {openBackupRead: signal => ({status: 'qualified', signal, binding: reads})},
    ...operations,
  });
  t.after(() => host.dispose());
  return {host, reads};
}

async function choose(c) {
  await c.scan();
  await waitFor(() => !c.state.busy);
  await c.select(c.state.backups[0].revisions[0].reference);
  await waitFor(() => !c.state.busy);
}

test('download preserves the revision and distinguishes verified omitted media from interrupted work', async t => {
  for (const outcome of ['omitted', 'incomplete', 'forged']) {
    const entered = deferred(), finished = deferred();
    t.after(() => finished.resolve({status: 'incomplete', inspection: null, cleanupPending: false}));
    const {host} = syntheticHost(t, {downloadSelection() { entered.resolve(); return finished.promise; }});
    const c = open(t, request => Promise.resolve(host.request(request)));
    await choose(c);
    const selected = c.state.selected;
    await c.download();
    await entered.promise;
    assert.equal(c.state.selected, selected);
    assert.equal(c.state.downloading, true);
    if (outcome !== 'incomplete') {
      finished.resolve({status: 'verified', cleanupPending: false, inspection: {
        markerSha256: outcome === 'forged' ? reference(10) : digest,
        manifests: 1, objects: 0, declaredSettings: 0, completeMedia: false,
      }});
    } else finished.resolve({status: 'incomplete', inspection: null, cleanupPending: true});
    await waitFor(() => !c.state.busy);
    if (outcome === 'omitted') {
      assert.equal(c.state.inspection.completeMedia, false);
      assert.match(c.state.message, /verified.*omitted/i);
    } else {
      assert.equal(c.state.inspection, null);
      assert.match(c.state.message, outcome === 'incomplete' ? /incomplete/i : /did not match/i);
      assert.equal(c.state.cleanupPending, outcome === 'incomplete');
    }
  }
});

test('can cancel the selected operation before download acknowledgement and ignores cleanup after a successor', async t => {
  const startReply = deferred(), download = deferred(), retirement = deferred();
  const requests = [];
  t.after(() => { download.resolve(); retirement.resolve(); });
  const {host} = syntheticHost(t, {downloadSelection: () => download.promise,
    releaseSelection: () => retirement.promise});
  const c = open(t, async request => {
    requests.push(request);
    const response = host.request(request);
    if (request.action === 'download') await startReply.promise;
    return response;
  });
  await choose(c);
  const pending = c.download();
  const original = requests.find(q => q.action === 'download');
  assert.equal(c.state.busy, true);
  c.cancel();
  assert.equal(requests.at(-1).action, 'cancel');
  assert.equal(requests.at(-1).operation, original.operation);
  assert.equal(c.state.busy, false);
  assert.equal(c.state.selected, null);
  startReply.resolve();
  await pending;
  await c.scan();
  await waitFor(() => !c.state.busy);
  const successor = c.state.message;
  download.resolve({status: 'invalidated', inspection: null, cleanupPending: false});
  retirement.resolve({cleanupPending: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.cleanupPending, false);
  assert.equal(c.state.message, successor);
  assert.equal(requests.filter(q => q.action === 'download').length, 1);
});

test('an unconfirmed download cancel warns only in the original visible view', {timeout: 5000}, async t => {
  for (const mode of ['timeout', 'malformed', 'legacy', 'successor', 'navigation', 'disposed', 'joined-clean']) {
    await t.test(mode, async t => {
      const download = deferred(), retirement = deferred(), releaseStarted = deferred(), transport = deferred();
      t.after(() => { download.resolve(); retirement.resolve(); });
      const {host} = syntheticHost(t, {
        downloadSelection: () => download.promise,
        releaseSelection() { releaseStarted.resolve(); return retirement.promise; },
      });
      let hostCancel, owner;
      const c = open(t, request => {
        const response = host.request(request);
        if (request.action === 'download') owner = request.operation;
        if (request.action !== 'cancel' || request.operation !== owner) return Promise.resolve(response);
        hostCancel = response;
        return transport.promise;
      });
      await choose(c);
      await c.download();
      assert.ok(owner);
      c.cancel();
      await releaseStarted.promise;
      let retired = false;
      void hostCancel.then(() => { retired = true; });
      if (mode === 'successor') {
        await c.scan();
        await waitFor(() => !c.state.busy);
      } else if (mode === 'navigation') c.clear();
      else if (mode === 'disposed') c.dispose();
      if (mode === 'joined-clean') {
        download.resolve({status: 'invalidated', inspection: null, cleanupPending: false});
        retirement.resolve({cleanupPending: false});
        transport.resolve(await hostCancel);
      } else if (mode === 'malformed') transport.resolve({version: 1, operation: owner, status: 'invalidated'});
      else if (mode === 'legacy') transport.resolve(respond('invalidated', owner));
      else transport.reject(new DOMException('Synthetic transport deadline', 'TimeoutError'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(c.state.cleanupPending, ['timeout', 'malformed', 'legacy'].includes(mode));
      assert.equal(retired, mode === 'joined-clean');
      download.resolve({status: 'invalidated', inspection: null, cleanupPending: false});
      retirement.resolve({cleanupPending: false});
      await hostCancel;
    });
  }
});

test('real host returns one scan and exact marker selection; keeps scan context while selecting', async t => {
  const {host, reads} = syntheticHost(t);
  const requests = [];
  const c = open(t, async request => { requests.push(request); return host.request(request); });
  await c.scan();
  await waitFor(() => !c.state.busy);
  const [row] = c.state.backups;
  assert.equal(row.backup, backup);
  const ready = deferred(), bytes = deferred();
  reads.readMarker = () => { ready.resolve(); return bytes.promise; };
  const selection = c.select(row.revisions[0].reference);
  await ready.promise;
  assert.equal(c.state.busy, true);
  assert.equal(c.state.backups[0], row);
  bytes.resolve(descriptor);
  await selection;
  await waitFor(() => !c.state.busy);
  assert.equal(c.state.selected.sha256, digest);
  assert.equal(c.state.selectedChoice, row.revisions[0].reference);
  const select = requests.find(q => q.action === 'select');
  assert.equal(select.inspection, requests.find(q => q.action === 'status').operation);
  assert.equal(select.choice, row.revisions[0].reference);
  assert.doesNotMatch(JSON.stringify(c.state), /PrivateRoot|PrivateMarker|markerBytes|grant/);
});

test('different backup, device or digest in a valid result cannot establish selection', async t => {
  for (const changed of [
    {backup: 'dd766c9e-d346-41fd-aad4-17d754fd50c7'},
    {device: 'dd766c9e-d346-41fd-aad4-17d754fd50c7'},
    {sha256: reference(45)},
  ]) {
    const requests = [];
    const c = open(t, async q => {
      requests.push(q);
      if (q.action === 'scan') return respond('observed', reference(4), summaries);
      if (q.action === 'select') return respond('selecting', reference(5));
      if (q.action === 'status') return respond('selected', reference(5), [],
        {backup, device, sha256: digest, reference: reference(6), ...changed});
      return respond('invalidated', q.operation);
    });
    await c.scan();
    await c.select(reference(3));
    await waitFor(() => !c.state.busy);
    assert.equal(c.state.selected, null);
    assert.deepEqual(c.state.backups, []);
    assert.deepEqual(requests.at(-1), controls('cancel', reference(5)));
  }
});

test('cancel before a start reply only cancels its late original operation', async t => {
  const requests = [], oldReply = deferred();
  let scans = 0;
  const c = open(t, async request => {
    requests.push(request);
    if (request.action === 'scan') return ++scans === 1 ? oldReply.promise : respond('observed', reference(7), summaries);
    return respond('invalidated', request.operation);
  });
  const first = c.scan();
  c.clear();
  await c.scan();
  assert.equal(c.state.backups.length, 1);
  oldReply.resolve(respond('scanning', reference(6)));
  await first;
  assert.equal(c.state.backups.length, 1);
  assert.deepEqual(requests.filter(q => q.action === 'cancel'), [controls('cancel', reference(6))]);
  assert.equal(requests.some(q => q.action === 'status'), false);
});

test('clearing a pending selection poll rejects late success and explicitly cancels it', async t => {
  const requests = [], entered = deferred(), oldReply = deferred();
  const c = open(t, async request => {
    requests.push(request);
    if (request.action === 'scan') return respond('observed', reference(4), summaries);
    if (request.action === 'select') return respond('selecting', reference(5));
    if (request.action === 'status') { entered.resolve(); return oldReply.promise; }
    return respond('invalidated', request.operation);
  });
  await c.scan();
  await c.select(reference(3));
  await entered.promise;
  c.clear();
  await c.scan();
  oldReply.resolve(respond('selected', reference(5), [], {backup, device, sha256: digest, reference: reference(6)}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.selected, null);
  assert.equal(c.state.backups.length, 1);
  assert.deepEqual(requests.filter(q => q.action === 'cancel'), [controls('cancel', reference(5))]);
});

test('lost polling response stops waiting and no operation is retried', async t => {
  const requests = [];
  const c = open(t, async request => {
    requests.push(request);
    if (request.action === 'scan') return respond('scanning', reference(4));
    if (request.action === 'status') throw Error('synthetic lost response');
    return respond('invalidated', request.operation);
  });
  await c.scan();
  await waitFor(() => !c.state.busy);
  assert.match(c.state.message, /lost the reply/);
  assert.deepEqual(requests.map(q => q.action), ['scan', 'status', 'cancel']);
});

test('refusal, qualified empty, unavailable, invalid and incomplete use distinct text', async t => {
  const messages = [];
  for (const status of ['empty', 'unqualified', 'unavailable', 'incomplete', 'invalid', 'invalidated']) {
    const c = open(t, async request => request.action === 'scan' ? respond(status, reference(4)) : respond('invalidated', request.operation));
    await c.scan();
    assert.equal(c.state.backups.length, 0);
    assert.equal(c.state.selected, null);
    assert.equal(c.state.busy, false);
    messages.push(c.state.message);
  }
  assert.equal(new Set(messages).size, messages.length);
});

test('selection expiry clears the view and exact original custody', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const events = [];
  const c = open(t, async request => {
    events.push(request);
    if (request.action === 'scan') return respond('observed', reference(4), summaries);
    if (request.action === 'select') return respond('selected', reference(5), [], {backup, device, sha256: digest, reference: reference(6)});
    return respond('invalidated', request.operation);
  });
  await c.scan();
  await c.select(reference(3));
  assert.ok(c.state.selected);
  t.mock.timers.tick(120000);
  await Promise.resolve();
  assert.equal(c.state.selected, null);
  assert.match(c.state.message, /selection expired/);
  assert.deepEqual(events.at(-1), controls('cancel', reference(5)));
});

test('download uses the original remaining selection window and keeps a current cleanup warning', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const events = [];
  const start = deferred();
  const c = open(t, async request => {
    events.push(request);
    if (request.action === 'scan') return respond('observed', reference(4), summaries);
    if (request.action === 'select') return respond('selected', reference(5), [], {backup, device, sha256: digest, reference: reference(6)});
    if (request.action === 'download') return start.promise;
    return {version: 1, operation: request.operation, status: 'invalidated', inspection: null, cleanupPending: true};
  });
  await c.scan();
  await c.select(reference(3));
  t.mock.timers.tick(119000);
  const pending = c.download();
  assert.equal(c.state.downloading, true);
  t.mock.timers.tick(1000);
  assert.equal(c.state.selected, null);
  assert.equal(c.state.busy, false);
  assert.deepEqual(events.at(-1), controls('cancel', reference(5)));
  start.resolve({version: 1, operation: reference(5), status: 'downloading', inspection: null, cleanupPending: false});
  await pending;
  assert.equal(c.state.cleanupPending, true);
  assert.equal(events.filter(event => event.action === 'cancel').length, 1);
});
