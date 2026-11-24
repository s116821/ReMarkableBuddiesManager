import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WiredObserver} from '../host/observer.mjs';
import {invocation, producer, tablet, target} from './fixtures/first-configuration.mjs';

test('first configuration consumes only closed joined child frames and stops the captured process', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-first-config-child-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const config = path.join(folder, 'bound-config');
  const record = path.join(folder, 'requests');
  const script = path.join(folder, 'first_configuration_transport.py');
  const observer = new WiredObserver({config, python: process.execPath, script: path.join(folder, 'wired_observer.py')});
  const request = {...target(), service: tablet.service, selector: 'create-initial', expected_executable_sha256: null};
  const good = {dispatch: 'possible', observation: tablet, report: producer('create-initial', 'created'), executable_sha256: null};
  const install = async raw => {
    await writeFile(script, [
      'const fs=require("node:fs"); let body=""; process.stdout.write("READY\\n");',
      'process.stdin.setEncoding("utf8");process.stdin.on("data",part=>body+=part);',
      'process.stdin.on("end",()=>{',
      'fs.appendFileSync(' + JSON.stringify(record) + ',body);',
      raw === null ? 'setInterval(()=>{},1000);' : 'process.stdout.write(' + JSON.stringify(raw) + ');',
      '});',
    ].join('\n'));
  };
  for (const [mode, raw, expected] of [
    ['valid', JSON.stringify(good) + '\n', 'created'],
    ['foreign boot', JSON.stringify({...good, observation: {...tablet, boot_id: invocation(90)}}) + '\n', undefined],
    ['duplicate', (JSON.stringify(good) + '\n').replace('"state":"created"', '"state":"created","state":"created"'), undefined],
    ['trailing frame', JSON.stringify(good) + '\n{}\n', undefined],
    ['pre-dispatch proof', JSON.stringify({dispatch: 'not-dispatched', observation: null, report: null, executable_sha256: null}) + '\n', undefined],
  ]) {
    await install(raw);
    const state = await observer.runFirstConfiguration(request, {
      signal: new AbortController().signal, current: () => true, remainingMs: () => 12000,
    });
    assert.equal(state.report?.state, expected, mode);
    assert.equal(state.dispatch, mode === 'pre-dispatch proof' ? 'not-dispatched' : 'possible', mode);
    assert.equal(observer.active, null);
  }
  await install(null);
  const cancel = new AbortController();
  const running = observer.runFirstConfiguration(request, {
    signal: cancel.signal, current: () => !cancel.signal.aborted, remainingMs: () => 12000,
  });
  const original = observer.active;
  assert.ok(original);
  await once(original, 'spawn');
  cancel.abort();
  assert.equal((await running).report, null);
  assert.equal(observer.active, null);

  await install(JSON.stringify(good) + '\n');
  const after = await observer.runFirstConfiguration(request, {
    signal: new AbortController().signal, current: () => true, remainingMs: () => 12000,
  });
  assert.equal(after.report.state, 'created');
  for (const line of (await readFile(record, 'utf8')).trim().split('\n')) {
    const input = JSON.parse(line);
    assert.deepEqual(Object.keys(input).sort(), ['boot_id', 'budget_ms', 'connection_id', 'expected_executable_sha256', 'selector', 'service']);
    assert.equal(input.selector, 'create-initial');
    assert.ok(input.budget_ms > 0 && input.budget_ms <= 12000);
  }
});
