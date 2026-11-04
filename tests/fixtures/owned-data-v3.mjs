// Synthetic producer controls behind actual host coordinators; no tablet evidence.
import {readFileSync} from 'node:fs';
import {conversationFixture} from './conversation-inventory.mjs';
import {addManagementFixture} from './conversation-management.mjs';
import {addRestoreFixture,tablet} from './ordinary-restore.mjs';
import {addSelectedFixture} from './selected-archive.mjs';
import {addHandwritingFixture} from './handwriting-records.mjs';
import {addProductFixture} from './product-settings.mjs';
export {tablet};
export const vectors=JSON.parse(readFileSync(new URL('./owned-data-v3-vectors.json',import.meta.url))).cases;
export const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
export function generation4Fixture(){
 const f=addProductFixture(addHandwritingFixture(addSelectedFixture(addRestoreFixture(addManagementFixture(conversationFixture()))))),previous=f.observer.run;
 f.v3={raw:vectors[0].raw_utf8,reads:0,calls:0,active:0,gate:null};
 f.observer.run=async function(action,q){
  f.v3.active++;try{f.v3.calls++;const gate=f.v3.gate;if(gate){gate.entered=true;await gate.promise;}
  if(action==='local-mode-choice'){const reports=JSON.parse(readFileSync(new URL('./local-mode-choice-reports.json',import.meta.url)));const raw=q.selector==='inspect'?reports.find(x=>x.name==='inspect-unconfigured').report_utf8:'partial';return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),local_mode_raw:{status:'reported',stdout_base64:Buffer.from(raw).toString('base64')}};}
  if(action!=='owned-data-v3')return await previous.call(this,action,q);
  f.v3.reads++;return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),owned_data_v3_raw:{status:'reported',stdout_base64:Buffer.from(f.v3.raw).toString('base64')}};
  }finally{f.v3.active--;}
 };
 return f;
}
