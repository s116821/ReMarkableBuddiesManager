import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IsolatedRootHost} from '../../host/isolated-root.mjs';
import {MaintenanceIO} from '../../host/maintenance-io.mjs';
import {isolatedRootHash} from '../../host/isolated-root-records.mjs';
import {tablet} from './memory-inspection.mjs';

const original=JSON.parse(readFileSync(new URL('./isolated-root-provisioning/current.json',import.meta.url)));
const historical=JSON.parse(readFileSync(new URL('./isolated-root-provisioning/historical.json',import.meta.url)));
const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const identity=sample=>({connection_id:sample.connection_id,boot_id:sample.boot_id});
const view=v=>v.isolated_root_preparation;
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
function setup(options={}){
 let clock=0,sequence=0,waits=0,lastWait,release;
 const wait=()=>lastWait=id(1000+(++waits));
 const calls=[],io=new MaintenanceIO(),store={value:null,
  isolatedRootOperations(){if(options.readFailure)throw Error('private-secret');return {value:sorted(this.value),digest:this.value?isolatedRootHash(JSON.stringify(this.value)):null};},
  appendIsolatedRootOperation(record,expected){
   if(options.writeFailure==='before')throw Error('private-secret');
   assert.equal(expected,this.isolatedRootOperations().digest);
   this.value??={version:1,originals:[]};this.value.originals.push(structuredClone(record));
   if(options.writeFailure==='after')throw Error('private-secret');
   if(options.storageDelay)clock+=options.storageDelay;
   return {committed:true,digest:this.isolatedRootOperations().digest};
  }};
 const observer={generation:0,lastObservation:structuredClone(tablet),cancelCount:0,cancel(){this.cancelCount++;this.generation++;},
  async run(action,request){
   assert.equal(action,'local-mode-choice');calls.push(structuredClone(request));
   let report;
   if(request.selector==='inspect'){
    if(options.inspectDelay)await new Promise(resolve=>{release=resolve;});
    if(options.inspectReject)throw Error('private-secret');
    report={report_version:1,operation:'inspect',status:'ok',incomplete:false,activation_performed:false,
     data:{current_snapshot:structuredClone(options.snapshot??original.data.current_snapshot),receipt:null,receipt_status:null}};
   }else{
    assert.equal(request.selector,'provision-isolated-backup');
    assert.ok(store.value.originals.some(r=>r.input_base64===request.input_base64),'persisted exact input before dispatch');
    if(options.delay)await new Promise(resolve=>{release=resolve;});
    if(options.reject)throw Error('private-secret');
    if(options.cancelled)return {contract_version:1,status:'cancelled',observation:null};
    report=structuredClone(options.report??original);
    if(report.data?.isolated_root)report.data.isolated_root.operation=JSON.parse(Buffer.from(request.input_base64,'base64')).operation;
   }
   const raw=request.selector!=='inspect'&&options.raw!==undefined?options.raw:JSON.stringify(report)+'\n';
   return {contract_version:1,status:'observed',observation:structuredClone(observer.lastObservation),
    local_mode_raw:{status:'reported',stdout_base64:Buffer.from(raw).toString('base64')}};
  }};
 const makeHost=()=>new IsolatedRootHost({observer,store,io,now:()=>clock,budgetMs:options.budgetMs??45000,
  uuid:()=>original.data.isolated_root.operation,reference:()=>isolatedRootHash('reference'+(++sequence))});
 let host=makeHost();
 return {options,observer,store,io,calls,get host(){return host;},get wait(){return lastWait;},get release(){return release;},setClock:n=>{clock=n;},
  restart(){host.dispose();host=makeHost();},
  begin:()=>host.request({action:'begin',wait_id:wait(),...identity(observer.lastObservation)}),
  request:(action,reference)=>host.request({action,reference,wait_id:wait(),...identity(observer.lastObservation)})};
}

export {original,historical,id,identity,view,setup};
