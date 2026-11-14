import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {DriveAuth, DRIVE_SCOPE} from '../host/drive-auth.mjs';
import {IsolatedBackupHost} from '../host/isolated-backup-host.mjs';
import {
  ISOLATED_BACKUP_REQUEST_BYTES, ISOLATED_BACKUP_RESPONSE_BYTES,
  parseIsolatedBackupJson, parseIsolatedBackupRequest, parseIsolatedBackupResult,
} from '../host/isolated-backup-protocol.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const backup = 'db766c9e-d346-41fd-aad4-17d754fd50c7';
const device = '3696d8c3-8889-4b67-917d-ea52b54cefe1';
const markerBytes = json({isolated_backup_version: 1, data_backup: {bytes: 20, sha256: 'a'.repeat(64)},
  portable_configuration: {bytes: 10, sha256: 'b'.repeat(64)}});
function file(id, size, properties) {
  return {id, size: String(size), spaces: ['appDataFolder'], mimeType: 'application/octet-stream', trashed: false,
    appProperties: {buddy_isolated: '1', root: 'PrivateRoot', backup, ...properties}};
}
const root = file('PrivateRoot', 0, {kind: 'root', device, grant: 'c'.repeat(64)});
const marker = file('PrivateMarker', markerBytes.length,
  {kind: 'marker', predecessor: root.id, sha256: sha(markerBytes)});
const scan = {version: 1, action: 'scan'};
const status = operation => ({version: 1, action: 'status', operation});
const cancel = operation => ({version: 1, action: 'cancel', operation});
const select = (inspection, choice) => ({version: 1, action: 'select', inspection, choice});
const deferred = () => Promise.withResolvers();

function fixture(t, {qualified = true, bindingPresent = true, tokenLifetime = 900000} = {}) {
  let config = {schema: 1, type: 'google-desktop', clientId: '123456789012-fixture.apps.googleusercontent.com', clientSecret: 'private-client'};
  let grant = {schema: 1, clientId: config.clientId, account: {permissionId: 'private-account', label: 'fixture@example.invalid'},
    checkedAt: Date.now(), tokens: {access_token: 'private-access', refresh_token: 'private-refresh', expiry_date: Date.now() + 900000,
      scope: DRIVE_SCOPE, token_type: 'Bearer'}};
  const record = value => ({value: structuredClone(value), digest: value ? sha(json(value)) : null});
  const writes = [], provider = [], factories = [];
  const reads = {
    list: q => json({files: [q.kind === 'root' ? root : marker], incompleteSearch: false}),
    readMetadata: q => json(q.kind === 'root' ? root : marker),
    readMarker: () => markerBytes,
  };
  const store = {
    client: () => record(config),
    grant: () => record(grant),
    save(value, clientDigest, grantDigest) {
      assert.equal(clientDigest, record(config).digest);
      assert.equal(grantDigest, record(grant).digest);
      writes.push('save');
      grant = structuredClone(value);
      return {committed: true, digest: record(grant).digest};
    },
    disconnect(clientDigest, grantDigest) {
      assert.equal(clientDigest, record(config).digest);
      assert.equal(grantDigest, record(grant).digest);
      writes.push('disconnect');
      grant = null;
    },
  };
  const auth = new DriveAuth({store, backupReadFactory: bindingPresent ? capture => {
    factories.push(capture);
    if (!qualified) return null;
    return reads;
  } : null});
  auth.oauth = () => ({
    setCredentials() {},
    refreshAccessToken() { throw Error('Unexpected refresh'); },
    async revokeToken() { provider.push('revoke'); },
    async generateCodeVerifierAsync() { throw Error('Synthetic login disallowed'); },
  });
  auth.account = async () => {
    provider.push('account');
    return {account: structuredClone(grant.account),
      tokens: {...grant.tokens, expiry_date: Date.now() + tokenLifetime}};
  };
  const host = new IsolatedBackupHost({driveAuth: auth});
  t.after(() => Promise.all([host.dispose(), auth.dispose()]));
  return {
    auth, host, writes, provider, factories, reads, store,
    replaceClient() { config = {...config, clientSecret: 'replacement'}; },
    replaceGrant() { grant = {...grant, account: {...grant.account, permissionId: 'replacement'}}; },
  };
}

async function settle(host, operation) {
  for (let i = 0; i < 200; i++) {
    const state = host.request(status(operation));
    if (!['scanning', 'selecting'].includes(state.status)) return state;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Operation did not settle');
}

test('versioned protocol refuses private inputs and malformed reduced frames', () => {
  assert.equal(parseIsolatedBackupRequest(scan), scan);
  for (const input of [{action: 'scan'}, {...scan, authorizationId: 'a'.repeat(64)}, {'action,version': 1},
    {...scan, path: 'private'}, {version: 1, action: 'select', inspection: 'a'.repeat(64)}, status('PrivateMarker')]) {
    assert.throws(() => parseIsolatedBackupRequest(input), /frame refused/);
  }
  for (const bytes of [Buffer.alloc(513), Buffer.from('{"action":"scan","action":"scan","version":1}'), Buffer.from([255])]) {
    assert.throws(() => parseIsolatedBackupJson(bytes, ISOLATED_BACKUP_REQUEST_BYTES), /frame refused/);
  }
  assert.throws(() => parseIsolatedBackupJson(Buffer.alloc(ISOLATED_BACKUP_RESPONSE_BYTES + 1),
    ISOLATED_BACKUP_RESPONSE_BYTES), /frame refused/);
  const frame = {version: 1, status: 'selected', operation: 'a'.repeat(64), backups: [],
    selection: {backup, device, reference: 'b'.repeat(64), sha256: 'c'.repeat(64)}};
  assert.equal(parseIsolatedBackupResult(frame, status(frame.operation)), frame);
  assert.throws(() => parseIsolatedBackupResult(frame, status('f'.repeat(64))), /frame refused/);
  assert.throws(() => parseIsolatedBackupResult({...frame, selection: {...frame.selection, root: 'private'}}, scan), /frame refused/);
});

test('reserves asynchronous scan before I/O; selects only original inspection and hides protected custody', async t => {
  const f = fixture(t);
  assert.equal(f.auth.status().status, 'cached');
  assert.equal((await settle(f.host, f.host.request(scan).operation)).status, 'unavailable');
  assert.equal(f.factories.length, 0);
  await f.auth.check();
  const initial = f.host.request(scan);
  assert.equal(initial.status, 'scanning');
  assert.equal(f.factories.length, 0);
  assert.equal(f.host.request(scan).status, 'busy');
  const inspected = await settle(f.host, initial.operation);
  assert.equal(inspected.status, 'observed');
  const [choice] = inspected.backups[0].revisions;
  assert.equal(f.host.request(select('f'.repeat(64), choice.reference)).status, 'invalidated');
  assert.equal(f.host.request(select(initial.operation, 'f'.repeat(64))).status, 'invalidated');
  inspected.backups[0].revisions.length = 0;
  const selected = await settle(f.host, f.host.request(select(initial.operation, choice.reference)).operation);
  assert.equal(selected.status, 'selected');
  assert.equal(selected.selection.sha256, sha(markerBytes));
  assert.equal(f.factories[0].grant.tokens.access_token, 'private-access');
  assert.deepEqual(f.host.readSelection(selected.operation, selected.selection.reference).markerBytes, markerBytes);
  assert.match(f.factories[0].clientDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify([initial, inspected, selected]), /PrivateRoot|PrivateMarker|private-|appProperties|markerBytes|grantDigest/);
  assert.equal(f.auth.status().backupReady, false);
  assert.deepEqual(f.provider, ['account']);
  assert.deepEqual(f.writes, ['save']);
});

test('absent and declining read factories leave even freshly connected accounts unqualified', async t => {
  for (const options of [{bindingPresent: false}, {qualified: false}]) {
    const f = fixture(t, options);
    await f.auth.check();
    assert.equal(f.auth.status().status, 'connected');
    const result = await settle(f.host, f.host.request(scan).operation);
    assert.equal(result.status, 'unqualified');
    assert.deepEqual(result.backups, []);
    assert.deepEqual(f.provider, ['account']);
  }
});

test('disposal joins both a cancelled inspection and its successor', async t => {
  const f = fixture(t);
  await f.auth.check();
  const reads = [deferred(), deferred()], entered = [deferred(), deferred()];
  t.after(() => reads.forEach(value => value.resolve()));
  let index = 0;
  f.reads.list = ({signal}) => {
    const next = index++;
    entered[next].resolve(signal);
    return reads[next].promise;
  };
  const first = f.host.request(scan);
  const original = await entered[0].promise;
  f.host.request(cancel(first.operation));
  const second = f.host.request(scan);
  assert.notEqual(second.operation, first.operation);
  const successor = await entered[1].promise;
  assert.equal(original.aborted, true);
  assert.equal(successor.aborted, false);

  let disposed = false;
  const closed = f.host.dispose();
  assert.equal(f.host.dispose(), closed);
  assert.equal(f.host.request(scan).status, 'invalidated');
  assert.equal(successor.aborted, true);
  void closed.then(() => { disposed = true; });
  reads[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  reads[0].resolve();
  await closed;
  assert.equal(disposed, true);
});

test('Drive disposal joins idle guard opens and closes across captures', async t => {
  const f = fixture(t);
  const opened = Promise.withResolvers(), firstClose = Promise.withResolvers(), lastClose = Promise.withResolvers();
  const firstJoined = Promise.withResolvers(), lastJoined = Promise.withResolvers();
  function guard(entered, closed) {
    return {signal: new AbortController().signal, close() { entered.resolve(); return closed.promise; }};
  }
  const first = guard(firstJoined, firstClose);
  const last = guard(lastJoined, lastClose);
  t.after(() => { opened.resolve(last); firstClose.resolve(); lastClose.resolve(); });
  let captures = 0;
  f.store.openReadGuard = () => captures++ === 0 ? Promise.resolve(first) : opened.promise;
  await f.auth.check();
  const firstLifetime = new AbortController();
  const old = f.auth.openBackupRead(firstLifetime.signal);
  firstLifetime.abort();
  await firstJoined.promise;
  const current = f.auth.openBackupRead(new AbortController().signal);
  assert.equal(old.status, 'qualified');
  assert.equal(current.status, 'qualified');
  const closed = f.auth.dispose();
  assert.equal(f.auth.dispose(), closed);
  assert.equal(current.signal.aborted, true);
  assert.equal(f.auth.openBackupRead(new AbortController().signal).status, 'invalidated');
  let settled = false;
  void closed.then(() => { settled = true; });
  firstClose.resolve();
  opened.resolve(last);
  await lastJoined.promise;
  assert.equal(settled, false);
  lastClose.resolve();
  await closed;
  assert.equal(settled, true);
});

test('stale cancellation cannot touch a newer scan or selection; exact cancel drops custody', async t => {
  const f = fixture(t);
  await f.auth.check();
  const first = await settle(f.host, f.host.request(scan).operation);
  const again = f.host.request(scan);
  f.host.request(cancel(first.operation));
  assert.equal(f.host.request(status(again.operation)).status, 'scanning');
  const inspection = await settle(f.host, again.operation);
  const [choice] = inspection.backups[0].revisions;
  const gate = deferred(), started = deferred();
  f.reads.readMarker = q => { started.resolve(q.signal); return gate.promise; };
  const selection = f.host.request(select(inspection.operation, choice.reference));
  const pendingSignal = await started.promise;
  f.host.request(cancel(inspection.operation));
  assert.equal(pendingSignal.aborted, false);
  assert.equal(f.host.request(status(selection.operation)).status, 'selecting');
  f.host.request(cancel(selection.operation));
  assert.ok(pendingSignal.aborted);
  gate.resolve(markerBytes);
  assert.equal((await settle(f.host, selection.operation)).status, 'invalidated');
  assert.equal(f.host.request(status(inspection.operation)).status, 'invalidated');
});

test('auth transitions revoke pending and retained operations without another provider read', async t => {
  for (const action of ['begin', 'check', 'cancel', 'disconnect', 'revoke', 'dispose']) {
    const f = fixture(t);
    await f.auth.check();
    const entering = deferred(), gate = deferred();
    f.reads.list = q => { entering.resolve(q.signal); return gate.promise; };
    const operation = f.host.request(scan).operation;
    const signal = await entering.promise;
    const authorizationId = f.auth.status().authorizationId;
    await f.auth[action](authorizationId);
    assert.ok(signal.aborted, action);
    assert.ok(f.factories[0].signal.aborted, action);
    gate.resolve(json({files: [root], incompleteSearch: false}));
    assert.equal(f.host.request(status(operation)).status, 'invalidated', action);
  }
});

test('external registration and grant changes refuse before capture or completion and never resume that generation', async t => {
  const unissued = fixture(t);
  await unissued.auth.check();
  unissued.replaceClient();
  const refused = await settle(unissued.host, unissued.host.request(scan).operation);
  assert.equal(refused.status, 'unavailable');
  assert.equal(unissued.factories.length, 0);
  for (const mutate of ['replaceClient', 'replaceGrant']) {
    const f = fixture(t);
    await f.auth.check();
    const entering = deferred(), gate = deferred();
    f.reads.list = q => { entering.resolve(q.signal); return gate.promise; };
    const operation = f.host.request(scan).operation;
    const signal = await entering.promise;
    f[mutate]();
    gate.resolve(json({files: [root], incompleteSearch: false}));
    // Let the pending read's completion see the replacement before polling.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(signal.aborted, mutate);
    assert.equal(f.host.request(status(operation)).status, 'invalidated');
    assert.deepEqual(f.writes, ['save']);
    assert.deepEqual(f.provider, ['account']);
  }
});

test('host disposal revokes a retained marker and process restarts cannot recover it', async t => {
  const f = fixture(t);
  await f.auth.check();
  const inspected = await settle(f.host, f.host.request(scan).operation);
  const selected = await settle(f.host, f.host.request(select(inspected.operation, inspected.backups[0].revisions[0].reference)).operation);
  const privateValue = f.host.readSelection(selected.operation, selected.selection.reference);
  const restarted = new IsolatedBackupHost({driveAuth: f.auth});
  assert.equal(restarted.request(status(selected.operation)).status, 'invalidated');
  restarted.dispose();
  f.host.dispose();
  assert.ok(privateValue.signal.aborted);
  assert.equal(f.host.readSelection(selected.operation, selected.selection.reference), null);
  assert.equal(f.host.request(scan).status, 'invalidated');
});

test('authorization expiry aborts an outstanding read without polling or refreshing', async t => {
  const f = fixture(t, {tokenLifetime: 250});
  await f.auth.check();
  const entering = deferred(), aborted = deferred();
  f.reads.list = query => {
    query.signal.addEventListener('abort', aborted.resolve, {once: true});
    entering.resolve();
    return aborted.promise;
  };
  const operation = f.host.request(scan).operation;
  await entering.promise;
  let watchdog;
  try {
    await Promise.race([aborted.promise, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(Error('Authorization expiry did not abort the read')), 2000);
    })]);
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(f.host.request(status(operation)).status, 'invalidated');
  assert.deepEqual(f.provider, ['account']);
  assert.deepEqual(f.writes, ['save']);
});

function downloadReads(f, streamObject) {
  f.reads.listObject = () => json({files: [], incompleteSearch: false});
  f.reads.readObjectMetadata = () => json({id: 'PrivateObject'});
  f.reads.streamObject = streamObject;
}
const bounds = signal => ({signal, maxBytes: 1024, timeoutMs: 1000});

test('private download context retains the selected marker and original binding without recapture', async t => {
  const f = fixture(t);
  downloadReads(f, async function* () { yield Buffer.from('fixture'); });
  await f.auth.check();
  const inspection = await settle(f.host, f.host.request(scan).operation);
  const selected = await settle(f.host,
    f.host.request(select(inspection.operation, inspection.backups[0].revisions[0].reference)).operation);
  const {operation, selection: {reference}} = selected;
  assert.equal(f.host.captureDownload(inspection.operation, reference), null);
  assert.equal(f.host.captureDownload(operation, 'f'.repeat(64)), null);
  const context = f.host.captureDownload(operation, reference);
  assert.equal(context.current(), true);
  assert.equal(context.binding.isCurrent(), true);
  assert.deepEqual(context.selection.markerBytes, markerBytes);
  assert.equal(typeof context.binding.streamObject, 'function');
  assert.equal(f.factories.length, 1);
  // Starting another scan cannot revive this original marker context.
  await settle(f.host, f.host.request(scan).operation);
  assert.equal(context.current(), false);
  assert.equal(context.selection.signal.aborted, true);
  assert.equal(f.host.captureDownload(operation, reference), null);
  assert.equal(f.factories.length, 2);
  assert.deepEqual(f.provider, ['account']);
});

test('download capabilities are all-or-none and absent from a metadata-only capture', async t => {
  const f = fixture(t);
  f.reads.listObject = () => json({files: [], incompleteSearch: false});
  await f.auth.check();
  const opened = f.auth.openBackupRead(new AbortController().signal);
  assert.equal(opened.status, 'qualified');
  for (const method of ['listObject', 'readObjectMetadata', 'streamObject']) assert.equal(opened.binding[method], undefined);
});

test('download metadata checks the original protected records after each asynchronous result', async t => {
  for (const method of ['listObject', 'readObjectMetadata']) {
    const f = fixture(t);
    downloadReads(f, async function* () {});
    const entered = deferred(), finish = deferred();
    f.reads[method] = query => { entered.resolve(query.signal); return finish.promise; };
    await f.auth.check();
    const opened = f.auth.openBackupRead(new AbortController().signal);
    const pending = opened.binding[method](bounds(new AbortController().signal));
    const signal = await entered.promise;
    f.replaceGrant();
    finish.resolve(json({files: []}));
    await assert.rejects(pending, /authorization-failed/);
    assert.equal(signal.aborted, true);
    assert.equal(f.factories.length, 1);
  }
});

test('streamed chunks cannot cross protected client or grant replacement; shutdown is joined', {timeout: 2000}, async t => {
  for (const mutate of ['replaceClient', 'replaceGrant']) {
    const f = fixture(t), entered = deferred(), chunk = deferred(), returning = deferred(), joined = deferred();
    let requestSignal, closed = false;
    downloadReads(f, query => {
      requestSignal = query.signal;
      return {[Symbol.asyncIterator]() { return {
        next() { entered.resolve(); return chunk.promise; },
        async return() {
          assert.equal(requestSignal.aborted, true);
          returning.resolve();
          await joined.promise;
          closed = true;
          return {done: true};
        },
      }; }};
    });
    await f.auth.check();
    const opened = f.auth.openBackupRead(new AbortController().signal);
    const iterator = opened.binding.streamObject(bounds(new AbortController().signal));
    const pending = iterator.next();
    const refused = assert.rejects(pending, /authorization-failed/);
    await entered.promise;
    f[mutate]();
    chunk.resolve({done: false, value: Buffer.from('must not escape')});
    await returning.promise;
    assert.equal(closed, false);
    joined.resolve();
    await refused;
    assert.equal(closed, true);
    assert.equal(f.factories.length, 1);
    assert.deepEqual(f.provider, ['account']);
  }
});

test('aborting while a response opens still takes custody and joins its iterator', {timeout: 2000}, async t => {
  const f = fixture(t), entered = deferred(), openedResponse = deferred(), returned = deferred();
  let providerSignal, nextCalls = 0;
  downloadReads(f, query => { providerSignal = query.signal; entered.resolve(); return openedResponse.promise; });
  await f.auth.check();
  const controller = new AbortController();
  const opened = f.auth.openBackupRead(new AbortController().signal);
  const iterator = opened.binding.streamObject(bounds(controller.signal));
  const rejected = assert.rejects(iterator.next(), /authorization-failed/);
  await entered.promise;
  controller.abort();
  openedResponse.resolve({[Symbol.asyncIterator]() { return {
    next() { nextCalls++; return Promise.resolve({done: true}); },
    return() { assert.equal(providerSignal.aborted, true); returned.resolve(); return Promise.resolve({done: true}); },
  }; }});
  await rejected;
  await returned.promise;
  assert.equal(nextCalls, 0);
});

test('early consumer return aborts before joining; ordinary EOF rechecks authority after join', {timeout: 2000}, async t => {
  for (const eof of [false, true]) {
    const f = fixture(t), returning = deferred(), joined = deferred();
    let providerSignal, closed = false;
    downloadReads(f, query => {
      providerSignal = query.signal;
      return {[Symbol.asyncIterator]() { return {
        next() { return Promise.resolve(eof ? {done: true} : {done: false, value: Buffer.from('one')}); },
        async return() {
          assert.equal(providerSignal.aborted, true);
          returning.resolve();
          await joined.promise;
          closed = true;
          return {done: true};
        },
      }; }};
    });
    await f.auth.check();
    const opened = f.auth.openBackupRead(new AbortController().signal);
    const iterator = opened.binding.streamObject(bounds(new AbortController().signal));
    let result;
    if (eof) result = assert.rejects(iterator.next(), /authorization-failed/);
    else {
      assert.deepEqual(await iterator.next(), {done: false, value: Buffer.from('one')});
      result = iterator.return();
    }
    await returning.promise;
    assert.equal(closed, false);
    if (eof) f.replaceGrant();
    joined.resolve();
    await result;
    assert.equal(closed, true);
  }
});

test('persistent authority capture checks every chunk without repeated synchronous store operations', {timeout: 5000}, async t => {
  const f = fixture(t), guardController = new AbortController();
  const readClient = f.store.client, readGrant = f.store.grant;
  let snapshots = 0, opened = 0, checks = 0, closed = 0;
  f.store.client = () => { snapshots++; return readClient(); };
  f.store.grant = () => { snapshots++; return readGrant(); };
  f.store.openReadGuard = async capture => {
    opened++;
    return {signal: guardController.signal, async check({signal}) {
      checks++;
      assert.equal(signal.aborted, false);
      assert.equal(capture.clientDigest, readClient().digest);
      assert.equal(capture.grantDigest, readGrant().digest);
      return true;
    }, async close() { if (!guardController.signal.aborted) { closed++; guardController.abort(); } }};
  };
  downloadReads(f, async function* () {
    // Represent one 256MiB object with one reused 64KiB buffer; no file/cache.
    const chunk = Buffer.alloc(65536);
    for (let n = 0; n < 4096; n++) yield chunk;
  });
  await f.auth.check();
  const lifetime = new AbortController();
  const captured = f.auth.openBackupRead(lifetime.signal);
  const admittedReads = snapshots;
  let bytes = 0;
  for await (const chunk of captured.binding.streamObject(bounds(new AbortController().signal))) {
    assert.equal(captured.binding.isCurrent(), true);
    bytes += chunk.length;
  }
  assert.equal(bytes, 256 * 1024 * 1024);
  assert.equal(opened, 1);
  assert.equal(snapshots, admittedReads);
  assert.ok(checks >= 8192 && checks <= 8200);
  lifetime.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(captured.binding.isCurrent(), false);
});

test('failed persistent guard admission or mid-read check cannot release provider data or recapture', async t => {
  for (const failAtOpen of [true, false]) {
    const f = fixture(t), guardController = new AbortController();
    const entered = deferred(), finish = deferred();
    let opened = 0, failed = false, closed = 0, providerReads = 0;
    f.store.openReadGuard = async () => {
      opened++;
      if (failAtOpen) throw Error('fixture admission failure');
      return {signal: guardController.signal,
        async check() { if (failed) throw Error('fixture original record changed'); return true; },
        async close() { if (!guardController.signal.aborted) { closed++; guardController.abort(); } },
      };
    };
    downloadReads(f, async function* () {});
    f.reads.readObjectMetadata = async () => { providerReads++; entered.resolve(); return finish.promise; };
    await f.auth.check();
    const captured = f.auth.openBackupRead(new AbortController().signal);
    const refused = assert.rejects(captured.binding.readObjectMetadata(bounds(new AbortController().signal)), /authorization-failed/);
    if (!failAtOpen) { await entered.promise; failed = true; finish.resolve(json({id: 'must-not-escape'})); }
    await refused;
    assert.equal(opened, 1);
    assert.equal(providerReads, failAtOpen ? 0 : 1);
    assert.equal(closed, failAtOpen ? 0 : 1);
    assert.equal(captured.binding.isCurrent(), false);
  }
});
