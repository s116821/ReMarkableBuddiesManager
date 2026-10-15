import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validMemoryText, parseMemoryRequest, parseMemoryReport } from '../host/memory-query.mjs';
import { MemoryController } from '../src/memory-query.ts';
import { WiredObserver } from '../host/observer.mjs';
import { startHelper } from '../host/browser-helper.mjs';
import { request, report, reply, tablet } from './fixtures/memory-query.mjs';

test('actual unchanged Main626 stdin reports preserve local/selected identity and all refusal statuses through the consumer', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/main-626-memory-reports.json', import.meta.url), 'utf8'));
  assert.equal(fixture.source, '626c2f818ad335f6aa49e5a9e88a739267b270cb');
  const c = new MemoryController(() => {});
  for (const [name, r] of Object.entries(fixture.reports)) {
    assert.deepEqual(parseMemoryReport(r), r);
    await c.search({ memoryQuery: async () => reply(r) }, tablet, 'physics units');
    if (name.endsWith('complete')) assert.equal(c.state.report.data.context.facts[0].fact.provenance.description, 'Explicit isolated host fixture assertion');
    if (name === 'local-empty') assert.match(c.state.status, /no matching global facts/);
    if (name === 'busy') assert.equal(c.state.status, 'Memory query busy');
    if (name === 'missing-store' || name === 'invalid-input') assert.doesNotMatch(c.state.status, /Search complete/);
  }
});

test('query preserves exact text and admits only fixed identity and UTF8 bounds', () => {
  assert.equal(parseMemoryRequest(request()).text, request().text);
  assert.equal(validMemoryText('🦊'.repeat(512)), true);
  for (const text of ['', ' \r\n', '\0', '\ud800', '🦊'.repeat(513)]) assert.equal(validMemoryText(text), false);
  for (const v of [{ ...request(), path: '/arbitrary' }, { ...request(), boot_id: '0'.repeat(36) }, { ...request(), connection_id: 'bad' }, { ...request(), text: 2 }]) assert.throws(() => parseMemoryRequest(v));
});
test('complete/disabled/partial/busy/old-input states never infer empty from facts alone', async () => {
  const c = new MemoryController(() => {});
  for (const q of ['complete', 'complete-empty', 'disabled', 'partial', 'unavailable']) {
    const r = report(q); assert.equal(parseMemoryReport(r).data.query_status, q);
    await c.search({ memoryQuery: async () => reply(r) }, tablet, request().text);
    assert.equal(c.state.report.data.query_status, q); assert.equal(c.state.busy, false);
  }
  for (const status of ['busy', 'unsupported', 'conflict', 'invalid-input', 'failed', 'unavailable']) {
    const r = { report_version: 1, operation: 'query', status, incomplete: false, data: null };
    await c.search({ memoryQuery: async () => reply(r) }, tablet, request().text);
    assert.doesNotMatch(c.state.status, /Search complete/);
    if (status === 'invalid-input') assert.match(c.state.status, /input unsupported/);
  }
  const bogus = report('complete-empty'); bogus.status = 'unavailable'; assert.throws(() => parseMemoryReport(bogus));
});
test('strict report guards fact identity, global scope, budgets, provenance and truthful completeness', () => {
  for (const alter of [v => { v.report_version = 2; }, v => { v.operation = 'forget'; }, v => { v.data.context.facts = []; }, v => { v.incomplete = true; },
    v => { v.data.context.provenance_authority = 'verified'; }, v => { v.data.context.facts[0].fact.key.scope = { kind: 'document', document: tablet.boot_id }; },
    v => { v.data.context.facts[0].fact.provenance.secret = 'PRIVATE_SENTINEL'; }, v => { v.data.context.facts[0].fact.value = 'x'.repeat(4097); },
    v => { v.data.context.facts.push(v.data.context.facts[0]); }, v => { v.data.diagnostics.expired = -1; }, v => { v.data.context.facts[0].fact.confidence_basis_points = 10001; }]) {
    const v = report(); alter(v); assert.throws(() => parseMemoryReport(v));
  }
});
test('replacement, cancellation and changed boot cannot publish late/private results', async () => {
  const c = new MemoryController(() => {}); let finish;
  const old = c.search({ memoryQuery: () => new Promise(resolve => { finish = resolve; }) }, tablet, 'old');
  await c.search({ memoryQuery: async () => reply(report('complete-empty')) }, tablet, 'new');
  finish(reply(report())); await old; assert.equal(c.state.report.data.query_status, 'complete-empty');
  const pending = c.search({ memoryQuery: () => new Promise(resolve => { finish = resolve; }) }, tablet, 'cancel');
  c.clear('Search cancelled'); finish(reply(report())); await pending; assert.equal(c.state.report, null);
  const changed = reply(report()); changed.observation = { ...tablet, boot_id: '22222222-2222-2222-2222-222222222222' };
  await c.search({ memoryQuery: async () => changed }, tablet, 'query'); assert.equal(c.state.report, null);
  await c.search({ memoryQuery: async () => { throw Error('PRIVATE_SENTINEL'); } }, tablet, 'query'); assert.equal(JSON.stringify(c.state).includes('PRIVATE_SENTINEL'), false);
});
test('actual bounded child dispatch sends text only on stdin and sanitizes malformed/oversized/stale results', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-memory-child-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'); await writeFile(config, 'normal');
  await writeFile(path.join(root, 'memory_query_transport.py'), `const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const q=JSON.parse(raw);if(process.argv.length!==2||q.text!==${JSON.stringify(request().text)})throw Error('unexpected input');const mode=fs.readFileSync(process.env.MANAGER_WIRED_CONFIG,'utf8');if(mode==='oversize'){process.stdout.write('x'.repeat(139265));return}if(mode==='wait'){setTimeout(()=>{},30000);return}if(mode==='exit'){process.stderr.write('PRIVATE_SENTINEL');process.exit(1)}const v=${JSON.stringify(reply(report()))};if(mode==='changed')v.observation.boot_id='22222222-2222-2222-2222-222222222222';if(mode==='future')v.memory_query.report.report_version=2;if(mode==='invalidutf8'){process.stdout.write(Buffer.from([255]));return}console.log(JSON.stringify(v))});`);
  const host = new WiredObserver({ config, python: process.execPath, script: path.join(root, 'wired_observer.py') });
  assert.equal((await host.memoryQuery(request())).memory_query.report, null); host.lastObservation = tablet;
  assert.equal((await host.memoryQuery(request())).memory_query.report.data.context.facts[0].fact.subject, 'Physics');
  for (const mode of ['oversize', 'changed', 'future', 'invalidutf8', 'exit', 'wait']) {
    host.timeoutMs = mode === 'wait' ? 200 : 13000; await writeFile(config, mode); const v = await host.memoryQuery(request()); assert.equal(v.memory_query.report, null); assert.equal(JSON.stringify(v).includes('PRIVATE_SENTINEL'), false);
    if (mode === 'future') assert.equal(v.memory_query.status, 'unsupported');
    if (mode === 'wait') assert.equal(v.status, 'timeout');
  }
  host.timeoutMs = 13000; await writeFile(config, 'wait'); const pending = host.memoryQuery(request()); host.cancel(); assert.equal((await pending).status, 'cancelled');
});
test('actual helper rejects origin/cookie/query/path/oversize/duplicate/invalidUTF8 before dispatch', async t => {
  let calls = 0, observed;
  const helper = await startHelper({ root: path.resolve('dist/manager/browser'), observer: { cancel() {}, memoryQuery: async q => { calls++; observed = q; return reply(report()); } }, driveAuth: { dispose() {} } }); t.after(() => helper.close());
  const initial = await fetch(helper.origin + '/preview/'); const cookie = initial.headers.get('set-cookie').split(';')[0];
  const headers = { Origin: helper.origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const send = (body, h = headers, suffix = '') => fetch(helper.origin + '/manager-memory-query' + suffix, { method: 'POST', headers: h, body });
  assert.equal((await send(JSON.stringify(request()), { ...headers, Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await send(JSON.stringify(request()), { ...headers, Cookie: '' })).status, 403);
  assert.equal((await send(JSON.stringify(request()), headers, '?path=bad')).status, 403);
  for (const value of [JSON.stringify({ ...request(), path: '/arbitrary' }), '{"text":"one","text":"two"}', ' ' + JSON.stringify(request()), Buffer.from([255])]) assert.equal((await send(value)).status, 400);
  assert.equal((await send('x'.repeat(16385))).status, 413); assert.equal(calls, 0);
  assert.equal((await send(JSON.stringify(request()))).status, 200); assert.equal(observed.text, request().text); assert.equal(calls, 1);
});
