import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { CapacitiesTablet } from '../host/capacities-tablet.mjs';
import { MaintenanceIO } from '../host/maintenance-io.mjs';
import { WiredObserver } from '../host/observer.mjs';

const id = () => ({ operation_id: randomUUID(), grant_id: randomUUID() });
const option = (ms = 13000) => ({ deadline: performance.now() + ms, signal: new AbortController().signal });
const proof = Object.freeze({
  code: 'synthetic-code', verifier: 'v'.repeat(43), client_id: 'fixture-client',
  redirect_uri: 'http://127.0.0.1:48761/oauth/capacities/callback', resource: 'https://api.capacities.io'
});
const original = Object.freeze({
  tablet_id: randomUUID(), connection_id: '1'.repeat(64), boot_id: randomUUID(), config_sha256: '2'.repeat(64)
});
const hardware = Object.freeze({
  connection_id: original.connection_id, boot_id: original.boot_id, model: null, firmware: null,
  firmware_conflict: false, architecture: null, installed_version: null, provenance: 'unknown',
  service: { LoadState: null, ActiveState: null, SubState: null }
});
const sha = '3'.repeat(64);

test('a bounded private tablet port keeps one original exchange after an absent status', async () => {
  const io = new MaintenanceIO();
  const calls = [];
  let status = 'not-dispatched';
  const observer = {
    lastObservation: hardware,
    async runCapacities(request) {
      calls.push(structuredClone(request));
      assert.equal(io.acquire('foreign', 'foreign', 'read'), null);
      if (request.selector === 'exchange') throw Error('fixture delivery unknown');
      return {
        status: 'observed', observation: hardware, executable_sha256: sha,
        capacities_oauth: request.selector === 'capture' ? { contract_version: 1, status: 'captured', ...original }
          : { contract_version: 1, status, ...request.binding,
            ...(status === 'committed' ? { installed_config_sha256: '4'.repeat(64), space_id: randomUUID() } : {}) }
      };
    }
  };
  const tablet = new CapacitiesTablet({ observer, io });
  const ids = id();
  const binding = { ...await tablet.capture(ids, option()), ...ids };
  assert.deepEqual(binding, { ...original, ...ids });
  assert.equal(await tablet.current(binding, option()), true);
  await assert.rejects(tablet.handoff(binding, proof, option(62000)));
  assert.equal(calls[2].executable_sha256, sha);
  assert.deepEqual(calls[2].proof, proof);
  assert.equal(calls[2].budget_ms <= 60000 && calls[2].budget_ms > 59000, true);
  assert.equal((await tablet.status(binding, option())).status, 'not-dispatched');
  assert.deepEqual(calls[3].binding, binding);
  assert.equal(Object.hasOwn(calls[3], 'proof'), false);
  await assert.rejects(tablet.capture(id(), option()));
  await assert.rejects(tablet.handoff(binding, proof, option(62000)));
  await assert.rejects(tablet.status({ ...binding, grant_id: randomUUID() }, option()));
  assert.equal(calls.filter(call => call.selector === 'exchange').length, 1);
  status = 'committed';
  assert.equal((await tablet.status(binding, option())).status, 'committed');
  await tablet.capture(id(), option());
});

test('changed executable and expired large phase never send the secret lane', async () => {
  let digest = sha;
  const observer = {
    lastObservation: hardware,
    async runCapacities(request) {
      assert.equal(request.selector, 'capture');
      return { status: 'observed', observation: hardware, executable_sha256: digest,
        capacities_oauth: { contract_version: 1, status: 'captured', ...original } };
    }
  };
  const tablet = new CapacitiesTablet({ observer });
  const ids = id();
  const binding = { ...await tablet.capture(ids, option()), ...ids };
  digest = '5'.repeat(64);
  assert.equal(await tablet.current(binding, option()), false);
  await assert.rejects(tablet.handoff(binding, proof, option(62000)));
  digest = sha;
  assert.equal(await tablet.current(binding, option()), true);
  assert.equal((await tablet.handoff(binding, proof, option(34000))).status, 'not-dispatched');
  await tablet.capture(id(), option());
});

test('real host child readiness charges startup before the bounded stdin handoff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capacities-observer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostOutput = { contract_version: 1, status: 'observed', observation: hardware,
    capacities_oauth: { contract_version: 1, status: 'captured', ...original }, executable_sha256: sha,
    secret_disposition: null };
  await writeFile(join(root, 'capacities_oauth_transport.py'), `
    process.stdin.once('data', () => { if (!ready) process.exit(4); });
    let ready = false;
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks));
      if (request.budget_ms >= 11800 || request.budget_ms <= 0 || 'proof' in request) process.exit(3);
      process.stdout.write(${JSON.stringify(JSON.stringify(hostOutput) + '\n')});
    });
    setTimeout(() => { ready = true; process.stdout.write('capacities-oauth-ready-v1\\n'); }, 300);
  `);
  const observer = new WiredObserver({ config: join(root, 'unused-config.json'),
    python: process.execPath, script: join(root, 'wired_observer.py') });
  const request = { selector: 'capture', budget_ms: 12000,
    binding: { connection_id: original.connection_id, boot_id: original.boot_id } };
  assert.deepEqual(await observer.runCapacities(request, option()), hostOutput);
});

test('closed trusted preflight refusal settles zero-send while missing settlement stays uncertain', async t => {
  const binding = { ...original, ...id() };
  const root = await mkdtemp(join(tmpdir(), 'capacities-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observer = new WiredObserver({ config: join(root, 'unused-config.json'),
    python: process.execPath, script: join(root, 'wired_observer.py') });
  const request = { selector: 'exchange', budget_ms: 60000, binding, proof, executable_sha256: sha };
  const report = { contract_version: 1, status: 'cable-lost', observation: null,
    capacities_oauth: null, executable_sha256: null, secret_disposition: 'not-sent' };
  const script = join(root, 'capacities_oauth_transport.py');
  for (const exit of [0, 4]) {
    await writeFile(script, `
      process.stdout.write('capacities-oauth-ready-v1\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write(${JSON.stringify(JSON.stringify(report) + '\n')});
        process.exitCode = ${exit};
      });
    `);
    const result = await observer.runCapacities(request, option(62000));
    assert.equal(result.secret_disposition, exit === 0 ? 'not-sent' : 'possibly-sent');
  }

  const ready = { status: 'observed', observation: hardware, executable_sha256: sha,
    capacities_oauth: {contract_version: 1, status: 'captured', ...original} };
  const tablet = new CapacitiesTablet({observer: {
    lastObservation: hardware,
    async runCapacities(request) { return request.selector === 'capture' ? ready : report; }
  }});
  const ids = id();
  const verified = { ...await tablet.capture(ids, option()), ...ids };
  assert.equal(await tablet.current(verified, option()), true);
  assert.deepEqual(await tablet.handoff(verified, proof, option(62000)),
    {contract_version: 1, ...verified, status: 'not-dispatched'});
  await tablet.capture(id(), option());
});
