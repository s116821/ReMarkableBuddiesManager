import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseSavedModeRequest, parseSavedModeReport, parseSavedModeView, parseSavedModeResult, reduceSavedModeResult } from '../host/saved-mode.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { SavedModeController } from '../src/saved-mode.ts';
import { WiredObserver } from '../host/observer.mjs';
import { startHelper } from '../host/browser-helper.mjs';
import { report, request, reply, privateReply, tablet, actor, tokenDigest, bindingDigest, rootId, group, backup } from './fixtures/saved-mode.mjs';

test('seven actual producer-owner Windows reports retain byte hashes and pass the real reduced-view parser', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/main-b1-saved-mode-reports.json', import.meta.url), 'utf8'));
  assert.equal(fixture.source, 'b1fa8a60c547141ccd5e716611863f04f1efdb48');
  assert.equal(Object.keys(fixture.reports).length, 7);
  const c = new SavedModeController(() => {});
  for (const [name, raw] of Object.entries(fixture.reports)) {
    const bytes = Buffer.from(JSON.stringify(raw) + '\n');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.report_sha256[name]);
    assert.ok(bytes.length <= 16384);
    const view = parseSavedModeReport(raw);
    await c.inspect({ inspectSavedMode: async () => reply(raw) }, tablet);
    assert.deepEqual(c.state.view, view);
    if (raw.data === null) { assert.equal(view.status, name === 'missing.json' ? 'unavailable' : name.replace('.json', '')); assert.equal(view.snapshot, null); }
    else {
      assert.equal(view.snapshot.kind, name.replace('.json', ''));
      assert.equal(JSON.stringify(c.state).includes(raw.data.current_snapshot.token.actor), false);
      assert.equal(JSON.stringify(c.state).includes(raw.data.current_snapshot.token.sha256), false);
    }
  }
});

test('saved meanings remain distinct and all conditional/provider metadata is removed by fresh construction', () => {
  for (const kind of ['unconfigured', 'local-only', 'isolated-backup', 'shared-group']) {
    const raw = report(kind), before = JSON.stringify(raw), view = parseSavedModeReport(raw);
    assert.equal(view.snapshot.kind, kind); assert.equal(JSON.stringify(raw), before);
    assert.equal(view.snapshot.group, kind === 'shared-group' ? group : null);
    assert.equal(view.snapshot.backup, kind === 'isolated-backup' ? backup : null);
    const result = reply(raw); assert.equal(parseSavedModeResult(result, request(), validateResult), result);
    for (const canary of [actor, tokenDigest, bindingDigest, rootId, 'current_snapshot', 'receipt', 'binding_sha256']) assert.equal(JSON.stringify(result).includes(canary), false);
    assert.notEqual(view.snapshot, raw.data.current_snapshot);
  }
});

test('all published refusal statuses preserve status/incompleteness and never manufacture a snapshot', () => {
  for (const status of ['invalid-input', 'unsupported', 'unavailable', 'busy', 'conflict', 'failed']) {
    for (const incomplete of [false, true]) {
      const raw = { report_version: 1, operation: 'inspect', status, incomplete, activation_performed: false, data: null };
      assert.deepEqual(parseSavedModeReport(raw), { status, incomplete, snapshot: null });
    }
  }
  const future = report(); future.report_version = 2;
  assert.equal(reduceSavedModeResult(privateReply(future), request(), validateResult).saved_mode.status, 'unsupported');
});

test('raw inspection refuses mutation receipts, unknown shapes and inconsistent nullable identities', () => {
  const cases = [
    v => { v.operation = 'choose'; }, v => { v.activation_performed = true; }, v => { v.incomplete = true; }, v => { v.status = 'partial'; },
    v => { v.report_version = '1'; }, v => { v.report_version = 0; },
    v => { v.data = null; }, v => { v.data.receipt = {}; }, v => { v.data.receipt_status = 'historical'; }, v => { v.secret = 'PRIVATE'; },
    v => { v.data.current_snapshot.token.actor = '00000000-0000-0000-0000-000000000000'; }, v => { v.data.current_snapshot.token.sha256 = 'A'.repeat(64); },
    v => { v.data.current_snapshot.token.actor += '\n'; }, v => { v.data.current_snapshot.token.sha256 += '\n'; },
    v => { v.data.current_snapshot.token.extra = true; }, v => { v.data.current_snapshot.device = null; }, v => { v.data.current_snapshot.epoch = 'bad'; },
    v => { v.data.current_snapshot.mode = null; }, v => { v.data.current_snapshot.mode.kind = 'new-mode'; }, v => { v.data.current_snapshot.mode.extra = true; },
  ];
  for (const change of cases) { const raw = report(); change(raw); assert.throws(() => parseSavedModeReport(raw)); }
  const unconfigured = report('unconfigured'); unconfigured.data.current_snapshot.device = actor; assert.throws(() => parseSavedModeReport(unconfigured));
  for (const root of ['', 'x'.repeat(257), '../path', 'space value', '🦊', 'valid\n', 'valid\r', 'valid\u2028']) { const raw = report('shared-group'); raw.data.current_snapshot.mode.root_id = root; assert.throws(() => parseSavedModeReport(raw)); }
  const max = report('shared-group'); max.data.current_snapshot.mode.root_id = 'a_-0'.repeat(64); assert.equal(parseSavedModeReport(max).snapshot.group, group);
  for (const kind of ['shared-group', 'isolated-backup']) { const raw = report(kind); raw.data.current_snapshot.mode.binding_sha256 = 'x'; assert.throws(() => parseSavedModeReport(raw)); }
});

test('public views refuse private field injection, healthy errors and changed session identity', () => {
  for (const alter of [v => { v.token = {}; }, v => { v.snapshot.actor = actor; }, v => { v.incomplete = true; }, v => { v.snapshot.kind = 'unknown'; },
    v => { v.snapshot.group = group; }, v => { v.snapshot = null; }, v => { v.status = 'busy'; }]) {
    const view = parseSavedModeReport(report()); alter(view); assert.throws(() => parseSavedModeView(view));
  }
  const changed = reply(report()); changed.observation = { ...changed.observation, boot_id: actor }; assert.throws(() => parseSavedModeResult(changed, request(), validateResult));
  const injected = reply(report()); injected.saved_mode.report = report(); assert.throws(() => parseSavedModeResult(injected, request(), validateResult));
  const notObserved = privateReply(report()); notObserved.status = 'cancelled'; notObserved.observation = null; assert.throws(() => reduceSavedModeResult(notObserved, request(), validateResult));
});

test('renderer request accepts only exact current identity without commands, paths or mode preconditions', () => {
  assert.deepEqual(parseSavedModeRequest(request()), request());
  for (const q of [{ ...request(), command: 'choose' }, { ...request(), token: {} }, { ...request(), path: '/private' },
    { ...request(), connection_id: 'bad' }, { ...request(), connection_id: request().connection_id + '\n' }, { ...request(), boot_id: request().boot_id + '\n' },
    { ...request(), boot_id: '00000000-0000-0000-0000-000000000000' }, {}, null]) assert.throws(() => parseSavedModeRequest(q));
});

test('controller preserves saved/refusal meanings and invalidates late results on replacement, cancel and same-ID refresh', async () => {
  const c = new SavedModeController(() => {});
  for (const kind of ['unconfigured', 'local-only', 'isolated-backup', 'shared-group']) {
    await c.inspect({ inspectSavedMode: async () => reply(report(kind)) }, tablet);
    assert.equal(c.state.view.snapshot.kind, kind); assert.equal(c.state.busy, false);
    for (const canary of [actor, tokenDigest, bindingDigest, rootId]) assert.equal(JSON.stringify(c.state).includes(canary), false);
  }
  await c.inspect({ inspectSavedMode: async () => reply({ report_version: 1, operation: 'inspect', status: 'busy', incomplete: false, activation_performed: false, data: null }) }, tablet);
  assert.match(c.state.status, /busy/); assert.equal(c.state.view.snapshot, null);
  let finish;
  const old = c.inspect({ inspectSavedMode: () => new Promise(resolve => { finish = resolve; }) }, tablet);
  await c.inspect({ inspectSavedMode: async () => reply(report('local-only')) }, tablet);
  finish(reply(report('shared-group'))); await old; assert.equal(c.state.view.snapshot.kind, 'local-only');
  for (const reason of ['Inspection cancelled', 'Not inspected']) {
    const pending = c.inspect({ inspectSavedMode: () => new Promise(resolve => { finish = resolve; }) }, tablet);
    c.clear(reason); finish(reply(report())); await pending; assert.equal(c.state.view, null); assert.equal(c.state.status, reason);
  }
  const changed = reply(report()); changed.observation = { ...tablet, boot_id: actor };
  await c.inspect({ inspectSavedMode: async () => changed }, tablet); assert.equal(c.state.view, null);
  await c.inspect({ inspectSavedMode: async () => { throw Error('PRIVATE_DIAGNOSTIC_CANARY'); } }, tablet);
  assert.equal(JSON.stringify(c.state).includes('PRIVATE_DIAGNOSTIC_CANARY'), false);
});

test('actual bounded child dispatch reduces private output and refuses stale, malformed, oversized and canceled work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-saved-mode-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'); await writeFile(config, 'normal');
  await writeFile(path.join(root, 'saved_mode_transport.py'), `const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{if(process.argv.length!==2||raw!==${JSON.stringify(JSON.stringify(request()))})throw Error('input');const mode=fs.readFileSync(process.env.MANAGER_WIRED_CONFIG,'utf8');if(mode==='wait'){setTimeout(()=>{},30000);return}if(mode==='oversize'){process.stdout.write('x'.repeat(32769));return}if(mode==='exit'){process.stderr.write('PRIVATE_DIAGNOSTIC_CANARY');process.exit(1)}if(mode==='invalidutf8'){process.stdout.write(Buffer.from([255]));return}const value=${JSON.stringify(privateReply(report('shared-group')))};if(mode==='changed')value.observation.boot_id=${JSON.stringify(actor)};if(mode==='future')value.saved_mode.report.report_version=2;if(mode==='receipt')value.saved_mode.report.data.receipt={};if(mode==='partial'){process.stdout.write(JSON.stringify(value).slice(0,-1));return}console.log(JSON.stringify(value))});`);
  const host = new WiredObserver({ config, python: process.execPath, script: path.join(root, 'wired_observer.py') });
  assert.equal((await host.inspectSavedMode(request())).saved_mode.view, null); host.lastObservation = tablet;
  const healthy = await host.inspectSavedMode(request()); assert.equal(healthy.saved_mode.view.snapshot.group, group);
  for (const canary of [actor, tokenDigest, bindingDigest, rootId]) assert.equal(JSON.stringify(healthy).includes(canary), false);
  for (const mode of ['oversize', 'exit', 'invalidutf8', 'changed', 'future', 'receipt', 'partial', 'wait']) {
    await writeFile(config, mode); host.timeoutMs = mode === 'wait' ? 200 : 13000;
    const value = await host.inspectSavedMode(request()); assert.equal(value.saved_mode.view, null);
    assert.equal(JSON.stringify(value).includes('PRIVATE_'), false);
    if (mode === 'future') assert.equal(value.saved_mode.status, 'unsupported');
    if (mode === 'wait') assert.equal(value.status, 'timeout');
  }
  host.timeoutMs = 13000; const pending = host.inspectSavedMode(request()); host.cancel(); assert.equal((await pending).status, 'cancelled');
});

test('actual browser helper guards identity-only requests and refuses an unreduced private backend response', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-saved-mode-helper-')); await writeFile(path.join(root, 'index.html'), '<main>fixture</main>');
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0, leak = false;
  const helper = await startHelper({ root, observer: { cancel() {}, inspectSavedMode: async q => { calls++; assert.deepEqual(q, request()); return leak ? privateReply(report('shared-group')) : reply(report('shared-group')); } }, driveAuth: { dispose() {} } });
  t.after(() => helper.close());
  const initial = await fetch(helper.origin + '/preview/'); const cookie = initial.headers.get('set-cookie').split(';')[0];
  const headers = { Origin: helper.origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const send = (body, h = headers, suffix = '') => fetch(helper.origin + '/manager-saved-mode' + suffix, { method: 'POST', headers: h, body });
  for (const h of [{ ...headers, Origin: 'https://untrusted.invalid' }, { ...headers, Cookie: '' }, { ...headers, 'Content-Type': 'text/plain' }]) assert.equal((await send(JSON.stringify(request()), h)).status, 403);
  assert.equal((await send(JSON.stringify(request()), headers, '?operation=choose')).status, 403);
  for (const raw of [JSON.stringify({ ...request(), operation: 'choose' }), '{"boot_id":"one","boot_id":"two"}', ' '+JSON.stringify(request()), Buffer.from([255])]) assert.equal((await send(raw)).status, 400);
  assert.equal((await send('x'.repeat(257))).status, 413); assert.equal(calls, 0);
  const accepted = await send(JSON.stringify(request())); assert.equal(accepted.status, 200); const text = await accepted.text();
  for (const canary of [actor, tokenDigest, bindingDigest, rootId]) assert.equal(text.includes(canary), false);
  leak = true; const refused = await send(JSON.stringify(request())); assert.equal(refused.status, 503); assert.equal(await refused.text(), '');
});
