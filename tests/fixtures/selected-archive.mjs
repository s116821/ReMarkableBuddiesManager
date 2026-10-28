import {SelectedArchiveHost} from '../../host/selected-archive.mjs';
export {tablet,defer} from './ordinary-restore.mjs';
export const archivePath='/home/root/backups/history-new';
export function addSelectedFixture(f){
 const state={failExport:true,completeMedia:true,format:2,onRaw:null,hooks:0},previous=f.observer.run;
 f.observer.run=async function(action,q){if(action!=='selected-archive')return previous.call(this,action,q);
  const body=JSON.parse(Buffer.from(q.input_base64,'base64'));f.calls.push({action,selector:q.selector,body});
  const failed=q.selector==='export-selected'&&state.failExport;
  let report={report_version:1,operation:q.selector,status:failed?'failed':'ok',incomplete:failed||!state.completeMedia,activation_performed:false,data:failed?null:{inspection:{format:q.selector==='inspect'?state.format:2,manifests:2,objects:7,selected_scopes:q.selector==='inspect'&&state.format!==2?0:1,selection_receipts:q.selector==='inspect'&&state.format!==2?0:2,complete_media:state.completeMedia,configuration_included:q.selector==='inspect'&&state.format!==2}}};
  if(state.onRaw)report=await state.onRaw(report,q);
  return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),archive_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(report)+'\n').toString('base64')}};
 };
 const selected=new SelectedArchiveHost({observer:f.observer,io:f.io}),lanes={...f.lanes,selected};
 for(const [name,h]of Object.entries(lanes))h.beforeIO=()=>{state.hooks++;for(const [other,peer]of Object.entries(lanes))if(name!==other)peer.invalidate();};
 return {...f,selected,selectedState:state,lanes};
}
