import {expect} from '@playwright/test';
import assert from 'node:assert/strict';
const stamp=page=>page.getByText(/^Observed at /);
const read=page=>page.getByRole('button',{name:'Read tablet state',exact:true});
async function waitForFreshObservation(page,previous){
 await expect.poll(async()=>{const current=await stamp(page).allTextContents();return current.length===1&&(previous.length!==1||current[0]!==previous[0]);}).toBe(true);
}
export async function readFreshTabletState(page){
 const previous=await stamp(page).allTextContents();await read(page).click();await waitForFreshObservation(page,previous);await page.getByTestId('tablet-model').waitFor();
}
export async function verifyStorageInitializationReadRace(page,control){
 if(!await page.evaluate(()=>!!window.ng?.getComponent))return;
 const review=page.getByRole('button',{name:'Review storage setup',exact:true}),confirm=page.getByRole('button',{name:'Prepare storage',exact:true}),previous=await stamp(page).allTextContents(),before=await control.snapshot();
 let release,enter;const held=new Promise(r=>{release=r;}),entered=new Promise(r=>{enter=r;});let settled=false,pending;
 const handler=async route=>{if(route.request().postDataJSON().action!=='observe')return route.continue();const response=await route.fetch();enter();await held;await route.fulfill({response});};
 await page.route('**/manager-host',handler);
 // Delay rendering as well as the real observation reply: the old enabled DOM
 // remains visible while the actual connection/controller is already checking.
 await page.clock.pauseAt(await page.evaluate(()=>Date.now()+100));
 try{
  await read(page).evaluate(button=>button.click());await entered;
  pending=waitForFreshObservation(page,previous).then(()=>{settled=true;});
  await page.getByTestId('tablet-model').waitFor();await expect(review).toBeEnabled();await review.focus();await expect(review).toBeFocused();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.ng.getComponent(document.querySelector('app-root')).connection().status),'checking');
  assert.equal(await confirm.count(),0,'old DOM/keyboard sequence must not bypass the real currentness guard');
  assert.equal(settled,false,'fresh-read wait cannot accept the old observed timestamp');
  const after=await control.snapshot();assert.deepEqual([after.all,after.calls],[before.all,before.calls],'stale keyboard action sends no storage command');
 }finally{release();await page.clock.resume();if(pending)await pending;await page.unroute('**/manager-host',handler);}
 await expect(review).toBeEnabled();await review.focus();await expect(review).toBeFocused();await page.keyboard.press('Enter');await expect(confirm).toBeEnabled();
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await expect(confirm).toHaveCount(0);
 console.log('Actual delayed observation/render reproduces stale-DOM keyboard refusal; fresh observation admits keyboard review');
}
