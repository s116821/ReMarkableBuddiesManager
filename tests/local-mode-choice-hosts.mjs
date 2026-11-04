import {chromium,_electron as electron,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {startHelper} from '../host/browser-helper.mjs';
import {localModeFixture,tablet} from './fixtures/local-mode-choice.mjs';
import {verifyLocalModeAppBoundaries} from './fixtures/local-mode-app-boundaries.mjs';
const packaged=process.argv.includes('--packaged');await mkdir('test-results',{recursive:true});
const fixtures=JSON.parse(await readFile(new URL('./fixtures/local-mode-choice-reports.json',import.meta.url)));
const unconfigured=JSON.parse(fixtures.find(r=>r.name==='inspect-unconfigured').report_utf8);
const chosen=JSON.parse(fixtures.find(r=>r.name==='choose-local-current').report_utf8);
async function isolate(context,origin){await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('https://api.github.com/repos/s116821/'))return route.fulfill({status:404,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'});if(url.startsWith('file:')||origin&&new URL(url).origin===origin)return route.continue();return route.abort();});}
async function verify(page,control,capture){
 const review=page.getByRole('button',{name:'Review change',exact:true}),confirm=page.getByRole('button',{name:'Save Local-only',exact:true}),status=page.getByTestId('local-mode-choice-status');
 const read=async()=>{await page.getByRole('button',{name:'Read tablet state',exact:true}).click();await page.getByTestId('tablet-model').waitFor();};
 await expect(review).toBeDisabled();await read();await review.click();await expect(status).toContainText('Review complete');await expect(page.getByTestId('local-mode-choice-current')).toContainText('Not set');
 for(const width of [390,1280]){await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await capture(width);}
 for(const event of ['pagehide','hidden','same-ID-refresh']){
  if(event==='pagehide')await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  else if(event==='hidden')await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;});
  else await read();
  await expect(confirm).toHaveCount(0);await expect(page.getByTestId('local-mode-choice-current')).toHaveCount(0);assert.equal(await control.choices(),0);
  await review.click();await expect(status).toContainText('Review complete');
 }
 await page.clock.install();await review.click();await expect(status).toContainText('Review complete');await page.clock.fastForward(120000);await page.clock.runFor(100);await expect(confirm).toHaveCount(0);assert.equal(await control.choices(),0);
 await review.click();await expect(status).toContainText('Review complete');
 console.log('Actual Local-only UI ready pagehide/hidden/same-ID-refresh/120s expiry prevent confirmation');
 await verifyLocalModeAppBoundaries(page);
 await review.click();await expect(status).toContainText('Review complete');
 await confirm.click();await expect(status).toContainText('Local-only mode was saved');await expect(page.getByTestId('local-mode-choice-receipt')).toContainText('does not confirm which mode Buddy is currently using');const first=await control.epoch();assert.equal(await control.choices(),1);
 await review.click();await expect(status).toContainText('Review complete');await expect(page.getByTestId('local-mode-choice-current')).toContainText('Local only');await confirm.click();await expect(status).toContainText('Local-only mode was saved');assert.notEqual(await control.epoch(),first);assert.equal(await control.choices(),2);
 await control.lost();await review.click();await expect(status).toContainText('Review complete');await confirm.click();await expect(status).toContainText('Save not confirmed');assert.equal(await control.choices(),3);await expect(confirm).toHaveCount(0);
 await review.click();await expect(status).toContainText('Save not confirmed');assert.equal(await control.choices(),3);await expect(confirm).toHaveCount(0);
 await page.reload();await page.getByRole('heading',{name:'Save Local-only mode',exact:true}).waitFor({timeout:14000});await expect(page.getByTestId('local-mode-choice-retained').locator('li')).toHaveCount(3);assert.equal(await control.choices(),3);
 await read();await page.getByRole('button',{name:'Check saved mode',exact:true}).last().click();await expect(status).toContainText('earlier save is still unconfirmed');await expect(page.getByTestId('local-mode-choice-current')).toContainText('Local only');await expect(page.getByTestId('local-mode-choice-retained').locator('li').last()).toContainText('Save not confirmed');assert.equal(await control.choices(),3);await expect(confirm).toHaveCount(0);
 const text=await page.textContent('body');for(const field of ['request_sha256','binding_sha256','root_id','"actor"','"token"','"operation"'])assert.equal(text.includes(field),false);
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await expect(page.getByTestId('local-mode-choice-current')).toHaveCount(0);await expect(page.getByTestId('local-mode-choice-retained').locator('li').last()).toContainText('Save not confirmed');assert.equal(await control.choices(),3);
 assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.process),'undefined');
}
let lost=false;const fixture=localModeFixture({report:r=>lost?{...r,status:'failed',incomplete:true,data:{...r.data,receipt:null,receipt_status:null}}:r});
fixture.observer.observe=async function(){this.lastObservation=structuredClone(tablet);return {contract_version:1,status:'observed',observation:this.lastObservation};};
const helper=await startHelper({root:path.resolve(packaged?'dist/manager/browser':'test-results/development/browser'),observer:fixture.observer,driveAuth:{dispose(){},status:async()=>({contract_version:1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false})},downloads:{dispose(){},request:async()=>{throw Error('Synthetic unavailable');}}});
const browser=await chromium.launch();
try{
 const context=await browser.newContext();await isolate(context,helper.origin);const page=await context.newPage();await page.goto(helper.origin+'/preview/');
 await verify(page,{lost:async()=>{lost=true;},choices:async()=>fixture.chooseCount,epoch:async()=>fixture.savedEpoch},width=>page.locator('section[aria-labelledby="local-mode-choice-title"]').screenshot({path:`test-results/local-mode-choice-browser${packaged?'-production':''}-${width}.png`}));
 const refused=await context.request.post(helper.origin+'/manager-local-mode-choice',{headers:{Origin:helper.origin},data:{action:'retained',operation:'PRIVATE_CANARY'}});assert.equal(refused.status(),400);
 const foreign=await context.request.post(helper.origin+'/manager-local-mode-choice',{headers:{Origin:'https://invalid.example'},data:{action:'retained'}});assert.equal(foreign.status(),403);
 console.log(`${packaged?'production':'development'} browser actual coordinator/UI one-shot choice/new epoch/unknown/reload/separate inspect/privacy/390+1280 pass; producer/transport synthetic`);
}finally{await browser.close();await helper.close();}
const folder=await mkdtemp(path.join(os.tmpdir(),'manager-local-mode-choice-')),env={...process.env};for(const name of Object.keys(env))if(name.startsWith('MANAGER_'))delete env[name];Object.assign(env,{MANAGER_TEST:'1',MANAGER_TEST_DEFER_LOAD:'1',MANAGER_TEST_PROFILE:folder});
const app=await electron.launch({executablePath:packaged?path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform==='win32'?'ReMarkableBuddiesManager.exe':'ReMarkableBuddiesManager'}`):undefined,args:[...(packaged?[]:['.']),...(process.platform==='linux'?['--disable-gpu']:[])],env});
try{
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');await isolate(app.context());
 await app.evaluate(({app},fixture)=>{
  const require=process.mainModule.require.bind(process.mainModule),path=require('node:path'),crypto=require('node:crypto'),root=app.isPackaged?path.join(process.resourcesPath,'host'):path.join(app.getAppPath(),'host');
  const {WiredObserver}=require(path.join(root,'observer.mjs')),{DriveAuth}=require(path.join(root,'drive-auth.mjs'));
  globalThis.localModeCurrent=fixture.unconfigured;globalThis.localModeChoices=0;globalThis.localModeLost=false;
  DriveAuth.prototype.status=async()=>({contract_version:1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false});
  WiredObserver.prototype.observe=async function(){this.lastObservation=structuredClone(fixture.tablet);return {contract_version:1,status:'observed',observation:this.lastObservation};};
  WiredObserver.prototype.run=async function(action,q){
   if(action!=='local-mode-choice')throw Error('Unexpected synthetic action');let report;
   if(q.selector==='inspect')report=structuredClone(globalThis.localModeCurrent);
   else{
    const original=JSON.parse(Buffer.from(q.input_base64,'base64'));globalThis.localModeChoices++;report=structuredClone(fixture.chosen);
    report.data.receipt.operation=original.operation;report.data.receipt.expected=original.expected.sha256;report.data.receipt.request_sha256=crypto.createHash('sha256').update(JSON.stringify([original.expected.actor,original.expected.sha256,original.choice])).digest('hex');
    report.data.receipt.epoch=`44444444-4444-4444-8444-${String(globalThis.localModeChoices).padStart(12,'0')}`;report.data.current_snapshot.epoch=report.data.receipt.epoch;report.data.current_snapshot.token.sha256=crypto.createHash('sha256').update('mode'+globalThis.localModeChoices).digest('hex');
    globalThis.localModeCurrent={...structuredClone(report),operation:'inspect',data:{current_snapshot:structuredClone(report.data.current_snapshot),receipt:null,receipt_status:null}};
    if(globalThis.localModeLost)report={...report,status:'failed',incomplete:true,data:{...report.data,receipt:null,receipt_status:null}};
   }
   return {contract_version:1,status:'observed',observation:structuredClone(fixture.tablet),local_mode_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(report)+'\n').toString('base64')}};
  };
 },{tablet,unconfigured,chosen});
 await app.evaluate(async({app,BrowserWindow})=>{await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`);BrowserWindow.getAllWindows()[0].show();});
 for(const expression of ['window.managerHost.localModeChoice()','window.managerHost.localModeChoice({}, {})','window.managerHost.localModeChoice({action:"retained",token:{}})'])assert.equal(await page.evaluate(expression+'.then(()=>"accepted",()=>"refused")'),'refused');
 const denied=await app.evaluate(async({ipcMain,BrowserWindow})=>{const handle=ipcMain._invokeHandlers.get('manager:localModeChoice'),contents=BrowserWindow.getAllWindows()[0].webContents;let n=0;for(const event of [{},{sender:contents,senderFrame:{url:contents.getURL()}}])try{await handle(event,{action:'retained'});}catch{n++;}return n;});assert.equal(denied,2);
 if(packaged){const resources=await app.evaluate(()=>process.resourcesPath);for(const file of ['local-mode-choice.mjs','local-mode-choice-protocol.mjs','local_mode_choice_transport.py'])assert.deepEqual(await readFile(path.join(resources,'host',file)),await readFile(path.join('host',file)));const run=spawnSync(process.platform==='win32'?'python':'python3',[path.join(resources,'host/local_mode_choice_transport.py')],{input:'PRIVATE_CANARY',encoding:'utf8',timeout:3000});assert.equal(run.status,0);assert.equal(run.stderr,'');assert.equal(run.stdout.includes('PRIVATE_CANARY'),false);}
 await verify(page,{lost:()=>app.evaluate(()=>{globalThis.localModeLost=true;}),choices:()=>app.evaluate(()=>globalThis.localModeChoices),epoch:()=>app.evaluate(()=>globalThis.localModeCurrent.data.current_snapshot.epoch)},async width=>{
  const section=page.locator('section[aria-labelledby="local-mode-choice-title"]');await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,1100),width);await section.screenshot({path:`test-results/local-mode-choice-desktop${packaged?'-packaged':''}-${width}.png`});
 });console.log(`${packaged?'retained packaged':'source'} Electron actual main-frame IPC/coordinator/UI one-shot choice/new epoch/unknown/reload/separate inspect/privacy pass; producer/transport synthetic`);
}finally{await app.close();await rm(folder,{recursive:true,force:true});}
