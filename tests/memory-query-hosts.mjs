import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { report, reply, tablet } from './fixtures/memory-query.mjs';
import { validMemoryText } from '../host/memory-query.mjs';

const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-memory-ui-'));
await mkdir('test-results', { recursive: true });
let state = 'complete', releasePending;
const respond = async q => {
  assert.equal(Object.keys(q).sort().join(), 'boot_id,connection_id,text');
  if (state === 'delayed') { await new Promise(resolve => { releasePending = resolve; }); return reply(report()); }
  if (state === 'invalid-input' || state === 'busy') return reply({ report_version: 1, operation: 'query', status: state, incomplete: false, data: null });
  if (state === 'future') return reply({ ...report(), report_version: 2 });
  return reply(report(state));
};
async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://api.github.com/repos/s116821/')) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    if (url.startsWith('file:') || (origin && new URL(url).origin === origin)) return route.continue();
    return route.abort();
  });
}
async function verify(page, setState, capture, release, waitRefresh, hostState) {
  await page.getByRole('button', { name: 'Read tablet state', exact: true }).click(); await page.getByTestId('tablet-model').waitFor();
  const input = page.getByLabel('Search memory', { exact: true }); const search = page.getByRole('button', { name: 'Search global memory', exact: true });
  const samples=[];
  await input.evaluate(el=>{globalThis.memoryInputEvents=[];el.addEventListener('input',()=>{globalThis.memoryInputEvents.push({time:Date.now(),characters:el.value.length,bytes:new TextEncoder().encode(el.value).length});});});
  async function snapshot(phase){const value=await input.inputValue();samples.push({phase,time:Date.now(),connection:await page.locator('#connection-title').textContent(),modelPresent:await page.getByTestId('tablet-model').count(),status:await page.getByTestId('memory-status').textContent(),disabled:await search.isDisabled(),characters:value.length,bytes:new TextEncoder().encode(value).length,validInput:validMemoryText(value),host:await hostState(),inputEvents:await page.evaluate(()=>globalThis.memoryInputEvents)});}
  async function clickSearch(mode){await snapshot(`before:${mode}`);try{await search.click();}catch(error){await snapshot(`failed:${mode}`);console.error('Memory-query fixture state:',JSON.stringify(samples));throw error;}}

  await input.fill('gravity 第二行 🦊'); await clickSearch('complete'); await expect(page.getByTestId('memory-fact')).toHaveCount(1);
  await expect(page.getByTestId('memory-fact')).toContainText('Explicit fixture assertion');
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#memory-title').scrollIntoViewIfNeeded(); await snapshot('before-capture'); await capture(); await snapshot('after-capture');
  for (const [mode, label] of [['partial', 'Partial results'], ['complete-empty', 'no matching global facts'], ['disabled', 'Subject memory disabled'], ['busy', 'Memory query busy'], ['unavailable', 'Subject memory unavailable'], ['invalid-input', 'input unsupported'], ['future', 'report version unsupported']]) {
    await setState(mode); await clickSearch(mode); await expect(page.getByTestId('memory-status')).toContainText(label);
    if (mode !== 'partial') await expect(page.getByTestId('memory-fact')).toHaveCount(0);
  }
  await input.fill('🦊'.repeat(513)); await expect(search).toBeDisabled(); await input.fill('gravity');
  await setState('delayed'); await clickSearch('delayed'); await expect(page.getByRole('button', { name: 'Cancel search', exact: true })).toBeEnabled(); await waitRefresh(); await expect(page.getByRole('button', { name: 'Cancel search', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Cancel search', exact: true }).click();
  await expect(page.getByTestId('memory-status')).toHaveText('Search cancelled');
  await release(); await page.waitForTimeout(100); await expect(page.getByTestId('memory-fact')).toHaveCount(0);
  await setState('complete'); await clickSearch('complete-after-cancel'); await expect(page.getByTestId('memory-fact')).toHaveCount(1);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(page.getByTestId('memory-fact')).toHaveCount(0); await expect(search).toBeDisabled();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
}
// Keep later automatic observation reads pending in this semantic UI fixture.
// Otherwise a real four-second refresh can clear the deliberately delayed query
// between Playwright's enabled assertion and cancellation click. Actual polling
// invalidation remains covered by observation.test.mjs; no product guard changes.
let observationReads = 0;
const helper = await startHelper({ root: path.resolve('dist/manager/browser'), observer: { observe: async () => ++observationReads === 1 ? ({ contract_version: 1, status: 'observed', observation: tablet }) : new Promise(() => {}), memoryQuery: respond, cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) }, driveAuth: { dispose() {} } });
const browser = await chromium.launch();
try {
  const context = await browser.newContext(); await isolate(context, helper.origin); const page = await context.newPage(); await page.goto(helper.origin + '/preview/');
  await verify(page, async v => { state = v; }, () => page.screenshot({ path: 'test-results/memory-query-browser.png', fullPage: true }), async () => { releasePending(); }, () => expect.poll(() => observationReads, {timeout:7000}).toBeGreaterThan(1),async()=>({observationReads,mode:state}));
  console.log('browser synthetic global-memory status/provenance/UTF8/cancel/disconnect/390+1280 pass; no backend or physical qualification');
} finally { await browser.close(); await helper.close(); }
const packaged = process.argv.includes('--packaged');
const app = await electron.launch({ executablePath: packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined,
  args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: { ...process.env, MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: folder } });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  await app.evaluate(async ({ app, BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`));
  assert.equal(await page.evaluate(() => window.managerHost.memoryQuery({ path: '/arbitrary' }).then(() => 'accepted', () => 'refused')), 'refused');
  if (packaged) {
    const resources = await app.evaluate(() => process.resourcesPath);
    assert.deepEqual(await readFile(path.join(resources, 'host/memory_query_transport.py')), await readFile('host/memory_query_transport.py'));
    const child = spawnSync(process.env.MANAGER_WIRED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [path.join(resources, 'host/memory_query_transport.py')], { input: 'PRIVATE_QUERY_CANARY', encoding: 'utf8', timeout: 3000 });
    assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.equal(child.stdout.includes('PRIVATE_QUERY_CANARY'), false);
  }
  await app.evaluate(({ ipcMain }, fixture) => {
    globalThis.memoryMode = 'complete'; globalThis.memoryFixture = fixture;globalThis.memoryObservationReads=0;
    ipcMain.removeHandler('manager:observe'); ipcMain.handle('manager:observe', () => ++globalThis.memoryObservationReads===1 ? ({ contract_version: 1, status: 'observed', observation: fixture.tablet }) : new Promise(() => {}));
    ipcMain.removeHandler('manager:memoryQuery'); ipcMain.handle('manager:memoryQuery', async (_event, q) => {
      if (Object.keys(q).sort().join() !== 'boot_id,connection_id,text') throw Error('Unexpected input');
      const mode = globalThis.memoryMode; const v = structuredClone(globalThis.memoryFixture.reply);
      if (mode === 'delayed') await new Promise(resolve => { globalThis.memoryRelease = resolve; });
      else if (mode === 'future') v.memory_query.report.report_version = 2;
      else if (['invalid-input', 'busy'].includes(mode)) v.memory_query.report = { report_version: 1, operation: 'query', status: mode, incomplete: false, data: null };
      else { const r = v.memory_query.report; r.status = ['partial', 'unavailable'].includes(mode) ? mode : 'ok'; r.incomplete = ['partial', 'unavailable'].includes(mode); r.data.query_status = mode; if (!['complete', 'partial'].includes(mode)) r.data.context.facts = []; }
      return v;
    });
  }, { tablet, reply: reply(report()) });
  await verify(page, v => app.evaluate((_electron, v) => { globalThis.memoryMode = v; }, v), async () => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    const { writeFile } = await import('node:fs/promises'); await writeFile(`test-results/memory-query-desktop${packaged ? '-packaged' : ''}.png`, Buffer.from(png, 'base64'));
  }, () => app.evaluate(() => { globalThis.memoryRelease(); globalThis.memoryRelease = null; }), () => expect.poll(() => app.evaluate(() => globalThis.memoryObservationReads), {timeout:7000}).toBeGreaterThan(1),()=>app.evaluate(()=>({observationReads:globalThis.memoryObservationReads,mode:globalThis.memoryMode})));
  console.log(`${packaged ? 'packaged ' : ''}Electron actual invalid-input/resource refusal and synthetic memory IPC/UI pass; no live tablet/provider proof`);
} finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
