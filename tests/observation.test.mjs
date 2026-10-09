import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { ConnectionController } from '../src/observation.ts';
import { validateResult, WiredObserver } from '../host/observer.mjs';
import { startHelper } from '../host/browser-helper.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const observation = { connection_id: 'a'.repeat(64), boot_id: '11111111-1111-1111-1111-111111111111', model: 'reMarkable 1.0',
  firmware: '3.28.0.172', firmware_conflict: false, architecture: 'armv7l', installed_version: null, provenance: 'unknown',
  service: { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' } };
const observed = o => ({ contract_version: 1, status: 'observed', observation: o });
const cancelled = () => Promise.resolve({ contract_version: 1, status: 'cancelled', observation: null });

test('disconnect suppresses a late actual adapter result and clears current state', async () => {
  let complete, ownRead;
  const owned = new Promise(resolve => { ownRead = resolve; });
  const controller = new ConnectionController({ observe: () => new Promise(resolve => { complete = resolve; ownRead(); }), cancel: cancelled }, () => {});
  const pending = controller.connect();
  assert.equal(controller.state.status, 'checking');
  // Wait for the adapter to own the read, then disconnect while it is pending.
  await owned;
  controller.disconnect();
  complete(observed(observation)); await pending;
  assert.equal(controller.state.status, 'cancelled');
  assert.equal(controller.state.observation, null);
  controller.dispose();
});
test('changed tablet boot stops polling and cannot silently switch observed identity', async () => {
  let changed;
  const event = new Promise(resolve => { changed = resolve; });
  let reads = 0;
  const controller = new ConnectionController({ observe: async () => observed({ ...observation, boot_id: ++reads === 1 ? observation.boot_id : '22222222-2222-2222-2222-222222222222' }), cancel: cancelled },
    state => { if (state.status === 'device-changed') changed(); }, 1);
  try { await controller.connect(); await event; assert.equal(controller.state.observation, null); assert.equal(reads, 2); }
  finally { controller.dispose(); }
});
test('versioned result rejects privileged fields and unverified installed-version claims', () => {
  validateResult(observed(observation));
  assert.throws(() => validateResult(observed({ ...observation, installed_version: 'v1.2.3' })));
  assert.throws(() => validateResult({ ...observed(observation), password: 'secret' }));
});
test('cable failure clears observations and stops automatic reconnection', async () => {
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  let reads = 0;
  const controller = new ConnectionController({ observe: async () => ++reads === 1 ? observed(observation) :
    { contract_version: 1, status: 'cable-lost', observation: null }, cancel: cancelled },
  state => { if (state.status === 'cable-lost') failed(); }, 1);
  try {
    await controller.connect(); await failure;
    assert.equal(controller.state.observation, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, 2);
  } finally { controller.dispose(); }
});
test('unconfigured and unsupported observer refuse without spawning credentials or transport', async () => {
  assert.equal((await new WiredObserver({ platform: 'darwin' }).observe()).status, 'unsupported-host');
  assert.equal((await new WiredObserver({ platform: 'win32', config: undefined, python: undefined }).observe()).status, 'unconfigured');
  assert.equal((await new WiredObserver({ platform: 'linux', config: undefined, python: undefined }).observe()).status, 'unconfigured');
});
test('browser helper requires exact loopback host, origin, private session and bounded fixed action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-helper-'));
  await writeFile(path.join(root, 'index.html'), '<html>fixture</html>');
  let calls = 0;
  const helper = await startHelper({ root, observer: { observe: async () => { calls++; return observed(observation); }, cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) } });
  const post = (headers, body = JSON.stringify({ action: 'observe' })) => fetch(helper.origin + '/manager-host', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  try {
    const page = await fetch(helper.origin + '/preview/');
    const cookie = page.headers.get('set-cookie').split(';')[0];
    assert.match(page.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await post({ Origin: helper.origin })).status, 403);
    assert.equal((await post({ Origin: 'https://other.example', Cookie: cookie })).status, 403);
    const spoof = await new Promise((resolve, reject) => {
      const req = request(helper.origin + '/manager-host', { method: 'POST', headers: { Host: 'evil.example', Origin: helper.origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(JSON.stringify({ action: 'observe' }));
    });
    assert.equal(spoof, 403);
    assert.equal((await post({ Origin: helper.origin, Cookie: cookie }, JSON.stringify({ action: 'observe', command: 'reboot' }))).status, 400);
    assert.equal((await post({ Origin: helper.origin, Cookie: cookie }, 'null')).status, 400);
    assert.equal(calls, 0);
    assert.equal((await (await post({ Origin: helper.origin, Cookie: cookie })).json()).status, 'observed');
    assert.equal(calls, 1);
  } finally { await helper.close(); await rm(root, { recursive: true }); }
});

test('supervisor cancels and bounds an actual owned stalled child without publishing stale output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-child-'));
  const script = path.join(root, 'stalled.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);');
  try {
    const observer = new WiredObserver({ platform: 'linux', config: path.join(root, 'fixture'), python: process.execPath, script });
    const pending = observer.observe(); observer.cancel();
    assert.equal((await pending).status, 'cancelled');
    const bounded = new WiredObserver({ platform: 'linux', config: path.join(root, 'fixture'), python: process.execPath, script, timeoutMs: 50 });
    assert.equal((await bounded.observe()).status, 'timeout');
    assert.equal(bounded.active, null);
  } finally { await rm(root, { recursive: true }); }
});
