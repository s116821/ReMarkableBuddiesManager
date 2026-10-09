import { chromium, _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { validateResult } from '../host/observer.mjs';
const packaged = process.argv.includes('--packaged');
const observation = { connection_id: 'a'.repeat(64), boot_id: '11111111-1111-1111-1111-111111111111', model: 'reMarkable 1.0',
  firmware: '3.28.0.172', firmware_conflict: false, architecture: 'armv7l', installed_version: null, provenance: 'unknown',
  service: { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' } };
const fixture = validateResult({ contract_version: 1, status: 'observed', observation });
const root = await mkdtemp(path.join(os.tmpdir(), 'manager-wired-ui-'));
const api = 'https://api.github.com/repos/s116821/ReMarkableBuddies/releases/latest';
async function isolate(context, localOrigin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === api) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    if (url.startsWith('file:') || (localOrigin && new URL(url).origin === localOrigin)) return route.continue();
    return route.abort();
  });
}
async function verify(page, expected) {
  await page.getByRole('button', { name: 'Read tablet state' }).click();
  if (expected === 'observed') {
    await page.getByTestId('tablet-model').filter({ hasText: 'reMarkable 1.0' }).waitFor();
    assert.equal(await page.getByTestId('installed-version').textContent(), 'Unknown — installed provenance not verified');
    assert.equal(await page.getByRole('button', { name: 'Install unavailable' }).isDisabled(), true);
  } else await page.getByRole('heading', { name: 'Host transport unavailable' }).waitFor();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.getByRole('button', { name: 'Read tablet state' }).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(34, 77, 64)');
  }
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'Disconnected', exact: true }).waitFor();
  assert.equal(await page.getByTestId('tablet-model').count(), 0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
}
const browser = await chromium.launch();
const helper = await startHelper({ root: path.resolve('dist/manager/browser'), observer: { observe: async () => fixture,
  cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) } });
try {
  const context = await browser.newContext();
  await isolate(context, helper.origin);
  const page = await context.newPage();
  await page.goto(helper.origin + '/preview/');
  await verify(page, 'observed');
  await page.screenshot({ path: 'test-results/wired-browser.png', fullPage: true });
} finally { await browser.close(); await helper.close(); }
{
  const python = path.join(root, 'fixture-python');
  await writeFile(python, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(fixture))});\n`);
  await chmod(python, 0o700);
  const executablePath = packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined;
  const app = await electron.launch({ executablePath, args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: { ...process.env, MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: root,
    MANAGER_WIRED_CONFIG: path.join(root, 'fixture-config'), MANAGER_WIRED_PYTHON: python } });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(page.url(), 'about:blank');
    await isolate(app.context());
    await app.evaluate(async ({ app, BrowserWindow }) => {
      await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`);
    });
    await verify(page, process.platform === 'linux' ? 'observed' : 'unsupported-host');
    const host = await page.evaluate(() => ({ contract: window.managerHost.contract_version, keys: Object.keys(window.managerHost) }));
    assert.equal(host.contract, 1);
    assert.deepEqual(host.keys.sort(), ['cancel', 'contract_version', 'kind', 'observe', 'transport']);
  } finally { await app.close(); }
}
await rm(root, { recursive: true });
console.log(`Shared helper/browser and ${packaged ? 'packaged ' : ''}Electron state path verified with explicit fixtures; native tablet adapter ${process.platform === 'linux' ? 'fixture observed' : 'unsupported'}`);
