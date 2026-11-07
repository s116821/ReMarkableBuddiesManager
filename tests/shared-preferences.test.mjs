import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {MaintenanceIO} from '../host/maintenance-io.mjs';
import {startHelper} from '../host/browser-helper.mjs';
import {SharedPreferencesHost, registerSharedPreferenceHandler} from '../host/shared-preferences.mjs';

import {fixture, target, guard, patch, privateText, digest} from './fixtures/shared-preferences.mjs';

async function browserPath(f) {
  const helper = await startHelper({
    root: fileURLToPath(new URL('./fixtures/', import.meta.url)),
    observer: f.observer, driveAuth: {dispose() {}}, downloads: {dispose() {}}
  });
  // The helper issues the cookie before reading index.html, even if the static
  // fixture root contains no built application. No browser or tablet is required.
  const first = await fetch(helper.origin + '/preview/');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  await first.text();
  const headers = {origin: helper.origin, cookie, 'Content-Type': 'application/json'};
  const post = (path, body, options = headers) => fetch(helper.origin + path, {method: 'POST', headers: options, body});
  await (await post('/manager-host', '{"action":"observe"}')).text();
  const route = '/manager-shared-preferences';
  return {
    call: async q => {
      const response = await post(route, JSON.stringify(q));
      if (!response.ok) throw Error('Guarded browser request refused');
      return response.json();
    },
    guard: async () => {
      assert.equal((await post(route, '{"action":"retained"}', {...headers, origin: 'http://wrong.invalid'})).status, 403);
      assert.equal((await post(route, '{"action":"retained","action":"retained"}')).status, 400);
    },
    close: helper.close
  };
}

async function electronPath(f) {
  const host = new SharedPreferencesHost({observer: f.observer, io: new MaintenanceIO(), beforeIO() {}});
  let handle, preload;
  const trusted = {}, authorized = event => event === trusted;
  registerSharedPreferenceHandler({handle: (channel, callback) => {
    assert.equal(channel, 'manager:sharedPreferences');
    handle = callback;
  }}, authorized, host);
  runInNewContext(await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      contextBridge: {exposeInMainWorld: (_, value) => { preload = value; }},
      ipcRenderer: {invoke: (channel, ...args) => {
        assert.equal(channel, 'manager:sharedPreferences');
        return handle(trusted, ...args);
      }}
    })
  });
  return {
    call: q => preload.sharedPreferences(q),
    guard: async () => {
      await assert.rejects(handle({}, {action: 'retained'}));
      await assert.rejects(preload.sharedPreferences());
      await assert.rejects(preload.sharedPreferences({}, {}));
    },
    close: () => host.dispose()
  };
}

const inspect = {action: 'inspect', ...target, reveal_text: false};
for (const [name, path] of [['browser HTTP', browserPath], ['Electron registered handler and preload', electronPath]]) {
  test(name + ' guarded contract preserves sparse edits and original-only recovery', async () => {
    const f = fixture();
    const {call, guard: assertGuard, close} = await path(f);
    try {
      await assertGuard();
      assert.equal((await call(inspect)).state, 'unsupported');
      f.set('busy');
      assert.equal((await call(inspect)).state, 'busy');
      f.set('normal');
      const ready = await call(inspect);
      assert.equal(ready.state, 'ready');
      assert.equal(ready.view.effective.personalization_text, null);
      assert.equal(JSON.stringify(ready).includes('local_config_sha256'), false);
      const revealed = await call({...inspect, reveal_text: true});
      assert.equal(revealed.view.effective.personalization_text, privateText);
      assert.equal((await call({action: 'edit', ...target, reference: ready.reference, patch})).state, 'invalidated');
      f.set('conflict');
      assert.equal((await call({action: 'edit', ...target, reference: revealed.reference, patch})).state, 'conflict');
      assert.deepEqual((await call({action: 'retained'})).retained, []);

      f.set('normal');
      const view = await call(inspect);
      f.set('lost');
      const edit = {action: 'edit', ...target, reference: view.reference, patch};
      assert.equal((await call(edit)).state, 'unknown');
      assert.equal((await call(edit)).state, 'invalidated');
      const [original] = (await call({action: 'retained'})).retained;
      assert.deepEqual(original, {...target, reference: view.reference});
      assert.equal(JSON.stringify(original).includes(privateText), false);
      const editBody = f.calls.filter(call => call.selector === 'edit').at(-1).body;
      assert.deepEqual(editBody.patch, patch);
      const status = {action: 'status', ...target, reference: original.reference};
      f.set('substituted');
      assert.equal((await call(status)).state, 'unknown');
      f.set('normal');
      assert.equal((await call(status)).state, 'applied');
      assert.deepEqual(f.calls.at(-1).body, {shared_preferences_version: 1,
        operation: editBody.operation, guard, patch_sha256: digest(patch)});
      assert.deepEqual((await call({action: 'retained'})).retained, []);
    } finally { await close(); }
  });
}

test('cancellation after possible dispatch and late completion retain the original', async () => {
  const f = fixture();
  f.set('normal');
  const host = new SharedPreferencesHost({observer: f.observer, io: new MaintenanceIO(), beforeIO() {}});
  const view = host.deliver(await host.request(inspect));
  f.set('hold');
  const writing = host.request({action: 'edit', ...target, reference: view.reference, patch});
  const cancel = await host.request({action: 'cancel', reference: view.reference});
  assert.equal(cancel.state, 'unknown');
  assert.equal(f.cancelCount(), 1);
  f.release();
  assert.equal((await writing).state, 'unknown');
  assert.equal((await host.request({action: 'retained'})).retained.length, 1);
});
