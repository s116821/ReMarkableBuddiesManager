import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { tablet } from './fixtures/owned-report.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'manager-runtime-ui-'));await mkdir('test-results',{recursive:true});
const identity=status=>({report_version:1,status,binary_version:status==='reported'?'0.1.4-dev-synthetic':null,package_owner:'unknown',provenance:'unknown',running_version:null,installation_eligible:false});
const observed=()=>({contract_version:1,status:'observed',observation:tablet});let value={...observed(),runtime_identity:identity('reported')};
async function isolate(context,origin){await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('https://api.github.com/repos/s116821/'))return route.fulfill({status:404,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'});if(url.startsWith('file:')||(origin&&new URL(url).origin===origin))return route.continue();return route.abort();});}
async function verify(page,publish,capture){
 const button=page.getByRole('button',{name:'Read binary version',exact:true});assert.equal(await button.isDisabled(),true);
 await page.getByRole('button',{name:'Read tablet state',exact:true}).click();await page.getByTestId('tablet-model').waitFor();await button.click();
 const status=page.getByTestId('runtime-identity-status');await status.filter({hasText:'reported — unverified'}).waitFor();await expect(page.getByTestId('runtime-binary-version')).toHaveText('0.1.4-dev-synthetic');
 assert.match(await page.getByTestId('installed-version').textContent(),/provenance not verified/);assert.equal(await page.getByRole('button',{name:'Install unavailable'}).isDisabled(),true);
 for(const width of[390,1280]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.locator('#runtime-title').scrollIntoViewIfNeeded();await capture();
 for(const state of['missing','unsafe','unsupported']){await publish({...observed(),runtime_identity:identity(state)});await button.click();await status.filter({hasText:`identity ${state}`}).waitFor();assert.equal(await page.getByTestId('runtime-binary-version').count(),0);}
 await publish({...observed(),runtime_identity:{...identity('reported'),secret:'PRIVATE_SENTINEL'}});await button.click();await status.filter({hasText:'unavailable or unsupported'}).waitFor();assert.equal(await page.getByText('PRIVATE_SENTINEL').count(),0);
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('heading',{name:'Disconnected',exact:true}).waitFor();assert.equal(await button.isDisabled(),true);assert.equal(await page.getByTestId('runtime-binary-version').count(),0);
 assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.process),'undefined');
}
const browser=await chromium.launch();const helper=await startHelper({root:path.resolve('dist/manager/browser'),observer:{observe:async()=>observed(),inspectRuntime:async()=>value,cancel:()=>({contract_version:1,status:'cancelled',observation:null})},driveAuth:{dispose(){},status:async()=>({contract_version:1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false})}});
try{const context=await browser.newContext();await isolate(context,helper.origin);const page=await context.newPage();await page.goto(helper.origin+'/preview/');await verify(page,async v=>value=v,()=>page.screenshot({path:'test-results/runtime-identity-browser.png',fullPage:true}));console.log('browser synthetic version display/refusals/current identity/390+1280 pass; no package or runtime authority inferred');}finally{await browser.close();await helper.close();}
const packaged=process.argv.includes('--packaged');const app=await electron.launch({executablePath:packaged?path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform==='win32'?'ReMarkableBuddiesManager.exe':'ReMarkableBuddiesManager'}`):undefined,args:[...(packaged?[]:['.']),...(process.platform==='linux'?['--disable-gpu']:[])],env:{...process.env,MANAGER_TEST:'1',MANAGER_TEST_DEFER_LOAD:'1',MANAGER_TEST_PROFILE:root}});
try{
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');await isolate(app.context());await app.evaluate(async({app,BrowserWindow})=>BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`));
 assert.equal(await page.evaluate(()=>window.managerHost.inspectRuntime({path:'/arbitrary'}).then(()=>'accepted',()=> 'refused')),'refused');
 await app.evaluate(({ipcMain},fixture)=>{ipcMain.removeHandler('manager:observe');ipcMain.handle('manager:observe',()=>({contract_version:1,status:'observed',observation:fixture.tablet}));globalThis.runtimeFixture=fixture.value;ipcMain.removeHandler('manager:inspectRuntime');ipcMain.handle('manager:inspectRuntime',()=>globalThis.runtimeFixture);},{tablet,value:{...observed(),runtime_identity:identity('reported')}});
 await verify(page,v=>app.evaluate((_electron,v)=>globalThis.runtimeFixture=v,v),async()=>{const png=await app.evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('Empty native capture');return image.toPNG().toString('base64');});await writeFile(`test-results/runtime-identity-desktop${packaged?'-packaged':''}.png`,Buffer.from(png,'base64'));});
 console.log(`${packaged?'packaged ':''}Electron synthetic UI and actual invalid-argument refusal pass; no physical binary/running/package proof`);
}finally{await app.close();await rm(root,{recursive:true,force:true});}
