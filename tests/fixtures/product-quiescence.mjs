import {expect} from '@playwright/test';
import assert from 'node:assert/strict';
export async function verifyProductQuiescence(page,control){
 if(!await page.evaluate(()=>!!window.ng?.getComponent))return;
 const begin=page.getByRole('button',{name:'Begin product settings edit',exact:true}),status=page.getByTestId('product-settings-status');
 for(const mode of ['before-dispatch','late-reply','stop-before-dispatch','expire-before-dispatch']){
  await expect.poll(()=>page.evaluate(()=>{const a=window.ng.getComponent(document.querySelector('app-root'));return a.productPeerBusy()||a.product().busy;})).toBe(false);
  const poll=await control.holdPoll(mode);await page.evaluate(()=>{const a=window.ng.getComponent(document.querySelector('app-root'));void a.connectionController.read(a.connectionController.generation);});await poll.entered();const before=await control.snapshot();
  await begin.click();await expect(status).toContainText('Pausing observation');await page.waitForTimeout(80);assert.deepEqual(await control.snapshot(),before,'queued observation cannot dispatch inspect or global cancel');
  if(mode==='stop-before-dispatch')await page.getByRole('button',{name:'Stop settings wait',exact:true}).click();
  if(mode==='expire-before-dispatch'){await expect(status).toContainText('unavailable or response refused',{timeout:16000});assert.deepEqual(await control.snapshot(),before);}
  await poll.release();
  if(['stop-before-dispatch','expire-before-dispatch'].includes(mode)){await page.waitForTimeout(100);assert.deepEqual(await control.snapshot(),before,'late observation cannot dispatch stopped/expired edit');}else await expect(status).toContainText('ready to edit');
  await poll.cleanup();console.log('Actual product observation quiescence '+mode);
 }
}
