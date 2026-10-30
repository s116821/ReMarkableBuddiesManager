import {expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {conversation} from './conversation-management.mjs';
import {ids} from './handwriting-records.mjs';
const reference=JSON.parse(await readFile(new URL('./conversation-inventory-reference-vectors.json',import.meta.url),'utf8'));
export async function verifyProductAppBoundaries(page){
 if(!await page.evaluate(()=>!!window.ng?.getComponent))return;
 await page.getByRole('button',{name:'Read tablet state',exact:true}).click();await page.getByTestId('tablet-model').waitFor();
 const outgoing=[...reference.outgoing_idle_controllers,'conversationController','managementController','restoreController','selectedController','handwritingController'];assert.equal(outgoing.length,15);
 const begin=page.getByRole('button',{name:'Begin product settings edit',exact:true}),status=page.getByTestId('product-settings-status');
 await page.evaluate(names=>{const a=window.ng.getComponent(document.querySelector('app-root'));a.productClears={};for(const name of names){const c=a[name],old=c.clear.bind(c);c.clear=(...args)=>{a.productClears[name]=(a.productClears[name]??0)+1;return old(...args);};}},outgoing);
 await begin.click();await expect(status).toContainText('ready to edit');
 const counts=await page.evaluate(()=>window.ng.getComponent(document.querySelector('app-root')).productClears);assert.equal(Object.keys(counts).length,15);assert.ok(Object.values(counts).every(x=>x===1),JSON.stringify(counts));
 // Readiness must belong to this Begin. The preceding editor can still have
 // ready status/controls in the DOM after the new invocation has become busy.
 const prepareProduct=async()=>{
  await expect.poll(()=>page.evaluate(()=>{const a=window.ng.getComponent(document.querySelector('app-root'));return a.productPeerBusy()||a.product().busy;})).toBe(false);
  const previous=await page.evaluate(()=>window.ng.getComponent(document.querySelector('app-root')).product().reference);
  await begin.click();
  await expect.poll(()=>page.evaluate(previous=>{const a=window.ng.getComponent(document.querySelector('app-root')),s=a.product();return {busy:s.busy,state:s.view?.state,fresh:!!s.reference&&s.reference!==previous,peer:a.productPeerBusy()};},previous)).toEqual({busy:false,state:'ready',fresh:true,peer:false});
  await expect(status).toContainText('ready to edit');
  const reference=await page.evaluate(()=>window.ng.getComponent(document.querySelector('app-root')).product().reference),field=page.locator('#product-reader_enabled');await field.selectOption('false');
  await expect.poll(()=>page.evaluate(reference=>{const a=window.ng.getComponent(document.querySelector('app-root')),s=a.product();return {busy:s.busy,state:s.view?.state,same:s.reference===reference,draft:s.draft.reader_enabled,changes:s.changes};},reference)).toEqual({busy:false,state:'ready',same:true,draft:'false',changes:{reader_enabled:{action:'set',value:false}}});
  await expect(field).toHaveValue('false');
 };
 // Reproduce the hosted failure's stale-DOM premise in one actual App task.
 // A peer attempt during queued Begin is Busy, not an idle invalidation test.
 const queued=await page.evaluate(async()=>{
  const a=window.ng.getComponent(document.querySelector('app-root')),c=a.productController,old=c.clear;let calls=0;c.clear=function(...args){calls++;return old.apply(this,args);};
  try{const pending=a.beginProduct(),oldStatus=document.querySelector('[data-testid="product-settings-status"]').textContent,field=document.querySelector('#product-reader_enabled');field.value='false';field.dispatchEvent(new Event('change',{bubbles:true}));const peer=a.beginModel();const result={oldReady:oldStatus.includes('ready to edit'),busy:a.product().busy,calls,cleared:a.product().view===null,dom:field.value,draft:Object.values(a.product().draft).join('')};await pending;await peer;return result;}finally{c.clear=old;}
 });
 assert.deepEqual(queued,{oldReady:true,busy:true,calls:0,cleared:true,dom:'false',draft:''});
 console.log('Actual queued Begin rejects stale-DOM edit and peer before clear hooks');
  const boundaries=[...reference.incoming_boundaries.map(x=>[x.method,x.argument]),[reference.separate_forget_receipt.method,reference.separate_forget_receipt.argument],['inspectConversations',null],...['inspect','prepare','confirm'].map(x=>['manageConversation',x]),['checkManagement',null],['prepareRestore',null],['confirmRestore',null],['checkRestore',null],['inspectArchive',null],['previewArchive',null],['confirmArchive',null],['checkArchive',null],['queryHandwriting',null],['inspectHandwriting',null],['prepareHandwriting',null],['confirmHandwriting',null],['checkHandwriting',null]];
  assert.equal(boundaries.length,46);
  for(const [method,action]of boundaries){await prepareProduct();const result=await page.evaluate(async({method,action,conversation,ids})=>{const a=window.ng.getComponent(document.querySelector('app-root')),t=a.connection().observation,r={document:conversation,conversation,reference:'0'.repeat(64),connection_id:t.connection_id,boot_id:t.boot_id,state:'unknown',status_available:true};
   if(method==='prepareForget')a.forgetHead=()=>({fact:{key:{profile:'11111111-1111-4111-8111-111111111111',scope:{kind:'global'},fact:conversation}}});if(method==='confirmCleanup')a.cacheCleanup.set({...a.cacheCleanup(),view:{state:'ready',reference:r.reference}});if(method==='checkCleanup')a.cleanupController.state.retained.push(r);if(method==='forgetAction')a.forget.set({...a.forget(),reference:r.reference});if(method==='prepareCleanup')a.cleanupController.select(r.document);
   if(method==='manageConversation'){if(action==='inspect'){a.conversationInventory.set({...a.conversationInventory(),view:{complete:true,candidates:[conversation]}});a.managementController.select(conversation);}else{const s={...a.managementController.state,view:{state:action==='prepare'?'inspected':'ready',reference:r.reference,preview:{conversation,turns:0,source_records:0,export_associations:0}}};a.managementController.state=s;a.conversationManagement.set(s);}}
   if(method==='prepareRestore')a.restoreController.setDraft('/home/root/backups/ordinary');if(method==='confirmRestore')a.ordinaryRestore.set({...a.ordinaryRestore(),view:{state:'ready',reference:r.reference}});
   if(method==='inspectArchive'||method==='previewArchive')a.selectedController.setDraft('/home/root/backups/history-new');if(method==='confirmArchive')a.selectedArchive.set({...a.selectedArchive(),view:{state:'ready',reference:r.reference}});if(method==='checkArchive'){r.original_outcome='unknown';r.expired=false;}
   if(method==='queryHandwriting'||method==='inspectHandwriting'){const state={...a.handwritingController.state,profile:ids.profile,correction:ids.correction};a.handwritingController.state=state;a.handwritingRecords.set(state);}
   if(method==='prepareHandwriting'){const state={...a.handwritingController.state,result:{state:'inspected',view:{profile:ids.profile,correction:ids.correction,heads:[{state:'value',sample_availability:'available'}]}}};a.handwritingController.state=state;a.handwritingRecords.set(state);}
   if(method==='confirmHandwriting')a.handwritingRecords.set({...a.handwritingRecords(),result:{state:'prepared'}});
   const c=a.productController,old=c.clear;let calls=0,pending;c.clear=function(...args){calls++;return old.apply(this,args);};try{pending=a[method](method==='forgetAction'||method==='manageConversation'?action:method==='inspectHandwriting'?{profile:ids.profile,correction:ids.correction}:r);}finally{c.clear=old;}const result={calls,cleared:a.product().view===null,draft:Object.values(a.product().draft).join(''),dom:[...document.querySelectorAll('[id^="product-"]')].filter(e=>e.tagName==='SELECT').map(e=>e.value).join('')};await pending;return result;
  },{method,action,conversation,ids});assert.deepEqual(result,{calls:1,cleared:true,draft:'',dom:''},method+' '+action);}
  console.log('Actual development App:46 incoming product invalidations and15 outgoing peer clears pass');
}
