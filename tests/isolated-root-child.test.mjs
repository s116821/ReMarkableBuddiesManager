import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WiredObserver } from '../host/observer.mjs';
import { tablet } from './fixtures/memory-forget.mjs';

const selector = 'provision-isolated-backup';
const identity = { connection_id: tablet.connection_id, boot_id: tablet.boot_id };
const fixtures = new URL('./fixtures/isolated-root-provisioning/', import.meta.url);

async function syntheticChild(t, mode, options = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-isolated-root-child-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const record = path.join(folder, 'requests.jsonl');
  const input = await readFile(new URL('request.json', fixtures));
  const report = await readFile(new URL('current.json', fixtures));
  const script = path.join(folder, 'local_mode_choice_transport.py');
  await writeFile(script, `
    const fs = require('node:fs');
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      fs.appendFileSync(${JSON.stringify(record)}, input + '\\n');
      const mode = ${JSON.stringify(mode)};
      if (mode === 'hold') { setInterval(() => {}, 1000); return; }
      if (mode === 'exit') {
        process.stderr.write('PRIVATE_CHILD_SENTINEL');
        process.stdout.write('PRIVATE_CHILD_SENTINEL');
        process.exitCode = 1;
        return;
      }
      const observation = ${JSON.stringify(tablet)};
      if (mode === 'wrong-boot') observation.boot_id = '99999999-9999-4999-8999-999999999999';
      if (mode === 'wrong-connection') observation.connection_id = '0'.repeat(64);
      let bytes = Buffer.from(${JSON.stringify(report.toString('base64'))}, 'base64');
      if (mode === 'partial') bytes = bytes.subarray(0, -1);
      if (mode === 'doubled') bytes = Buffer.concat([bytes, bytes]);
      if (mode === 'oversized-report') bytes = Buffer.concat([Buffer.alloc(16384, 32), Buffer.from('\\n')]);
      const value = {contract_version:1, status:'observed', observation,
        local_mode_raw:{status:'reported', stdout_base64:bytes.toString('base64')}};
      if (mode === 'bad-base64') value.local_mode_raw.stdout_base64 = '%%%%';
      let output = JSON.stringify(value);
      const limit = mode === 'exact' ? 24576 : mode === 'over' ? 24577 : 0;
      if (limit) output += ' '.repeat(limit - Buffer.byteLength(output));
      process.stdout.write(output);
    });
  `);
  const observer = new WiredObserver({
    config: path.join(folder, 'synthetic-config'), python: process.execPath,
    script: path.join(folder, 'wired_observer.py'), ...options
  });
  const request = { ...identity, selector, input_base64: input.toString('base64'), budget_ms: 45000 };
  return { observer, request, input, report, record };
}

const run = (observer, request) => observer.run('local-mode-choice', request);

test('provisioning child uses the fixed mode action, separate budget and original bytes', async t => {
  const { observer, request, input, report, record } = await syntheticChild(t, 'exact');
  assert.equal(observer.timeoutMs, 13000);
  assert.equal(observer.provisioningTimeoutMs, 45000);
  for (const invalid of [
    { ...request, budget_ms:45001 }, { ...request, budget_ms:true },
    { ...request, selector:'inspect', input_base64:null, budget_ms:12001 },
    { ...request, selector:'choose', budget_ms:12001 }
  ]) {
    assert.equal((await run(observer, invalid)).status, 'observation-unavailable');
  }
  await assert.rejects(readFile(record), { code:'ENOENT' });
  const result = await run(observer, request);
  assert.equal(result.status, 'observed');
  assert.equal(result.local_mode_raw.status, 'reported');
  assert.deepEqual(Buffer.from(result.local_mode_raw.stdout_base64, 'base64'), report);
  const sent = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(sent.selector, selector);
  assert.equal(sent.budget_ms, 45000);
  assert.deepEqual(Buffer.from(sent.input_base64, 'base64'), input);
});

test('provisioning child discards stale identity, unbounded or incomplete output and diagnostics', async t => {
  for (const mode of ['wrong-boot', 'wrong-connection', 'over', 'oversized-report',
    'partial', 'doubled', 'bad-base64', 'exit']) {
    const { observer, request } = await syntheticChild(t, mode);
    const value = await run(observer, request);
    assert.equal(value.status, 'observation-unavailable', mode);
    assert.deepEqual(value.local_mode_raw, { status:'unavailable', stdout_base64:null }, mode);
    assert.equal(JSON.stringify(value).includes('PRIVATE_CHILD_SENTINEL'), false);
  }
});

test('provisioning child honors cancellation and the independent observer timeout without retry', { timeout: 6000 }, async t => {
  const cancelled = await syntheticChild(t, 'hold');
  const pending = run(cancelled.observer, cancelled.request);
  for (let tries = 0; tries < 150; tries++) {
    if (await readFile(cancelled.record).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(JSON.parse(await readFile(cancelled.record, 'utf8')).selector, selector);
  cancelled.observer.cancel();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(cancelled.observer.active, null);
  const timed = await syntheticChild(t, 'hold', { timeoutMs:13000, provisioningTimeoutMs:600 });
  const result = await run(timed.observer, timed.request);
  assert.equal(result.status, 'timeout');
  assert.deepEqual(result.local_mode_raw, { status:'unavailable', stdout_base64:null });
  assert.equal((await readFile(timed.record, 'utf8')).trim().split('\n').length, 1);
  assert.equal(timed.observer.active, null);
});
