import { chromium,_electron as electron,expect } from '@playwright/test';
import { mkdtemp,mkdir,rm,readFile,writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { reduceMemoryInspectionResult } from '../host/memory-inspection.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { tablet,key,report as inspectionReport,privateReply as privateInspection,query } from './fixtures/memory-inspection.mjs';
import { reply as queryReply } from './fixtures/memory-query.mjs';
import { prepared,ack,failure,rawReply } from './fixtures/memory-forget.mjs';
const packaged=process.argv.includes('--packaged');
const folder=await mkdtemp(path.join(os.tmpdir(),'manager-memory-forget-ui-'));
await mkdir('test-results',{recursive:true});
let mode='ack',completePending,calls=[],delayReloadStatus=false;
const fixtureResponse=async(selector,body)=>{
 calls.push(selector);
 // Exercise legal operation latency beyond the UI matcher's five-second paint check.
 if(selector==='prepare-forget'&&calls.length===1)await new Promise(resolve=>setTimeout(resolve,6000));
 if(mode==='delayed-prepare'&&selector==='prepare-forget'){await new Promise(r=>{completePending=r;});return prepared(body.operation,body.key,true);}
 if(mode==='delayed-confirm'&&selector==='forget'){await new Promise(r=>{completePending=r;});return ack(selector,body.intent.operation);}
 if(selector==='prepare-forget'){const report=await prepared(body.operation,body.key,true);if(mode==='private')report.data.intent.private='PRIVATE_REPORT_CANARY';return mode==='unsupported'?failure(selector,'unsupported',false):report;}
 if(selector==='forget')return mode==='lost'?failure(selector,'unavailable',true,'unknown'):mode==='refused'?failure(selector,'conflict',false,'not-dispatched'):ack(selector,body.intent.operation);
 return ack(selector,body.intent.operation);
};
async function isolate(context,origin){await context.route('**/*',async route=>{const u=route.request().url();if(origin&&u===origin+'/manager-memory-forget'&&route.request().method()==='POST'&&delayReloadStatus&&route.request().postDataJSON()?.action==='status'){delayReloadStatus=false;await new Promise(resolve=>setTimeout(resolve,6000));}if(u.startsWith('https://api.github.com/repos/s116821/'))return route.fulfill({status:404,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'});if(u.startsWith('file:')||(origin&&new URL(u).origin===origin))return route.continue();return route.abort();});}
async function verify(page,setMode,capture,release,waitDispatch,prepareInitial=button=>button.click(),reloadReady=async()=>{await page.reload();await page.getByRole('heading',{name:'Forget one prepared fact',exact:true}).waitFor({timeout:14000});}){
 const prepare=page.getByRole('button',{name:'Prepare forget preview',exact:true});const confirm=page.getByRole('button',{name:'Confirm forget of this prepared fact',exact:true});const status=page.getByTestId('memory-forget-status');const preview=page.getByTestId('memory-forget-preview');const receipt=page.getByRole('button',{name:'Check historical receipt only',exact:true});
 const inspect=page.getByRole('button',{name:'Inspect current revisions',exact:true});
 async function read(){await page.getByRole('button',{name:'Read tablet state',exact:true}).click();await page.getByTestId('tablet-model').waitFor();await page.locator('#memory-query').fill('gravity');await page.getByRole('button',{name:'Search global memory',exact:true}).click();await inspect.waitFor();await inspect.click();await expect(page.getByTestId('memory-inspection-status')).toHaveText('Current fact revision inspected');}
 await expect(prepare).toBeDisabled();await read();await prepareInitial(prepare);await expect(preview).toContainText('Café Ω');await expect(preview).toContainText('Selected memory publication');await expect(preview).toContainText('Observed: 9007199254740991');await expect(preview).toContainText('Author asserted:');
 for(const width of [390,1280]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.locator('#memory-forget-title').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await capture();
 async function retainedStatus(){return page.evaluate(()=>window.managerHost?window.managerHost.memoryForget({action:'status'}):fetch('/manager-memory-forget',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{"action":"status"}'}).then(r=>r.json()));}
 const publicState=await retainedStatus();
 const text=JSON.stringify(publicState);for(const field of ['config_sha256','accepted_base_sha256','selection_sha256','store_generation','input_base64'])assert.equal(text.includes(field),false);
 await confirm.click();await expect(status).toContainText('acknowledged historically');await expect(preview).toHaveCount(0);await expect(page.getByTestId('memory-fact')).toHaveCount(1);await expect(prepare).toBeDisabled();
 await read();await setMode('lost');await prepare.click();await expect(preview).toBeVisible();await confirm.click();await expect(status).toContainText('unknown');await expect(preview).toHaveCount(0);await expect(prepare).toBeDisabled();
 const retained=await retainedStatus();assert.equal(retained.forget.state,'unknown');assert.match(retained.forget.reference,/^[0-9a-f]{64}$/);
 await reloadReady();const reloaded=await retainedStatus();assert.equal(reloaded.forget.state,'unknown');assert.equal(reloaded.forget.reference,retained.forget.reference);await expect(status).toContainText('unknown');await page.getByRole('button',{name:'Read tablet state',exact:true}).click();await page.getByTestId('tablet-model').waitFor();await receipt.click();await expect(status).toContainText('acknowledged historically');await expect(preview).toHaveCount(0);
 await setMode('refused');await read();await prepare.click();await expect(preview).toBeVisible();await confirm.click();await expect(status).toContainText('refused before mutation attempt');
 await setMode('unsupported');await read();await prepare.click();await expect(status).toContainText('unsupported');await expect(confirm).toHaveCount(0);
 await setMode('private');await read();await prepare.click();await expect(status).toContainText('unavailable');await expect(confirm).toHaveCount(0);assert.equal((await page.textContent('body')).includes('PRIVATE_REPORT_CANARY'),false);
 await setMode('delayed-prepare');await prepare.click();await expect(page.getByRole('button',{name:'Stop local wait',exact:true})).toBeEnabled();await waitDispatch();await page.getByRole('button',{name:'Stop local wait',exact:true}).click();await expect(status).toContainText('invalidated');await release();await expect(preview).toHaveCount(0);
 await setMode('delayed-confirm');await prepare.click();await expect(preview).toBeVisible();await confirm.click();await waitDispatch();await page.getByRole('button',{name:'Stop local wait',exact:true}).click();await expect(status).toContainText('unknown');await release();
 await setMode('ack');await receipt.click();await expect(status).toContainText('acknowledged historically');
 assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.process),'undefined');
}
const observed={contract_version:1,status:'observed',observation:tablet};
const observer={lastObservation:tablet,cancel(){return {contract_version:1,status:'cancelled',observation:null};},async observe(){this.lastObservation=structuredClone(tablet);return structuredClone(observed);},async memoryQuery(){return queryReply(query());},async inspectMemory(q){return reduceMemoryInspectionResult(privateInspection(inspectionReport()),q,validateResult);},async run(action,q){assert.equal(action,'memory-forget');return rawReply(await fixtureResponse(q.selector,JSON.parse(Buffer.from(q.input_base64,'base64'))));}};
const helper=await startHelper({root:path.resolve(packaged?'dist/manager/browser':'test-results/development/browser'),observer,driveAuth:{dispose(){},status:async()=>({contract_version:1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false})},downloads:{dispose(){},request:async()=>{throw Error('fixture unavailable');}}});
const browser=await chromium.launch();
try{const context=await browser.newContext();await isolate(context,helper.origin);const page=await context.newPage();await page.goto(helper.origin+'/preview/');await verify(page,async v=>{mode=v;completePending=null;},()=>page.locator('section[aria-labelledby="memory-forget-title"]').screenshot({path:`test-results/memory-forget-browser${packaged?'':'-development'}.png`}),async()=>{assert.equal(typeof completePending,'function');completePending();},async()=>{await expect.poll(()=>typeof completePending).toBe('function');},async button=>{
 const started=performance.now();
 const pending=page.waitForResponse(response=>{if(response.url()!==helper.origin+'/manager-memory-forget'||response.request().method()!=='POST')return false;try{return response.request().postDataJSON()?.action==='prepare';}catch{return false;}},{timeout:14000});
 await button.click();const response=await pending;assert.equal(response.status(),200);const value=await response.json();assert.equal(value.forget.state,'prepared');
 console.log('Initial browser preparation public response complete before unchanged UI assertions:',Math.ceil(performance.now()-started),'ms; existing14s request bound');
},async()=>{
 const started=performance.now(),requests=new Set(),events=[];let pageErrors=0;
 const isStatus=request=>{if(request.url()!==helper.origin+'/manager-memory-forget'||request.method()!=='POST')return false;try{return request.postDataJSON()?.action==='status';}catch{return false;}};
 const onRequest=request=>{if(isStatus(request)){requests.add(request);events.push({event:'startup-status-request',ms:Math.ceil(performance.now()-started)});}};
 const onError=()=>{pageErrors++;};page.on('request',onRequest);page.on('pageerror',onError);delayReloadStatus=true;
 try{
  const responsePromise=page.waitForResponse(response=>requests.has(response.request()),{timeout:14000});
  const [response]=await Promise.all([responsePromise,page.reload()]);
  events.push({event:'startup-status-response',ms:Math.ceil(performance.now()-started)});
  await page.getByRole('heading',{name:'Forget one prepared fact',exact:true}).waitFor({timeout:14000});
  assert.equal(response.status(),200);assert.equal((await response.json()).forget.state,'unknown');
  console.log('Reload browser startup status complete before unchanged UI assertions:',JSON.stringify({events,pageErrors,delayConsumed:!delayReloadStatus}));assert.equal(delayReloadStatus,false);
 }catch(error){
  const document=await page.evaluate(()=>({readyState:document.readyState,rootPresent:!!document.querySelector('app-root'),rootChildren:document.querySelector('app-root')?.childElementCount??0,statusPresent:!!document.querySelector('[data-testid="memory-forget-status"]')})).catch(()=>null);
  console.error('Reload readiness diagnostic:',JSON.stringify({events,pageErrors,path:new URL(page.url()).pathname,document}));throw error;
 }finally{delayReloadStatus=false;page.off('request',onRequest);page.off('pageerror',onError);}
});assert.equal(calls.filter(x=>x==='forget').length,4);console.log(`${packaged?'retained production':'development'} browser prepared forget/immutable preview/ack-only/unknown/reload/receipt/cancel pass; raw producer reports and route are synthetic`);}finally{await browser.close();await helper.close();}
const env={...process.env};for(const n of Object.keys(env))if(n.startsWith('MANAGER_'))delete env[n];Object.assign(env,{MANAGER_TEST:'1',MANAGER_TEST_DEFER_LOAD:'1',MANAGER_TEST_PROFILE:folder});
const app=await electron.launch({executablePath:packaged?path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform==='win32'?'ReMarkableBuddiesManager.exe':'ReMarkableBuddiesManager'}`):undefined,args:[...(packaged?[]:['.']),...(process.platform==='linux'?['--disable-gpu']:[])],env});
try{
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');await isolate(app.context());
 // Actual main IPC/coordinator/parsers stay installed; only lower transport/report methods are synthetic.
 const inspection=await reduceMemoryInspectionResult(privateInspection(inspectionReport()),{connection_id:tablet.connection_id,boot_id:tablet.boot_id,key},validateResult);
 const base=await prepared(undefined,key,true);
 await app.evaluate(({app},fixture)=>{
  const require=process.mainModule.require.bind(process.mainModule),path=require('node:path');const root=app.isPackaged?path.join(process.resourcesPath,'host'):path.join(app.getAppPath(),'host');const {WiredObserver}=require(path.join(root,'observer.mjs'));const {DriveAuth}=require(path.join(root,'drive-auth.mjs'));
  globalThis.forgetMode='ack';globalThis.forgetCalls=[];
  DriveAuth.prototype.status=async()=>({contract_version:1,status:'unconfigured',account:null,checkedAt:null,error:null,authorizationId:null,backupReady:false});
  WiredObserver.prototype.observe=async function(){this.lastObservation=structuredClone(fixture.tablet);return {contract_version:1,status:'observed',observation:this.lastObservation};};
  WiredObserver.prototype.memoryQuery=async()=>structuredClone(fixture.query);
  WiredObserver.prototype.inspectMemory=async()=>structuredClone(fixture.inspection);
  WiredObserver.prototype.run=async function(action,q){
   if(action!=='memory-forget')throw Error('Unexpected fixture action');const selector=q.selector,body=JSON.parse(Buffer.from(q.input_base64,'base64'));globalThis.forgetCalls.push(selector);const mode=globalThis.forgetMode;let report;
   if(mode==='delayed-prepare'&&selector==='prepare-forget'||mode==='delayed-confirm'&&selector==='forget')await new Promise(r=>{globalThis.forgetRelease=r;});
   if(selector==='prepare-forget'){report=structuredClone(fixture.prepare);report.data.intent.operation=body.operation;if(mode==='private')report.data.intent.private='PRIVATE_REPORT_CANARY';if(mode==='unsupported')report={report_version:1,operation:selector,status:'unsupported',incomplete:false,data:null};}
   else if(selector==='forget'&&mode==='lost')report={report_version:1,operation:selector,status:'unavailable',incomplete:true,data:{schema_version:1,outcome:'unknown'}};
   else if(selector==='forget'&&mode==='refused')report={report_version:1,operation:selector,status:'conflict',incomplete:false,data:{schema_version:1,outcome:'not-dispatched'}};
   else report={report_version:1,operation:selector,status:'ok',incomplete:false,data:{schema_version:1,outcome:'acknowledged',operation:body.intent.operation,transaction:fixture.transaction}};
   return {contract_version:1,status:'observed',observation:structuredClone(fixture.tablet),forget_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(report)+'\n').toString('base64')}};
  };
 },{tablet,query:queryReply(query()),inspection,prepare:base,transaction:'88888888-8888-4888-8888-888888888888'});
 await app.evaluate(async({app,BrowserWindow})=>{await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`);BrowserWindow.getAllWindows()[0].show();});
 for(const expression of ['window.managerHost.memoryForget({action:"confirm",reference:"bad",intent:{}})','window.managerHost.memoryForget({}, {})','window.managerHost.memoryForget()'])assert.equal(await page.evaluate(expression+'.then(()=>"accepted",()=>"refused")'),'refused');
 if(packaged){const resources=await app.evaluate(()=>process.resourcesPath);for(const f of ['memory_forget_transport.py','memory-forget.mjs','memory-forget-protocol.mjs'])assert.deepEqual(await readFile(path.join(resources,'host',f)),await readFile(path.join('host',f)));const child=spawnSync(process.env.MANAGER_WIRED_PYTHON??(process.platform==='win32'?'python':'python3'),[path.join(resources,'host/memory_forget_transport.py')],{input:'PRIVATE_INPUT_CANARY',encoding:'utf8',timeout:3000});assert.equal(child.status,0);assert.equal(child.stderr,'');assert.equal(child.stdout.includes('PRIVATE_INPUT_CANARY'),false);}
 await verify(page,v=>app.evaluate((_electron,v)=>{globalThis.forgetMode=v;globalThis.forgetRelease=null;},v),async()=>{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,1500));await page.locator('section[aria-labelledby="memory-forget-title"]').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await writeFile(`test-results/memory-forget-desktop${packaged?'-packaged':''}.png`,Buffer.from(png,'base64'));},()=>app.evaluate(()=>{globalThis.forgetRelease();globalThis.forgetRelease=null;}),async()=>{await expect.poll(()=>app.evaluate(()=>typeof globalThis.forgetRelease)).toBe('function');});
 const count=await app.evaluate(()=>globalThis.forgetCalls.filter(s=>s==='forget').length);assert.equal(count,4);
 console.log(`${packaged?'retained packaged':'source'} Electron actual IPC/coordinator guards and prepared forget/unknown/receipt/reload/cancel UI pass; transport/reports synthetic`);
}finally{await app.close();await rm(folder,{recursive:true,force:true});}
