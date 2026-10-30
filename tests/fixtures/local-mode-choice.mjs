// Synthetic producer/transport controls; not device, provider or original-byte evidence.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LocalModeChoiceHost} from '../../host/local-mode-choice.mjs';
import {MaintenanceIO} from '../../host/maintenance-io.mjs';
import {tablet} from './memory-inspection.mjs';
export {tablet};
const reports=Object.fromEntries(JSON.parse(await readFile(new URL('./local-mode-choice-reports.json',import.meta.url))).map(x=>[x.name,JSON.parse(x.report_utf8)]));
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity=s=>({connection_id:s.connection_id,boot_id:s.boot_id});
export function localModeFixture(options={}){
 let clock=0,serial=0,chooseCount=0,current=structuredClone(reports['inspect-unconfigured']),pending;
 const calls=[],io=options.io??new MaintenanceIO();
 const observer={lastObservation:structuredClone(tablet),cancel(){},async run(action,q){
  assert.equal(action,'local-mode-choice');calls.push(structuredClone(q));
  let report;
  if(q.selector==='inspect')report=structuredClone(current);
  else{
   chooseCount++;const original=JSON.parse(Buffer.from(q.input_base64,'base64'));
   assert.equal(original.choice.kind,'local-only');
   const chosen=structuredClone(reports['choose-local-current']);chosen.data.receipt.operation=original.operation;chosen.data.receipt.expected=original.expected.sha256;chosen.data.receipt.request_sha256=hash(JSON.stringify([original.expected.actor,original.expected.sha256,original.choice]));
   chosen.data.receipt.epoch=`44444444-4444-4444-8444-${String(chooseCount).padStart(12,'0')}`;chosen.data.current_snapshot.epoch=chosen.data.receipt.epoch;chosen.data.current_snapshot.token.sha256=hash('mode'+chooseCount);
   current={...chosen,operation:'inspect',data:{current_snapshot:chosen.data.current_snapshot,receipt:null,receipt_status:null}};
   report=options.report?options.report(chosen):chosen;
   if(options.delay)await new Promise(resolve=>{pending=resolve;});
  }
  const stdout=options.raw&&q.selector==='choose'?options.raw:JSON.stringify(report)+'\n';
  return {contract_version:1,status:'observed',observation:structuredClone(observer.lastObservation),local_mode_raw:{status:'reported',stdout_base64:Buffer.from(stdout).toString('base64')}};
 }};
 let host;host=new LocalModeChoiceHost({observer,io,now:()=>clock,uuid:()=> '22222222-2222-4222-8222-222222222222',reference:()=>hash(String(++serial)),beforeIO:()=>options.beforeIO?.(host)});
 const begin=()=>host.request({action:'begin',...identity(observer.lastObservation)});
 const request=(action,reference)=>host.request({action,...identity(observer.lastObservation),reference});
 return {host,observer,io,calls,begin,request,setClock:v=>{clock=v;},get chooseCount(){return chooseCount;},get savedEpoch(){return current.data.current_snapshot.epoch;},release:()=>pending(),setCurrent:v=>{current=structuredClone(v);}};
}
