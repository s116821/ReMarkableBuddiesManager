import {NotebookArchiveHost} from '../../host/notebook-archive.mjs';
export {tablet,defer} from './ordinary-restore.mjs';
export const archivePath='/home/root/backups/history-new';
export function addNotebookFixture(f){
 const state={failExport:true,completeMedia:true,format:4,onRaw:null,hooks:0},previous=f.observer.run;
 f.observer.run=async function(action,q){if(action!=='notebook-archive')return previous.call(this,action,q);
  const body=JSON.parse(Buffer.from(q.input_base64,'base64'));f.calls.push({action,selector:q.selector,body});
  const failed=q.selector==='export-notebook'&&state.failExport;
  let report={report_version:1,operation:q.selector,status:failed?'failed':'ok',incomplete:failed||!state.completeMedia,activation_performed:false,data:failed?null:{inspection:{format:q.selector==='inspect-notebook'?state.format:4,manifests:2,objects:7,selected_scopes:0,selection_receipts:0,complete_media:state.completeMedia,configuration_included:true}}};
  if(state.onRaw)report=await state.onRaw(report,q);
  return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),archive_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(report)+'\n').toString('base64')}};
 };
 const selected=new NotebookArchiveHost({observer:f.observer,io:f.io}),lanes={...f.lanes,selected};
 for(const [name,h]of Object.entries(lanes))h.beforeIO=()=>{state.hooks++;for(const [other,peer]of Object.entries(lanes))if(name!==other)peer.invalidate();};
 return {...f,selected,notebookState:state,lanes};
}
