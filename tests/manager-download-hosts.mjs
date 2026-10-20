/* global document, innerWidth, window */
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, copyFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { downloadState } from '../host/manager-download-protocol.mjs';
const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'manager-download-ui-')));await mkdir('test-results',{recursive:true});
const tag='v0.3.1',id='a'.repeat(64),source='b'.repeat(40);
const state=(status='complete')=>({...downloadState(status),operation_id:id,tag,folder:`manager-download-${id}`,source_sha:status==='complete'?source:null,error:status==='cancelled'?'cancelled':status==='failed'?'download-refused':null,incomplete:status==='failed'});
const release={draft:false,prerelease:false,tag_name:tag,published_at:'2026-10-13T00:00:00Z',html_url:`https://github.com/s116821/ReMarkableBuddiesManager/releases/tag/${tag}`,assets:['manager-browser.zip','manager-win32-x64.zip','manager-linux-x64.zip','provenance.json'].map(name=>({name,state:'uploaded',size:10,browser_download_url:`https://github.com/s116821/ReMarkableBuddiesManager/releases/download/${tag}/${name}`}))};
async function isolate(context){await context.route('**/*',route=>{const url=route.request().url();if(url==='https://api.github.com/repos/s116821/ReMarkableBuddiesManager/releases/latest')return route.fulfill({json:release});if(url.startsWith('https://'))return route.fulfill({status:404,body:''});return route.continue();});}
async function verify(page,set,capture){
 const button=page.getByRole('button',{name:'Download and verify Manager files',exact:true});
 await expect(button).toBeEnabled();await button.click();await expect(page.getByTestId('manager-download-status')).toHaveText('Download checked at completion');await expect(page.getByTestId('manager-download-result')).toContainText(tag);await expect(page.getByText(`Folder: manager-download-${id}`,{exact:true})).toBeVisible();
 for(const width of [390,1280]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await capture();
 await set(state('failed'));await page.getByRole('button',{name:'Check download status',exact:true}).click();await expect(page.getByTestId('manager-download-status')).toHaveText('Download could not be verified');await expect(page.getByText('Partial release files may remain',{exact:false})).toBeVisible();
 await set({...state(),update_eligible:true});await page.getByRole('button',{name:'Check download status',exact:true}).click();await expect(page.getByTestId('manager-download-status')).toContainText('Download status unknown');await expect(button).toBeDisabled();await expect(page.getByTestId('manager-download-result')).toHaveCount(0);
 await set(state('downloading'));await page.getByRole('button',{name:'Check download status',exact:true}).click();await expect(page.getByTestId('manager-download-status')).toContainText('Downloading');await page.getByRole('button',{name:'Cancel download',exact:true}).click();await expect(page.getByTestId('manager-download-status')).toHaveText('Download cancelled');
}
let value=downloadState('idle');const helper=await startHelper({root:path.resolve('dist/manager/browser'),observer:{cancel(){}},driveAuth:{status:async()=>({status:'unconfigured'}),dispose(){}},downloads:{request:async q=>{if(q.action==='start')value=state();if(q.action==='cancel'){assert.equal(q.operation_id,id);value=state('cancelled');}return value;},dispose(){}}});
const browser=await chromium.launch();
try{const context=await browser.newContext();await isolate(context);const page=await context.newPage();await page.goto(helper.origin+'/preview/');await verify(page,v=>{value=v;},()=>page.screenshot({path:'test-results/manager-download-browser.png',fullPage:true}));await page.route('**/manager-download',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(state())+' '.repeat(2049)}));await page.getByRole('button',{name:'Check download status',exact:true}).click();await expect(page.getByTestId('manager-download-status')).toContainText('Download status unknown');await page.unroute('**/manager-download');console.log('browser synthetic download completion/refusal/cancel/390+1280 passes; no actual release traffic');}finally{await browser.close();await helper.close();}
const packaged=process.argv.includes('--packaged');const app=await electron.launch({executablePath:packaged?path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform==='win32'?'ReMarkableBuddiesManager.exe':'ReMarkableBuddiesManager'}`):undefined,args:[...(packaged?[]:['.']),...(process.platform==='linux'?['--disable-gpu']:[])],env:{...process.env,MANAGER_TEST:'1',MANAGER_TEST_DEFER_LOAD:'1',MANAGER_TEST_PROFILE:root}});
try{
 if (packaged) {
   const resources=await app.evaluate(()=>process.resourcesPath);
   assert.deepEqual(await readdir(path.join(resources,'scripts')),['verify-manager-bundle.py']);
   assert.deepEqual(await readdir(path.join(resources,'host/qualified-producer')),['artifacts.py']);
   await assert.rejects(readdir(path.join(resources,'release')),{code:'ENOENT'});
   const python=spawnSync(process.platform==='win32'?'python':'python3',['-I','-S','-c','import sys; print(sys.executable)'],{encoding:'utf8'});assert.equal(python.status,0);
   const generatedRoot=path.join(root,'generated'),input=path.join(root,'bundles');const fixture=fileURLToPath(new URL('./fixtures/manager-bundle-input.py',import.meta.url));
   const generated=spawnSync(python.stdout.trim(),['-I','-S','-B',fixture,generatedRoot,tag,source,'valid'],{encoding:'utf8'});assert.equal(generated.status,0);await mkdir(input);for(const name of ['manager-browser.zip','manager-win32-x64.zip','manager-linux-x64.zip','provenance.json']) await copyFile(path.join(generatedRoot,name),path.join(input,name));
   const verifier=await import(pathToFileURL(path.join(resources,'host/manager-bundles.mjs')).href);
   try { await verifier.verifyManagerBundles({python:python.stdout.trim(),directory:input,tag,sha:source,signal:new AbortController().signal}); }
   catch {
     // Test-only guard classification, never raw subprocess paths/payload/diagnostics.
     const helper=path.join(resources,'scripts/verify-manager-bundle.py');
     const program="import runpy,sys,json\nn=runpy.run_path(sys.argv[1]);g=n['verify'].__globals__\ndef refusal(): raise RuntimeError('refusal-line-'+str(sys._getframe(1).f_lineno))\ng['refuse']=refusal\ntry: n['verify'](*sys.argv[2:]);print('direct-helper-passed')\nexcept Exception as e: print(json.dumps({'type':type(e).__name__,'guard':str(e) if str(e).startswith('refusal-line-') else 'unclassified'}))";
     const diagnostic=spawnSync(python.stdout.trim(),['-I','-S','-B','-c',program,helper,input,tag,source],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,LANG:'C.UTF-8'}});
     throw new Error('packaged-verifier-refused '+diagnostic.stdout.slice(0,256));
   }
   console.log('actual packaged trusted Python/producer resources verify controlled ZIP declarations; payloads remain unexecuted');
 }
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');await isolate(app.context());await app.evaluate(async({app,BrowserWindow})=>BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`));
 assert.equal(await page.evaluate(()=>window.managerHost.downloads.request({action:'start',tag:'v0.3.1',path:'/arbitrary'}).then(()=>'accepted',()=> 'refused')),'refused');
 assert.equal(await page.evaluate(()=>window.managerHost.downloads.request({},{}).then(()=>'accepted',()=> 'refused')),'refused');
 await app.evaluate(({ipcMain},fixture)=>{globalThis.downloadFixture=fixture;ipcMain.removeHandler('manager:download');ipcMain.handle('manager:download',(_event,q)=>{if(q.action==='start')globalThis.downloadFixture={...fixture,status:'complete',operation_id:'a'.repeat(64),tag:'v0.3.1',folder:'manager-download-'+'a'.repeat(64),source_sha:'b'.repeat(40)};if(q.action==='cancel'){if(q.operation_id!==globalThis.downloadFixture.operation_id)throw Error('wrong cancel');globalThis.downloadFixture={...globalThis.downloadFixture,status:'cancelled',source_sha:null,error:'cancelled'};}return globalThis.downloadFixture;});},downloadState('idle'));
 await page.getByRole('button',{name:'Check download status',exact:true}).click();
 await verify(page,v=>app.evaluate((_electron,v)=>globalThis.downloadFixture=v,v),async()=>{const png=await app.evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('Empty capture');return image.toPNG().toString('base64');});await writeFile(`test-results/manager-download-desktop${packaged?'-packaged':''}.png`,Buffer.from(png,'base64'));});
 console.log(`${packaged?'packaged ':''}Electron synthetic shared download UI and actual invalid-input refusal pass; no update or live release claim`);
}finally{await app.close();await rm(root,{recursive:true,force:true});}
