import {chromium, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {startHelper} from '../host/browser-helper.mjs';
import {modelFixture, defer} from './fixtures/model-settings.mjs';
import {showPanel, readTabletFor} from './fixtures/navigation.mjs';

// Actual shared renderer and guarded browser helper; tablet reports are synthetic.
const fixture = modelFixture();
const helper = await startHelper({root:path.resolve('dist/manager/browser'), observer:fixture.observer,
  driveAuth:{dispose(){}, status:async()=>({contract_version:1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false})},
  downloads:{dispose(){},request:async()=>{throw Error('Synthetic download unavailable');}},
});
await mkdir('test-results', {recursive:true});
const browser = await chromium.launch();
try {
  const context = await browser.newContext({viewport:{width:1280,height:1000},serviceWorkers:'block'});
  const errors = [], unexpected = [];
  await context.route('**/*', route => {
    const url=route.request().url();
    if(url.startsWith('https://api.github.com/repos/s116821/')) return route.fulfill({status:404,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'});
    if(new URL(url).origin===helper.origin) return route.continue();
    unexpected.push(url); return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(helper.origin+'/preview/');
  await expect(page.getByRole('heading',{level:1,name:'Tablet',exact:true})).toBeVisible();
  await expect(page.locator('#model-settings-title')).toHaveCount(0);
  await expect(page.locator('#memory-title')).toHaveCount(0);
  await expect(page.getByText('Coming in a later release',{exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/navigation-tablet.png',fullPage:true});
  const before=fixture.calls.length;
  for(const panel of ['setup','product','model','research','personalization','memory-settings','shared','portable','conversations','memory','handwriting','storage','drive','mode','backup-setup','cloud','notebook','configuration','basic','runtime']) {
    await showPanel(page,panel);
    await expect(page.locator('.workspace h1')).toBeVisible();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,panel);
  }
  assert.equal(fixture.calls.length,before,'navigation dispatches no tablet operations');
  await readTabletFor(page,'model');
  const edit=page.getByRole('button',{name:'Edit model',exact:true});
  const save=page.getByRole('button',{name:'Save model',exact:true});
  await edit.click();await expect(page.locator('#model-action-model')).toBeVisible();
  await page.getByLabel('Configure a custom endpoint',{exact:true}).check();
  await page.locator('#model-action-base_url').selectOption('replace');
  await page.locator('#model-replacement-base_url').fill('https://PRIVATE_ENDPOINT.invalid');
  await expect(save).toBeEnabled();
  await page.getByLabel('Configure a custom endpoint',{exact:true}).uncheck();
  await expect(page.locator('#model-replacement-base_url')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByLabel('Configure a custom endpoint',{exact:true}).check();
  await expect(page.locator('#model-action-base_url')).toHaveValue('keep');
  await page.locator('#model-action-model').selectOption('replace');
  await page.locator('#model-replacement-model').fill('PRIVATE_MODEL_DRAFT');
  await showPanel(page,'research');await showPanel(page,'model');
  await expect(page.locator('#model-replacement-model')).toHaveCount(0);
  await expect(save).toBeDisabled();
  assert.equal((await page.textContent('body')).includes('PRIVATE_MODEL_DRAFT'),false);
  await edit.click();await page.locator('#model-action-model').selectOption('replace');
  await page.locator('#model-replacement-model').fill('synthetic-model');
  const gate=defer();let entered=false;
  fixture.modelState.onApply=async()=>{entered=true;await gate.promise;throw Error('Synthetic lost acknowledgement');};
  await save.click();await expect.poll(()=>entered).toBe(true);
  const pendingCalls=fixture.calls.length;
  await showPanel(page,'drive');
  await expect(page.locator('.activity-tray')).toContainText('Model connection');
  assert.equal(fixture.calls.length,pendingCalls,'navigation does not replay a pending write');
  gate.resolve();
  await page.locator('.activity-tray > summary').click();
  await expect(page.getByRole('button',{name:'Model connection · Review results',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Model connection · Review results',exact:true}).click();
  await expect(page.getByTestId('model-settings-retained')).toHaveCount(1);
  assert.equal(fixture.calls.length,pendingCalls,'returning to unknown results does not retry');
  for(const [panel,name] of [['model','settings'],['memory','data'],['notebook','archives'],['drive','account'],['setup','setup'],['shared','shared'],['backup-setup','backup-setup'],['cloud','cloud']]) {
    await showPanel(page,panel);
    await page.screenshot({path:`test-results/navigation-${name}.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);
    await page.screenshot({path:`test-results/navigation-${name}-390.png`,fullPage:true});
    await page.setViewportSize({width:1280,height:1000});
  }
  await showPanel(page,'product');await page.getByRole('button',{name:'Edit trigger corner',exact:true}).click();
  await expect(page.locator('#basic-trigger_corner')).toBeVisible();
  await expect(page.locator('#basic-log_level')).toHaveCount(0);
  await showPanel(page,'basic');
  await expect(page.locator('#basic-trigger_corner')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Save diagnostic settings',exact:true})).toBeDisabled();
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log('Actual navigation, lazy rendering, private draft clearing, pending/unknown recovery and responsive screenshots passed; lower tablet reports synthetic.');
} finally { await browser.close(); await helper.close(); }
