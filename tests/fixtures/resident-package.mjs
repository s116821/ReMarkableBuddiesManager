import {serviceStopFixture} from './service-stop.mjs';
export {tablet,identity} from './service-stop.mjs';
export const packageBinding=Object.freeze({id:'b'.repeat(64),installed_version:'1.2.3-r2',candidate_version:'1.2.4-r0'});
export function residentPackageFixture(){
 const f=serviceStopFixture(),previous=f.observer.run;f.package={calls:[],phase:0};
 f.observer.run=async function(action,q){
  if(action!=='resident-package')return previous.call(this,action,q);
  f.initialization.all++;if(f.initialization.gate){f.initialization.gate.entered=true;await f.initialization.gate.promise;}
  f.package.calls.push(structuredClone(q));
  if(q.selector==='continue')f.package.phase++;
  const outcome=q.selector==='review'?'ready':f.package.phase===0?'prepared':f.package.phase===1?'disabled':'removed';
  const state=q.selector==='review'?'ready':q.selector==='execute'?'unknown':f.package.phase>=2?'completed':'continuable';
  return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),resident_package_raw:{state,current:state==='unknown'?null:{phase:outcome==='ready'?'review':outcome==='prepared'?'recovery':outcome==='disabled'?'disable':'package',outcome,installed_version:packageBinding.installed_version,candidate_version:q.operation==='replace'?packageBinding.candidate_version:null,data_preserved:true},context:{activation:q.boot_id,proof_sha256:'a'.repeat(64),operation_id:q.expected?.operation_id??null},retained:[]}};
 };return f;
}
