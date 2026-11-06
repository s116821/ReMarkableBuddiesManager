// Synthetic producer-contract reports, not tablet or producer execution evidence.
// Basis: Buddy e664c2e, ordinary notebook archive restore version 2.
import assert from 'node:assert/strict';
import {restoreFixture} from './ordinary-restore.mjs';
export {source,tablet,identity,defer} from './ordinary-restore.mjs';
export const notebookPreview={
 source:{manifests:2,objects:4,complete_media:true,configuration_included:true},
 target:{manifests:5,objects:9,complete_media:true,configuration_included:true},
 additional_manifests:1,additive:true,configuration_applied:false,
};
export const notebookIntent={
 restore_version:2,operation:'11111111-1111-4111-8111-111111111111',
 config_path_sha256:'d3a31c5071331a3c319302c10f6ae33c00e3b70d8210e05a37fbe12f03343835',
 config_sha256:'1'.repeat(64),
 source_path_sha256:'5819e28d8299f125f649ca291d9d14894a9e4f92b42adabde95fe9b51d2b55d6',
 archive_sha256:'2'.repeat(64),actor:'22222222-2222-4222-8222-222222222222',
 mode_sha256:'3'.repeat(64),base_generation:'33333333-3333-4333-8333-333333333333',
 base_history_sha256:'4'.repeat(64),target_generation:'44444444-4444-4444-8444-444444444444',
 target_history_sha256:'5'.repeat(64),staged_configuration_sha256:'6'.repeat(64),complete_media:true,
};
export function notebookReport(selector,body,state={apply:'unknown',status:'unresolved'}){
 assert.ok(['prepare-notebook','apply-notebook','status-notebook'].includes(selector));
 const prepare=selector==='prepare-notebook',apply=selector==='apply-notebook';
 if(prepare)assert.equal(body.restore_version,2);else assert.equal(body.intent.restore_version,2);
 const outcome=prepare?'prepared':apply?state.apply:state.status;
 return {report_version:2,operation:selector,status:['unknown','not-activated'].includes(outcome)?'failed':'ok',outcome,
  disk_readback_verified:apply&&outcome==='restored',runtime_activation:'unverified',
  data:prepare?{preview:structuredClone(notebookPreview),intent:{...notebookIntent,operation:body.operation}}:
   ['restored','desired-generation-observed'].includes(outcome)?{inspection:structuredClone(notebookPreview.target),configuration_applied:false}:null};
}
export const notebookFixture=options=>restoreFixture({family:'notebook',report:notebookReport,...options});
export function addNotebookRestoreFixture(f){
 const state={apply:'unknown',status:'desired-generation-observed'},previous=f.observer.run;
 f.observer.run=async function(action,q){
  if(action!=='ordinary-restore'||!q.selector.endsWith('-notebook'))return previous.call(this,action,q);
  const body=JSON.parse(Buffer.from(q.input_base64,'base64'));
  f.calls.push({action,selector:q.selector,body:structuredClone(body)});
  const report=notebookReport(q.selector,body,state);
  return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),ordinary_restore_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(report)+'\n').toString('base64')}};
 };
 return {...f,notebookRestoreState:state};
}
