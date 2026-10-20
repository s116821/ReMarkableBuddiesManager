import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMemoryInspectionRequest, memoryRecordId, parseMemoryInspectionReport, parseMemoryInspectionView, parseMemoryInspectionResult, reduceMemoryInspectionResult } from '../host/memory-inspection.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { MemoryInspectionController } from '../src/memory-inspection.ts';
import { WiredObserver } from '../host/observer.mjs';
import { startHelper } from '../host/browser-helper.mjs';
import { key, record, id, request, report, envelope, privateReply, tablet } from './fixtures/memory-inspection.mjs';
const reply = r => reduceMemoryInspectionResult(privateReply(r), request(), validateResult);

test('canonical record derivation agrees with published example and independent Python UUIDv5, not key property order', async () => {
  assert.equal(await memoryRecordId(key), record);
  const reordered = { fact: key.fact, scope: { kind: 'global' }, profile: key.profile };
  assert.equal(await memoryRecordId(reordered), record);
  for (const fact of [id(1), id(2), id(99)]) {
    const k = { ...key, fact };
    const p = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys,json,uuid;k=json.loads(sys.argv[1]);print(uuid.uuid5(uuid.NAMESPACE_URL,"urn:remarkable-buddies:subject-memory:v1:"+json.dumps(k,separators=(",",":"))))', JSON.stringify(k)], { encoding: 'utf8' });
    assert.equal(p.status, 0); assert.equal(await memoryRecordId(k), p.stdout.trim());
  }
});

test('local competing values and tombstones preserve every head without choosing a winner or retaining raw envelopes', async () => {
  const raw = report([envelope(1), envelope(2, 'tombstone'), envelope(3)]);
  const view = await parseMemoryInspectionReport(raw, request());
  assert.equal(view.heads.length, 3); assert.deepEqual(view.heads.map(h => h.revision), [id(1), id(2), id(3)]);
  assert.equal(view.heads[1].fact, null); assert.equal(view.heads[0].fact.value, raw.data[0].payload.value);
  assert.notEqual(view.heads[0].fact, raw.data[0].payload);
  assert.equal(JSON.stringify(view).includes('envelope_version'), false);
  const c = new MemoryInspectionController(() => {}); await c.inspect({ inspectMemory: () => reply(raw) }, tablet, key);
  assert.match(c.state.status, /Conflict/); assert.equal(c.state.view.heads.length, 3);
});

test('empty requested key and selected whole-view refusal remain distinct with exact incomplete flags', async () => {
  assert.deepEqual(await parseMemoryInspectionReport(report([]), request()), { status: 'ok', incomplete: false, heads: [] });
  const c = new MemoryInspectionController(() => {});
  for (const status of ['partial', 'busy', 'unavailable', 'unsupported', 'conflict', 'invalid-input', 'failed']) {
    for (const incomplete of [false, true]) {
      const raw = { ...report(), status, incomplete, data: null };
      assert.deepEqual(await parseMemoryInspectionReport(raw, request()), { status, incomplete, heads: null });
      await c.inspect({ inspectMemory: () => reply(raw) }, tablet, key); assert.equal(c.state.view.heads, null); assert.equal(c.state.view.incomplete, incomplete);
    }
  }
  await c.inspect({ inspectMemory: () => reply(report([])) }, tablet, key); assert.match(c.state.status, /No current heads for this fact/);
});

test('foreign tombstones, unsupported raw heads, duplicate revisions/parents and numeric or Fact violations refuse the entire view', async () => {
  const changes = [e => { e.record_id = key.fact; }, e => { e.namespace = 'conversation'; }, e => { e.domain_schema_version = 2; }, e => { e.extra = true; },
    e => { e.parents = [e.revision_id]; }, e => { e.parents = [id(20), id(20)]; }, e => { e.operation_id += '\n'; }, e => { e.media_descriptors = [{}]; },
    e => { e.payload.subject = '  '; }, e => { e.payload.value = ''; }, e => { e.payload.claim = 'Unnormalized'; }, e => { e.payload.key.fact = id(9); },
    e => { e.payload.observed_ms = 9007199254740992; }, e => { e.payload.expires_ms = 0; }, e => { e.payload.provenance.turn = id(4); }, e => { e.payload.key.scope.extra = true; },
    e => { e.kind = 'unknown'; }, e => { e.payload = { opaque: true }; }];
  for (const change of changes) { const bad = envelope(2); change(bad); await assert.rejects(parseMemoryInspectionReport(report([envelope(), bad]), request())); }
  const foreign = envelope(2, 'tombstone'); foreign.record_id = key.fact; await assert.rejects(parseMemoryInspectionReport(report([foreign]), request()));
  await assert.rejects(parseMemoryInspectionReport(report([envelope(), envelope()]), request()));
  for (const raw of [{ ...report(), operation: 'query' }, { ...report(), incomplete: true }, { ...report(), status: 'conflict' }, report(null), { ...report(), data: { current_heads: [] } }]) await assert.rejects(parseMemoryInspectionReport(raw, request()));
  const huge = envelope(); huge.payload.value = 'x'.repeat(262145); await assert.rejects(parseMemoryInspectionReport(report([huge]), request()));
});

test('exact request and reduced public schemas reject command authority, raw reports and changed observation identity', async () => {
  assert.deepEqual(parseMemoryInspectionRequest(request()), request());
  for (const bad of [{ ...request(), path: '/arbitrary' }, { ...request(), operation: 'put' }, { ...request(), boot_id: tablet.boot_id+'\n' }, { ...request(), connection_id: tablet.connection_id+'\n' }, { ...request(), key: { ...key, scope: { kind: 'document', document: id(1) } } }, {}]) assert.throws(() => parseMemoryInspectionRequest(bad));
  const good = await reply(report());
  await parseMemoryInspectionResult(good, request(), validateResult);
  await assert.rejects(parseMemoryInspectionResult(privateReply(report()), request(), validateResult));
  const changed = structuredClone(good); changed.observation.boot_id = id(9); await assert.rejects(parseMemoryInspectionResult(changed, request(), validateResult));
  for (const change of [v => { v.pin = 'PRIVATE'; }, v => { v.heads[0].record = key.fact; }, v => { v.heads[0].extra = true; }, v => { v.incomplete = true; }]) { const v = structuredClone(good.memory_inspection.view); change(v); await assert.rejects(parseMemoryInspectionView(v, request())); }
});

test('controller drops delayed completion on replacement/cancel/new-search/same-ID refresh and sanitizes failure', async () => {
  const c = new MemoryInspectionController(() => {}); let finish;
  for (const reason of ['New search', 'Memory inspection cancelled', 'Same IDs refreshed']) {
    const pending = c.inspect({ inspectMemory: () => new Promise(r => { finish = r; }) }, tablet, key);
    c.clear(reason); finish(await reply(report())); await pending; assert.equal(c.state.view, null); assert.equal(c.state.status, reason);
  }
  const pending = c.inspect({ inspectMemory: () => new Promise(r => { finish = r; }) }, tablet, key);
  await c.inspect({ inspectMemory: () => reply(report([])) }, tablet, key); finish(await reply(report())); await pending; assert.deepEqual(c.state.view.heads, []);
  await c.inspect({ inspectMemory: async () => { throw Error('PRIVATE_CANARY'); } }, tablet, key); assert.equal(JSON.stringify(c.state).includes('PRIVATE_CANARY'), false);
});

test('actual child dispatch validates raw output, reduces to fresh public data and refuses stale/canceled/oversized/invalid bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-memory-inspection-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'); await writeFile(config, 'good');
  await writeFile(path.join(root, 'memory_inspection_transport.py'), `const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{if(raw!==${JSON.stringify(JSON.stringify(request()))})throw Error('input');const mode=fs.readFileSync(process.env.MANAGER_WIRED_CONFIG,'utf8');if(mode==='wait'){setTimeout(()=>{},30000);return}if(mode==='oversize'){process.stdout.write('x'.repeat(278529));return}if(mode==='utf8'){process.stdout.write(Buffer.from([255]));return}if(mode==='exit')process.exit(1);const v=${JSON.stringify(privateReply(report()))};if(mode==='foreign')v.memory_inspection.report.data[0].record_id=${JSON.stringify(key.fact)};if(mode==='future')v.memory_inspection.report.report_version=2;if(mode==='partial'){process.stdout.write(JSON.stringify(v).slice(0,-1));return}console.log(JSON.stringify(v))});`);
  const host = new WiredObserver({ config, python: process.execPath, script: path.join(root, 'wired_observer.py') });
  assert.equal((await host.inspectMemory(request())).memory_inspection.view, null); host.lastObservation = tablet;
  assert.equal((await host.inspectMemory(request())).memory_inspection.view.heads[0].record, record);
  for (const mode of ['oversize', 'utf8', 'exit', 'foreign', 'future', 'partial', 'wait']) { await writeFile(config, mode); host.timeoutMs = mode === 'wait' ? 200 : 13000; const v = await host.inspectMemory(request()); assert.equal(v.memory_inspection.view, null); }
  const p = host.inspectMemory(request()); host.cancel(); assert.equal((await p).status, 'cancelled');
});

test('actual loopback helper guards canonical requests and refuses raw-private response injection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-memory-inspection-helper-')); await writeFile(path.join(root, 'index.html'), '<main>fixture</main>'); t.after(() => rm(root, { recursive: true, force: true }));
  let leak = false, calls = 0;
  const helper = await startHelper({ root, observer: { cancel() {}, inspectMemory: async q => { calls++; assert.deepEqual(q, request()); return leak ? privateReply(report()) : reply(report()); } }, driveAuth: { dispose() {} } }); t.after(() => helper.close());
  const initial = await fetch(helper.origin+'/preview/'); const headers = { Origin: helper.origin, Cookie: initial.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const send = (body, h=headers, suffix='') => fetch(helper.origin+'/manager-memory-inspection'+suffix, { method: 'POST', headers: h, body });
  for (const h of [{ ...headers, Origin: 'https://untrusted.invalid' }, { ...headers, Cookie: '' }, { ...headers, 'Content-Type': 'text/plain' }]) assert.equal((await send(JSON.stringify(request()), h)).status, 403);
  assert.equal((await send(JSON.stringify(request()), headers, '?operation=put')).status, 403);
  for (const body of [' '+JSON.stringify(request()), JSON.stringify({ ...request(), path: '/bad' }), '{"key":0,"key":1}', Buffer.from([255])]) assert.equal((await send(body)).status, 400);
  assert.equal((await send('x'.repeat(1025))).status, 413); assert.equal(calls, 0);
  assert.equal((await send(JSON.stringify(request()))).status, 200); leak = true; assert.equal((await send(JSON.stringify(request()))).status, 503);
});
