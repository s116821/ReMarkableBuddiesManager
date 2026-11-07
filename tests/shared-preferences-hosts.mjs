import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {chromium, _electron as electron, expect} from '@playwright/test';
import {startHelper} from '../host/browser-helper.mjs';
import {fixture, privateText} from './fixtures/shared-preferences.mjs';

const packaged = process.argv.includes('--packaged');
const root = path.resolve(packaged ? 'dist/manager/browser' : 'test-results/development/browser');
const packageExecutable = path.resolve(
  'out/packages', `ReMarkableBuddiesManager-${process.platform}-x64`,
  process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'
);
async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file:') || (origin && new URL(url).origin === origin)) return route.continue();
    return route.abort();
  });
}

async function exercise(page, set, calls) {
  const panel = page.getByRole('region', {name: 'Shared group preferences'});
  const status = panel.getByTestId('shared-preference-status');
  // Original recovery remains keyboard reachable even before a tablet is read.
  const originals = panel.getByRole('button', {name: 'Refresh original edits'});
  await originals.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(originals).toBeFocused();
  assert.equal(await originals.evaluate(button => button.matches(':focus-visible')), true);
  await page.getByRole('button', {name: 'Read tablet state', exact: true}).click();
  const inspect = panel.getByRole('button', {name: 'Inspect shared preferences', exact: true});
  await expect(inspect).toBeEnabled();
  await inspect.click();
  await expect(status).toContainText('does not support');
  await set('normal');
  await inspect.click();
  await expect(status).toHaveText('Shared preference snapshot read.');
  await expect(panel).toContainText('Writer enabled (local)');
  await expect(panel).not.toContainText(privateText.trim());

  await panel.getByRole('button', {name: 'Inspect and reveal private prompt'}).click();
  await expect(panel.locator('pre')).toContainText(privateText.trim());
  await panel.getByRole('button', {name: 'Clear shared view or stop waiting'}).click();
  await expect(panel.locator('pre')).toHaveCount(0);
  await inspect.click();
  await expect(status).toHaveText('Shared preference snapshot read.');

  await panel.locator('select[name=writer]').selectOption('on');
  await panel.locator('select[name=research]').selectOption('null');
  await panel.getByLabel('Apply these declarations to this shared group').check();
  await set('lost');
  await panel.getByRole('button', {name: 'Save shared preferences'}).click();
  await expect(status).toContainText('outcome is unknown');
  const edit = (await calls()).filter(call => call.selector === 'edit');
  assert.equal(edit.length, 1);
  assert.deepEqual(edit[0].body.patch, {portable_configuration_version: 1,
    settings: {product_settings: {writer_enabled: true}, research_policy: null}});
  await set('normal');
  await panel.getByRole('button', {name: 'Check original shared edit 1', exact: true}).click();
  await expect(status).toContainText('verified as applied');
  const last = (await calls()).at(-1);
  assert.equal(last.selector, 'status');
  assert.equal(last.body.operation, edit[0].body.operation);
  assert.equal(Object.hasOwn(last.body, 'patch'), false);
  await expect(panel).not.toContainText('local_config_sha256');
}

const f = fixture();
const helper = await startHelper({root, observer: f.observer, driveAuth: {
  dispose() {}, status: async () => ({contract_version: 1, status: 'unconfigured', account: null,
    checkedAt: null, error: null, authorizationId: null, backupReady: false})
}, downloads: {dispose() {}, request: async () => { throw Error('Unavailable in fixture'); }}});
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await isolate(context, helper.origin);
  const page = await context.newPage();
  await page.goto(helper.origin + '/preview/');
  await exercise(page, state => f.set(state), () => f.calls);
} finally {
  await browser.close();
  await helper.close();
}
console.log(`${packaged ? 'Production' : 'Development'} browser panel and guarded loopback helper passed with simulated Buddy replies.`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MANAGER_')));
await mkdir('test-results', {recursive: true});
const profile = await mkdtemp(path.resolve('test-results/shared-preferences-profile-'));
Object.assign(env, {MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: profile});
const app = await electron.launch({
  executablePath: packaged ? packageExecutable : process.env.SHARED_PREFERENCES_ELECTRON,
  args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env
});
try {
  const page = await app.firstWindow();
  await isolate(app.context());
  assert.equal(await app.evaluate(({app}) => app.isPackaged), packaged);
  if (packaged) {
    const resources = await app.evaluate(() => process.resourcesPath);
    const files = ['shared-preferences.mjs', 'shared-preferences-protocol.mjs',
      'shared_preferences_transport.py', 'portable_configuration_transport.py'];
    for (const file of files) {
      assert.deepEqual(await readFile(path.join(resources, 'host', file)),
        await readFile(path.join('host', file)));
    }
    const child = spawnSync(process.env.MANAGER_WIRED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
      ['-B', path.join(resources, 'host/shared_preferences_transport.py')],
      {input: 'PRIVATE_CANARY', encoding: 'utf8', timeout: 3000, windowsHide: true});
    assert.equal(child.status, 0);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.includes('PRIVATE_CANARY'), false);
    assert.equal(JSON.parse(child.stdout).status, 'observation-unavailable');
  }
  await app.evaluate(async ({app, BrowserWindow}, fixturePath) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path'), root = app.getAppPath();
    const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(root, 'host');
    globalThis.sharedPreferenceHarness = require(fixturePath).fixture();
    const {WiredObserver} = require(path.join(hostRoot, 'observer.mjs'));
    const {DriveAuth} = require(path.join(hostRoot, 'drive-auth.mjs'));
    DriveAuth.prototype.status = async () => ({contract_version: 1, status: 'unconfigured', account: null,
      checkedAt: null, error: null, authorizationId: null, backupReady: false});
    WiredObserver.prototype.observe = async function () {
      const result = await globalThis.sharedPreferenceHarness.observer.observe();
      this.lastObservation = result.observation;
      return result;
    };
    WiredObserver.prototype.run = function (...args) {
      return globalThis.sharedPreferenceHarness.observer.run(...args);
    };
    const window = BrowserWindow.getAllWindows()[0];
    await window.loadFile(path.join(root, 'dist/manager/browser/index.html'));
  }, path.resolve('tests/fixtures/shared-preferences.mjs'));
  assert.equal(await page.evaluate(() => typeof globalThis.window.require), 'undefined');
  await exercise(page,
    state => app.evaluate((_electron, value) => globalThis.sharedPreferenceHarness.set(value), state),
    () => app.evaluate(() => globalThis.sharedPreferenceHarness.calls));
} finally {
  await app.close();
}
console.log(`${packaged ? 'Packaged' : 'Source'} sandboxed Electron panel and guarded IPC passed with simulated Buddy replies.`);
