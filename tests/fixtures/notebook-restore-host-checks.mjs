import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {expect} from '@playwright/test';
import {identity,source} from './notebook-restore.mjs';
import {readFreshTabletState} from './storage-initialization-observation.mjs';
const requestFor=(action,rest={})=>({action,...identity,invocation:randomUUID(),...rest});
const prepare=()=>requestFor('prepare',{source});
const read=name=>name.startsWith('inspect');

// Only the new lane's edges; existing tests retain the existing peer matrix.
export async function verifyNotebookRestoreHosts(request,c,existing,staleAction){
 const peers={...existing,notebookArchive:{key:'notebook_archive',begin:()=>requestFor('prepare-export',{path:'/home/root/backups/notebook-new'})}};
 let busy=0,invalidated=0;
 await c.hold();const held=request('notebookRestore',prepare());await c.entered();
 try{const before=await c.snapshot();for(const [name,a]of Object.entries(peers)){const v=(await request(name,a.begin()))[a.key];assert.equal(read(name)?v.status:v.state,'busy',name);assert.deepEqual(await c.snapshot(),before);busy++;}}finally{await c.release();}
 assert.equal((await held).ordinary_restore.state,'ready');
 for(const [name,a]of Object.entries(peers)){
  await c.hold();const q=a.begin();if(['selectedArchive','handwritingRecords','notebookArchive'].includes(name))q.action='inspect';
  if(name==='storageInitialization'){const first=await request(name,q);q.action='confirm';q.reference=first.storage_initialization.reference;q.invocation=randomUUID();}
  const pending=request(name,q);await c.entered();try{const before=await c.snapshot();assert.equal((await request('notebookRestore',prepare())).ordinary_restore.state,'busy',name);assert.deepEqual(await c.snapshot(),before);busy++;}finally{await c.release();}
  let old=(await pending)[a.key];if(['selectedArchive','handwritingRecords','notebookArchive','storageInitialization'].includes(name))old=(await request(name,a.begin()))[a.key];
  assert.ok(read(name)?old.status==='reported':old.reference,name);
  const fresh=(await request('notebookRestore',prepare())).ordinary_restore;assert.equal(fresh.state,'ready');
  if(!read(name)){
   const stale=name==='notebookArchive'?requestFor('confirm-export',{reference:old.reference}):staleAction(name,a,old.reference);
   assert.ok(['invalidated','unavailable','not-dispatched'].includes((await request(name,stale))[a.key].state),name);invalidated++;
  }
  await request(name,a.begin());const before=await c.snapshot();assert.equal((await request('notebookRestore',requestFor('confirm',{reference:fresh.reference}))).ordinary_restore.state,'not-dispatched');assert.deepEqual(await c.snapshot(),before);invalidated++;
 }
 assert.equal(busy,2*Object.keys(peers).length);
 console.log(JSON.stringify({notebook_restore_peers:Object.keys(peers).length,busy_directions:busy,invalidated_previews:invalidated}));
}

export async function verifyNotebookRestoreUi(page,c,capture){
 await readFreshTabletState(page);
 const section=page.locator('section[aria-labelledby="notebook-restore-title"]'),field=section.locator('textarea'),status=page.getByTestId('notebook-restore-status');
 const preview=section.getByRole('button',{name:'Preview notebook restore',exact:true}),confirm=section.getByRole('button',{name:'Confirm notebook restore',exact:true});
 await field.fill(source);await preview.focus();await page.keyboard.press('Enter');await expect(status).toContainText('preview ready');await expect(field).toHaveValue('');
 await expect(section).toContainText('same existing local notebook store');
 for(const width of [390,1280]){await page.setViewportSize({width,height:1200});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await capture(width,'notebook-restore');}
 const before=await c.snapshot();await confirm.click();await expect(status).toContainText('unconfirmed');await expect(confirm).toHaveCount(0);
 assert.equal((await c.snapshot()).calls,before.calls+1);
 await section.getByRole('button',{name:'Check this notebook restore',exact:true}).last().click();await expect(status).toContainText('does not change the earlier restore result');
 await expect(page.getByTestId('notebook-restore-history')).toContainText('could not confirm');
 await c.restoreMode('restored');await field.fill(source);await preview.click();await confirm.click();await expect(status).toContainText('restored data was checked');
 for(const event of ['pagehide','hidden','refresh']){
  await field.fill(source);await preview.click();await expect(confirm).toBeEnabled();const before=await c.snapshot();
  if(event==='pagehide')await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  else if(event==='hidden')await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;});
  else await readFreshTabletState(page);
  await expect(confirm).toHaveCount(0);assert.equal((await c.snapshot()).calls,before.calls);
 }
 // Actual App's common guards and clear lists include both fixed restore controllers.
 if(await page.evaluate(()=>!!window.ng?.getComponent)){
  const edges=await page.evaluate(()=>{const a=window.ng.getComponent(document.querySelector('app-root')),c=a.notebookRestoreController,s=c.state;
   a.notebookRestore.set({...s,busy:true});
   const guards=[a.archiveMaintenanceBusy1(),a.archiveMaintenanceBusy2(),a.archiveMaintenanceBusy3(),a.selectedPeerBusy(),a.notebookPeerBusy(),a.restorePeerBusy(),a.handwritingPeerBusy(),a.managementPeerBusy(),a.cleanupPeerBusy(),a.conversationPeerBusy(),a.sourceCachePeerBusy(),a.productPeerBusy(),a.localModePeerBusy()];
   a.notebookRestore.set(s);const clears=[];for(const name of ['clearArchivePeers','clearSharedArchivePeers2','clearNotebookPeers','clearRestorePeers','clearManagementPeers','clearConversationPeers','clearSourceCachePeers']){c.setDraft('/private/draft');a[name]();clears.push(c.state.draft==='');}return {guards,clears};});
  assert.ok(edges.guards.every(Boolean));assert.ok(edges.clears.every(Boolean));
 }
 await field.fill(source);await c.hold();try{await preview.click();await c.entered();await expect(page.locator('#ordinary-restore-source')).toBeDisabled();await expect(page.getByRole('button',{name:'Preview notebook export',exact:true})).toBeDisabled();await section.getByRole('button',{name:'Stop notebook restore wait',exact:true}).click();}finally{await c.release();}
 await expect(status).toContainText('Stopped waiting');
 const html=await page.content();for(const secret of [source,'stdout_base64',identity.boot_id,identity.connection_id])assert.equal(html.includes(secret),false);
 console.log('Actual notebook restore UI: keyboard preview, cleared private input, one Apply, preserved uncertain history, current-only Status, lifecycle and peer boundaries pass');
}
