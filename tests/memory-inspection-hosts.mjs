import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { reduceMemoryInspectionResult } from '../host/memory-inspection.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { envelope, report, privateReply, query, tablet, request } from './fixtures/memory-inspection.mjs';
import { reply as queryReply } from './fixtures/memory-query.mjs';
const packaged = process.argv.includes('--packaged');
const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-memory-inspection-ui-'));
await mkdir('test-results', { recursive: true });
const raw = {
  conflict: report([envelope(), envelope(2, 'tombstone')]), value: report(), empty: report([]), tombstone: report([envelope(2, 'tombstone')]),
  selectedRefusal: { ...report(), status: 'unavailable', incomplete: true, data: null },
  busy: { ...report(), status: 'busy', incomplete: false, data: null },
  unsupported: { ...report(), status: 'unsupported', incomplete: false, data: null },
};
const variants = {};
for (const [name, r] of Object.entries(raw)) variants[name] = await reduceMemoryInspectionResult(privateReply(r), request(), validateResult);
let state = 'conflict', releasePending;
const respond = async q => {
  assert.deepEqual(q, request());
  if (state === 'delayed') { await new Promise(resolve => { releasePending = resolve; }); return variants.conflict; }
  return state === 'raw' ? privateReply(raw.conflict) : variants[state];
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
  const read = page.getByRole('button', { name: 'Inspect current revisions', exact: true });
  const status = page.getByTestId('memory-inspection-status');
  const heads = page.getByTestId('memory-head');
  const search = page.getByRole('button', { name: 'Search global memory', exact: true });
  await page.getByRole('button', { name: 'Read tablet state', exact: true }).click(); await page.getByTestId('tablet-model').waitFor();
  await page.locator('#memory-query').fill('gravity'); await search.click();
  await expect(page.getByTestId('memory-status')).toHaveText('Search complete'); await read.waitFor();
  await read.click(); await expect(status).toContainText('Conflict — 2 current revisions'); await expect(heads).toHaveCount(2); await expect(heads.nth(1)).toContainText('Deletion record');
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#memory-inspection-title').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await capture();
  for (const [name, label, count] of [['value', 'Current fact revision inspected', 1], ['tombstone', 'Current fact revision inspected', 1], ['empty', 'No current heads for this fact', 0], ['selectedRefusal', 'unavailable', 0], ['busy', 'busy', 0], ['unsupported', 'unsupported', 0], ['raw', 'response refused', 0]]) {
    await setState(name); await read.click(); await expect(status).toContainText(label); await expect(heads).toHaveCount(count);
  }
  await setState('delayed'); await read.click(); await page.getByRole('button', { name: 'Cancel fact inspection', exact: true }).click();
  await release(); await expect(status).toHaveText('Memory inspection cancelled'); await expect(heads).toHaveCount(0);
  await setState('conflict'); await read.click(); await expect(heads).toHaveCount(2);
  await search.click(); await expect(heads).toHaveCount(0); await read.waitFor();
  await setState('delayed'); await read.click(); await page.getByRole('button', { name: 'Read tablet state', exact: true }).click(); await page.getByTestId('tablet-model').waitFor();
  await release(); await expect(heads).toHaveCount(0); await expect(status).toContainText('Select a search result');
  await setState('conflict'); await search.click(); await read.waitFor(); await read.click(); await expect(heads).toHaveCount(2);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(heads).toHaveCount(0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
}
const helper = await startHelper({ root: path.resolve(packaged ? 'dist/manager/browser' : 'test-results/development/browser'),
  observer: { observe: async () => ({ contract_version: 1, status: 'observed', observation: tablet }), memoryQuery: async () => queryReply(query()), inspectMemory: respond, cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) },
  driveAuth: { dispose() {}, status: async () => ({ contract_version: 1, status: 'unconfigured', account: null, checkedAt: null, error: null, authorizationId: null, backupReady: false }) }, downloads: { dispose() {}, request: async () => { throw Error('Fixture unavailable'); } } });
const browser = await chromium.launch();
try {
  const context = await browser.newContext(); await isolate(context, helper.origin); const page = await context.newPage(); await page.goto(helper.origin+'/preview/');
  await verify(page, async v => { state = v; }, () => page.locator('section[aria-labelledby="memory-inspection-title"]').screenshot({ path: `test-results/memory-inspection-browser${packaged ? '' : '-development'}.png` }), async () => { releasePending(); });
  console.log(`${packaged ? 'retained production' : 'development'} browser memory inspection all-heads/tombstones/empty/selected refusal/cancel/refresh/new-search pass; reports/routes are fixtures`);
} finally { await browser.close(); await helper.close(); }
const environment = { ...process.env };
for (const name of Object.keys(environment)) if (name.startsWith('MANAGER_')) delete environment[name];
Object.assign(environment, { MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: folder });
const app = await electron.launch({ executablePath: packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined,
  args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: environment });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  await app.evaluate(({ app }, fixture) => {
    const require = process.mainModule.require.bind(process.mainModule); const path = require('node:path');
    const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(app.getAppPath(), 'host');
    const { WiredObserver } = require(path.join(hostRoot, 'observer.mjs'));
    globalThis.memoryInspectionState = 'conflict'; globalThis.memoryInspectionFixture = fixture;
    WiredObserver.prototype.observe = async () => ({ contract_version: 1, status: 'observed', observation: fixture.tablet });
    WiredObserver.prototype.memoryQuery = async () => structuredClone(fixture.query);
    WiredObserver.prototype.inspectMemory = async q => {
      if (JSON.stringify(q) !== JSON.stringify(fixture.request)) throw Error('Unexpected input');
      const state = globalThis.memoryInspectionState;
      if (state === 'delayed') { await new Promise(resolve => { globalThis.memoryInspectionRelease = resolve; }); return structuredClone(fixture.variants.conflict); }
      return structuredClone(state === 'raw' ? fixture.private : fixture.variants[state]);
    };
  }, { tablet, request: request(), variants, private: privateReply(raw.conflict), query: queryReply(query()) });
  await app.evaluate(async ({ app, BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`));
  // As in the existing host suite, permit the isolated desktop to paint/scroll before Playwright input.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  for (const expression of ['window.managerHost.inspectMemory({path:"/arbitrary"})', 'window.managerHost.inspectMemory({}, {})', 'window.managerHost.inspectMemory()']) assert.equal(await page.evaluate(expression+'.then(()=>"accepted",()=>"refused")'), 'refused');
  if (packaged) {
    const resources = await app.evaluate(() => process.resourcesPath);
    for (const file of ['memory_inspection_transport.py', 'memory-inspection.mjs']) assert.deepEqual(await readFile(path.join(resources, 'host', file)), await readFile(path.join('host', file)));
    const child = spawnSync(process.env.MANAGER_WIRED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [path.join(resources, 'host/memory_inspection_transport.py')], { input: 'PRIVATE_INPUT_CANARY', encoding: 'utf8', timeout: 3000 });
    assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.equal(child.stdout.includes('PRIVATE_INPUT_CANARY'), false);
  }
  await verify(page, v => app.evaluate((_electron, v) => { globalThis.memoryInspectionState = v; }, v), async () => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await writeFile(`test-results/memory-inspection-desktop${packaged ? '-packaged' : ''}.png`, Buffer.from(png, 'base64'));
  }, () => app.evaluate(() => { globalThis.memoryInspectionRelease(); globalThis.memoryInspectionRelease = null; }));
  console.log(`${packaged ? 'retained packaged' : 'source'} Electron actual IPC arity/raw-private refusal and memory inspection UI pass; only transport methods/reports substituted`);
} finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
