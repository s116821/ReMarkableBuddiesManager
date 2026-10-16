import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { tablet } from './fixtures/owned-report.mjs';
const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-personalization-ui-'));
await mkdir('test-results', { recursive: true });
const initial = { schema_version: 1, enabled: false, text: 'Synthetic preference\r\nSecond line 🦊\n ' };
let saved = { ...initial }, failure = null;
const inspect = () => ({ contract_version: 1, status: 'observed', observation: tablet });
const respond = q => {
  if (q.operation !== 'inspect') assert.equal(q.expected_config_sha256, 'c'.repeat(64));
  if (!failure) {
    if (q.operation === 'set') saved = { schema_version: 1, enabled: q.enabled, text: q.text };
    if (q.operation === 'disable') saved.enabled = false;
    if (q.operation === 'clear') saved = { schema_version: 1, enabled: false, text: '' };
  }
  return { ...inspect(), personalization: { status: 'reported', outcome: q.operation === 'inspect' ? 'read-only' : failure ? 'unknown' : 'verified', report: {
    report_version: 1, operation: q.operation, status: failure ?? 'ok', disk_reload_verified: !failure,
    runtime_activation: failure || q.operation === 'inspect' ? 'unverified' : 'restart-required',
    config_sha256: failure ? null : 'c'.repeat(64), personalization: failure ? null : { ...saved } } } };
};
async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://api.github.com/repos/s116821/')) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    if (url.startsWith('file:') || (origin && new URL(url).origin === origin)) return route.continue();
    return route.abort();
  });
}
async function verify(page, setFailure, capture, readSaved) {
  await page.getByRole('button', { name: 'Read tablet state', exact: true }).click(); await page.getByTestId('tablet-model').waitFor();
  const read = page.getByRole('button', { name: 'Read personalization', exact: true }); await read.click();
  const status = page.getByTestId('personalization-status'); await status.filter({ hasText: 'activation unverified' }).waitFor();
  const field = page.getByLabel('Response preference', { exact: true }); assert.equal(await field.inputValue(), initial.text.replace(/\r\n/g, '\n'));
  await page.getByLabel('Enable this preference').check();
  await page.getByRole('button', { name: 'Save preference', exact: true }).click(); await status.filter({ hasText: 'restart required' }).waitFor();
  assert.equal((await readSaved()).text, initial.text);
  await field.evaluate(el => { el.selectionStart = el.selectionEnd = el.value.length; const data = new DataTransfer(); data.setData('text/plain', '\r\n Pasted 🦊\r\n '); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  await page.getByRole('button', { name: 'Save preference', exact: true }).click(); await status.filter({ hasText: 'restart required' }).waitFor();
  assert.match(await field.inputValue(), /Pasted 🦊/);
  await expect.poll(async () => (await readSaved()).text).toBe(initial.text + '\r\n Pasted 🦊\r\n ');
  await page.getByRole('button', { name: 'Disable saved preference', exact: true }).click(); await status.filter({ hasText: 'restart required' }).waitFor();
  await expect(page.getByLabel('Enable this preference')).not.toBeChecked(); assert.match(await field.inputValue(), /Pasted/);
  for (const width of [390,1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#personalization-title').scrollIntoViewIfNeeded(); await capture();
  await setFailure('conflict'); await page.getByRole('button', { name: 'Save preference', exact: true }).click(); await status.filter({ hasText: 'conflict' }).waitFor(); assert.equal(await field.count(),0);
  await setFailure(null); await read.click(); await status.filter({ hasText: 'activation unverified' }).waitFor();
  await setFailure('busy'); await page.getByRole('button', { name: 'Save preference', exact: true }).click(); await status.filter({ hasText: 'busy' }).waitFor();
  await setFailure(null); await read.click(); await status.filter({ hasText: 'activation unverified' }).waitFor();
  await page.getByRole('button', { name: 'Clear saved preference', exact: true }).click(); await status.filter({ hasText: 'restart required' }).waitFor(); await expect(field).toHaveValue('');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page.getByRole('heading', { name: 'Disconnected', exact: true }).waitFor(); assert.equal(await field.count(),0); assert.equal(await read.isDisabled(),true);
  assert.equal(await page.evaluate(() => typeof window.require),'undefined'); assert.equal(await page.evaluate(() => typeof window.process),'undefined');
}
const helper = await startHelper({ root: path.resolve('dist/manager/browser'), observer: { observe: async () => inspect(), personalization: async q => respond(q), cancel: () => ({ contract_version: 1, status: 'cancelled', observation: null }) }, driveAuth: { status: async () => ({ contract_version: 1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false }), dispose() {} } });
const browser = await chromium.launch();
try {
  const context = await browser.newContext(); await isolate(context, helper.origin); const page = await context.newPage(); await page.goto(helper.origin+'/preview/');
  await verify(page, async v => { failure=v; }, () => page.screenshot({ path:'test-results/personalization-browser.png',fullPage:true }), async () => saved);
  console.log('browser synthetic configuration UI: inspect/exact text/paste/save/disable/clear/conflict/disconnect/390+1280 pass');
} finally { await browser.close(); await helper.close(); }
const packaged = process.argv.includes('--packaged');
const app = await electron.launch({ executablePath: packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined,
  args:[...(packaged?[]:['.']),...(process.platform==='linux'?['--disable-gpu']:[])],env:{...process.env,MANAGER_TEST:'1',MANAGER_TEST_DEFER_LOAD:'1',MANAGER_TEST_PROFILE:folder} });
try {
  const page=await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  await app.evaluate(async ({app,BrowserWindow}) => BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`));
  assert.equal(await page.evaluate(() => window.managerHost.personalization({operation:'inspect',path:'/arbitrary'}).then(()=>'accepted',()=> 'refused')),'refused');
  await app.evaluate(({ipcMain},fixture)=>{
    ipcMain.removeHandler('manager:observe'); ipcMain.handle('manager:observe',()=>({contract_version:1,status:'observed',observation:fixture.tablet}));
    globalThis.preference={...fixture.initial};globalThis.preferenceFailure=null;
    ipcMain.removeHandler('manager:personalization');ipcMain.handle('manager:personalization',(_event,q)=>{
      const failure=globalThis.preferenceFailure;
      if(!failure){if(q.operation==='set')globalThis.preference={schema_version:1,enabled:q.enabled,text:q.text};if(q.operation==='disable')globalThis.preference.enabled=false;if(q.operation==='clear')globalThis.preference={schema_version:1,enabled:false,text:''};}
      return {contract_version:1,status:'observed',observation:fixture.tablet,personalization:{status:'reported',outcome:q.operation==='inspect'?'read-only':failure?'unknown':'verified',report:{report_version:1,operation:q.operation,status:failure??'ok',disk_reload_verified:!failure,runtime_activation:failure||q.operation==='inspect'?'unverified':'restart-required',config_sha256:failure?null:'c'.repeat(64),personalization:failure?null:{...globalThis.preference}}}};
    });
  },{tablet,initial});
  await verify(page,v=>app.evaluate((_electron,v)=>{globalThis.preferenceFailure=v;},v),async()=>{
    const png=await app.evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('Empty native image');return image.toPNG().toString('base64');});
    await writeFile(`test-results/personalization-desktop${packaged?'-packaged':''}.png`,Buffer.from(png,'base64'));
  }, () => app.evaluate(() => globalThis.preference));
  console.log(`${packaged?'packaged ':''}Electron synthetic configuration UI and actual invalid-argument refusal pass; no live tablet/runtime activation proof`);
} finally {await app.close();await rm(folder,{recursive:true,force:true});}
