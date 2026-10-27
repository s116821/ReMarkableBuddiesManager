import { chromium, _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { ownedReport, tablet, inspection, feedbackReportVectors } from './fixtures/owned-report.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'manager-owned-ui-'));
await mkdir('test-results', { recursive: true });
const api = 'https://api.github.com/repos/s116821/ReMarkableBuddies/releases/latest';
async function isolate(context, localOrigin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === api || url === 'https://api.github.com/repos/s116821/ReMarkableBuddiesManager/releases/latest') return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    if (url.startsWith('file:') || (localOrigin && new URL(url).origin === localOrigin)) return route.continue();
    return route.abort();
  });
}
async function verify(page, publish, host) {
  const button = page.getByRole('button', { name: 'Inspect owned data', exact: true });
  assert.equal(await button.isDisabled(), true);
  const read = async () => {
    await page.getByRole('button', { name: 'Read tablet state', exact: true }).click();
    await page.getByTestId('tablet-model').waitFor();
    await page.getByTestId('inspection-status').filter({ hasText: /^Not inspected$/ }).waitFor();
  };
  const check = async (value, expected) => {
    await publish(value); await read(); await button.click();
    await page.getByTestId('inspection-status').filter({ hasText: expected }).waitFor();
  };
  await check(inspection(ownedReport()), /^Inspection partial$/);
  assert.equal(await page.getByTestId('observed-bytes').textContent(), '1,024 bytes');
  assert.match(await page.getByTestId('complete-bytes').textContent(), /inventory incomplete/);
  assert.match(await page.getByTestId('storage-cache').textContent(), /Not inspected/);
  const conversation = page.getByTestId('domain-conversation');
  for (const label of ['Missing references', 'Uninspected references', 'Omitted references', 'Size mismatches']) assert.equal(await conversation.getByText(label, { exact: true }).count(), 1);
  assert.match(await page.getByText(/Their totals cannot be added together/).textContent(), /1 shared media files/);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: `test-results/owned-${host}-partial.png`, fullPage: true });
  await check(inspection(ownedReport('complete')), /^Inspection complete$/);
  assert.equal(await page.getByTestId('complete-bytes').textContent(), '1,024 bytes');
  await check(inspection(feedbackReportVectors.feedback3), /^Inspection complete$/);
  const feedback = page.getByTestId('domain-unassociated-feedback');
  assert.match(await feedback.textContent(), /1 observed records · 128 bytes/);
  assert.equal(await feedback.getByRole('button').count(), 0);
  assert.match(await feedback.textContent(), /Historical observations only/);
  assert.match(await page.getByTestId('generation-formats').textContent(), /current storage format: 3/);
  assert.match(await page.getByTestId('generation-formats').textContent(), /retained storage formats: 1/);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: `test-results/owned-${host}-report2.png`, fullPage: true });
  const sparse = { ...feedbackReportVectors.invalid_feature3, current_generation_format: null,
    retained_generation_formats: [], observed_domains: {}, issues: { 'unsupported-generation': 1 } };
  await check(inspection(sparse), /^Inspection partial$/);
  assert.match(await feedback.textContent(), /Not inspected \/ no category observation/);
  assert.doesNotMatch(await feedback.textContent(), /0 observed records/);
  assert.match(await page.getByTestId('generation-formats').textContent(), /Not inspected \/ unknown/);
  assert.match(await page.getByTestId('complete-bytes').textContent(), /inventory incomplete/);
  await check(inspection({ ...feedbackReportVectors.feedback3, observed_domains: {} }), /^Owned-data report unavailable$/);
  assert.equal(await feedback.count(), 0);
  await check(inspection(ownedReport('complete')), /^Inspection complete$/);
  assert.equal(await feedback.count(), 0);
  assert.equal(await page.getByTestId('generation-formats').count(), 0);
  await check(inspection(ownedReport('busy')), /^Inspection busy$/);
  await page.getByText(/No service was stopped/).waitFor();
  for (const status of ['unavailable', 'unsupported']) await check(inspection(ownedReport(status)), new RegExp(`^Inspection ${status}$`));
  await check({ ...inspection(null), inspection: { status: 'unsupported', report: null } }, /^Installed Buddy inspection unsupported$/);
  assert.equal(await page.getByTestId('observed-bytes').count(), 0);
  await check(inspection({ ...ownedReport(), report_version: 99 }), /unsupported$/);
  await check(inspection({ ...ownedReport(), password: 'PROTECTED_SENTINEL' }), /^Owned-data report unavailable$/);
  assert.equal(await page.getByText('PROTECTED_SENTINEL').count(), 0);
  await check({ ...inspection(ownedReport()), observation: { ...tablet, boot_id: '22222222-2222-2222-2222-222222222222' } }, /read tablet state again/);
  assert.equal(await page.getByTestId('observed-bytes').count(), 0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'Disconnected', exact: true }).waitFor();
  assert.equal(await button.isDisabled(), true);
  assert.equal(await page.getByTestId('inspection-status').textContent(), 'Not inspected');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  console.log(`${host}: report1/report2-complete/sparse/readonly/formats/partial/busy/unavailable/unsupported/future/malformed/session-change/disconnect and 390/1280 layout pass`);
}
let value = inspection(ownedReport());
const browser = await chromium.launch();
const helper = await startHelper({ root: path.resolve('dist/manager/browser'), observer: {
  observe: async () => ({ contract_version: 1, status: 'observed', observation: tablet }),
  inspectOwned: async () => value, cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) } });
try {
  const context = await browser.newContext(); await isolate(context, helper.origin);
  const page = await context.newPage(); await page.goto(helper.origin + '/preview/');
  await verify(page, async v => { value = v; }, 'browser');
} finally { await browser.close(); await helper.close(); }
const runtime = path.join(root, 'runtime');
const payload = path.join(root, 'payload.json');
await writeFile(runtime, `#!${process.execPath}\nconst fs = require('node:fs');\nconsole.log(JSON.stringify(process.argv.includes('inspect-owned') ? JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8')) : ${JSON.stringify({ contract_version: 1, status: 'observed', observation: tablet })}));\n`);
await chmod(runtime, 0o700);
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined;
const app = await electron.launch({ executablePath, args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: { ...process.env, MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: root,
  MANAGER_WIRED_CONFIG: path.join(root, 'config'), MANAGER_WIRED_PYTHON: process.platform === 'win32' ? process.env.MANAGER_WIRED_PYTHON : runtime } });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  await app.evaluate(async ({ app, BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`); });
  if (process.platform === 'linux') await verify(page, v => writeFile(payload, JSON.stringify(v)), packaged ? 'desktop-packaged' : 'desktop');
  else {
    await page.getByRole('button', { name: 'Read tablet state', exact: true }).click();
    await page.getByRole('heading', { name: 'Not configured', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Inspect owned data' }).isDisabled(), true);
    // Test-only substitution of main-process IPC responses exercises the actual
    // sandbox/preload/shared renderer; it is NOT native Windows USB evidence.
    await app.evaluate(({ ipcMain }, observed) => {
      ipcMain.removeHandler('manager:observe');
      ipcMain.removeHandler('manager:inspectOwned');
      ipcMain.handle('manager:observe', () => observed);
      ipcMain.handle('manager:inspectOwned', () => globalThis.ownedUiFixture);
    }, { contract_version: 1, status: 'observed', observation: tablet });
    await verify(page, v => app.evaluate((_electron, value) => { globalThis.ownedUiFixture = value; }, v), packaged ? 'desktop-windows-IPC-packaged' : 'desktop-windows-IPC');
    console.log('Windows: actual Python/config refusal plus explicit IPC renderer fixtures; no physical USB qualification');
  }
} finally { await app.close(); await rm(root, { recursive: true }); }
