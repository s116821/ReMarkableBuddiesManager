import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { report, reply, privateReply, tablet, request, actor, tokenDigest, bindingDigest, rootId, group, backup } from './fixtures/saved-mode.mjs';

const packaged = process.argv.includes('--packaged');
const development = !packaged;
const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-saved-mode-ui-'));
await mkdir('test-results', { recursive: true });
const variants = Object.fromEntries(['unconfigured', 'local-only', 'isolated-backup', 'shared-group'].map(kind => [kind, reply(report(kind))]));
for (const status of ['busy', 'unsupported', 'unavailable', 'conflict', 'failed', 'invalid-input']) {
  variants[status] = reply({ report_version: 1, operation: 'inspect', status, incomplete: status === 'unavailable' || status === 'failed', activation_performed: false, data: null });
}
variants.future = reply({ ...report(), report_version: 2 });
let state = 'shared-group', releasePending;
const respond = async q => {
  assert.deepEqual(q, request());
  if (state === 'delayed') { await new Promise(resolve => { releasePending = resolve; }); return variants['shared-group']; }
  return state === 'raw' ? privateReply(report('shared-group')) : variants[state];
};
async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://api.github.com/repos/s116821/')) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    if (url.startsWith('file:') || (origin && new URL(url).origin === origin)) return route.continue();
    return route.abort();
  });
}
async function verify(page, setState, capture, release) {
  const read = page.getByRole('button', { name: 'Read saved storage mode', exact: true });
  const status = page.getByTestId('saved-mode-status');
  const details = page.getByTestId('saved-mode-details');
  await expect(read).toBeDisabled();
  await page.getByRole('button', { name: 'Read tablet state', exact: true }).click(); await page.getByTestId('tablet-model').waitFor();
  await read.click(); await expect(status).toHaveText('Shared group (saved)'); await expect(details).toContainText(group);
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#saved-mode-title').scrollIntoViewIfNeeded(); await capture();
  const publicValue = JSON.stringify(await page.evaluate(q => window.managerHost ? window.managerHost.inspectSavedMode(q) : fetch('/manager-saved-mode', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q),
  }).then(r => r.json()), request()));
  for (const canary of [actor, tokenDigest, bindingDigest, rootId]) { assert.equal(publicValue.includes(canary), false); assert.equal((await page.locator('body').innerText()).includes(canary), false); }
  for (const [mode, label] of [['unconfigured', 'No explicit storage mode saved'], ['local-only', 'Local only (saved)'], ['isolated-backup', 'Isolated backup (saved)']]) {
    await setState(mode); await read.click(); await expect(status).toHaveText(label);
    if (mode === 'unconfigured') await expect(details).toHaveCount(0);
    if (mode === 'isolated-backup') await expect(details).toContainText(backup);
  }
  for (const [mode, label] of [['busy', 'busy'], ['unsupported', 'unsupported'], ['unavailable', 'unavailable'], ['conflict', 'conflict'], ['failed', 'failed'], ['invalid-input', 'invalid-input'], ['future', 'unsupported'], ['raw', 'response refused']]) {
    await setState(mode); await read.click(); await expect(status).toContainText(label); await expect(details).toHaveCount(0);
  }
  await setState('delayed'); await read.click(); await expect(page.getByRole('button', { name: 'Cancel mode inspection', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel mode inspection', exact: true }).click(); await expect(status).toHaveText('Saved mode inspection cancelled');
  await release(); await page.waitForTimeout(100); await expect(details).toHaveCount(0);
  await setState('delayed'); await read.click();
  await page.getByRole('button', { name: 'Read tablet state', exact: true }).click(); await page.getByTestId('tablet-model').waitFor();
  await expect(status).toHaveText('Not inspected'); await release(); await page.waitForTimeout(100);
  await expect(status).toHaveText('Not inspected'); await expect(details).toHaveCount(0);
  await setState('shared-group'); await read.click(); await expect(status).toHaveText('Shared group (saved)');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(details).toHaveCount(0); await expect(read).toBeDisabled();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
}

const helper = await startHelper({ root: path.resolve(development ? 'test-results/development/browser' : 'dist/manager/browser'),
  observer: { observe: async () => ({ contract_version: 1, status: 'observed', observation: tablet }), inspectSavedMode: respond, cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) },
  driveAuth: { dispose() {}, status: async () => ({ contract_version: 1, status: 'unconfigured', account: null, checkedAt: null, error: null, authorizationId: null, backupReady: false }) },
  downloads: { dispose() {}, request: async () => { throw Error('Fixture unavailable'); } } });
const browser = await chromium.launch();
try {
  const context = await browser.newContext(); await isolate(context, helper.origin); const page = await context.newPage(); await page.goto(helper.origin + '/preview/');
  await verify(page, async value => { state = value; }, () => page.locator('section[aria-labelledby="saved-mode-title"]').screenshot({ path: `test-results/saved-mode-browser${development ? '-development' : ''}.png` }), async () => { releasePending(); });
  console.log(`${development ? 'development' : 'retained production'} browser saved-mode meanings/refusals/private-field reduction/cancel/same-ID refresh/responsive UI pass; semantic reports and route are fixtures`);
} finally { await browser.close(); await helper.close(); }

const environment = { ...process.env };
for (const name of Object.keys(environment)) if (name.startsWith('MANAGER_')) delete environment[name];
Object.assign(environment, { MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: folder });
const app = await electron.launch({ executablePath: packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined,
  args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: environment });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  // Replace only transport methods: the actual main IPC authorization and reduced-view validator remain installed.
  await app.evaluate(({ app }, fixture) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path');
    const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(app.getAppPath(), 'host');
    const { WiredObserver } = require(path.join(hostRoot, 'observer.mjs'));
    globalThis.savedModeState = 'shared-group'; globalThis.savedModeFixture = fixture;
    WiredObserver.prototype.observe = async () => ({ contract_version: 1, status: 'observed', observation: fixture.tablet });
    WiredObserver.prototype.inspectSavedMode = async q => {
      if (JSON.stringify(q) !== JSON.stringify(fixture.request)) throw Error('Unexpected input');
      const mode = globalThis.savedModeState;
      if (mode === 'delayed') { await new Promise(resolve => { globalThis.savedModeRelease = resolve; }); return structuredClone(fixture.variants['shared-group']); }
      return structuredClone(mode === 'raw' ? fixture.private : fixture.variants[mode]);
    };
  }, { tablet, request: request(), variants, private: privateReply(report('shared-group')) });
  await app.evaluate(async ({ app, BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`));
  for (const expression of ['window.managerHost.inspectSavedMode({path:"/arbitrary"})', 'window.managerHost.inspectSavedMode({}, {})', 'window.managerHost.inspectSavedMode()']) {
    assert.equal(await page.evaluate(expression + '.then(()=>"accepted",()=>"refused")'), 'refused');
  }
  if (packaged) {
    const resources = await app.evaluate(() => process.resourcesPath);
    for (const file of ['saved_mode_transport.py', 'saved-mode.mjs']) assert.deepEqual(await readFile(path.join(resources, 'host', file)), await readFile(path.join('host', file)));
    const child = spawnSync(process.env.MANAGER_WIRED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [path.join(resources, 'host/saved_mode_transport.py')], { input: 'PRIVATE_INPUT_CANARY', encoding: 'utf8', timeout: 3000 });
    assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.equal(child.stdout.includes('PRIVATE_INPUT_CANARY'), false);
  }
  await verify(page, value => app.evaluate((_electron, value) => { globalThis.savedModeState = value; }, value), async () => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await writeFile(`test-results/saved-mode-desktop${packaged ? '-packaged' : ''}.png`, Buffer.from(png, 'base64'));
  }, () => app.evaluate(() => { globalThis.savedModeRelease(); globalThis.savedModeRelease = null; }));
  console.log(`${packaged ? 'retained packaged' : 'source'} Electron actual IPC arity/reduced-view refusal and synthetic saved-mode UI pass; no tablet/provider/native qualification`);
} finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
