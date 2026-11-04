import {strictJson} from './strict-json.mjs';
import {parseSavedModeReport} from './saved-mode.mjs';
const fail=()=>{throw Error('Storage preparation report refused');};
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
export function parseStorageInitializationRaw(raw,operation){
 if(!['initialize','inspect'].includes(operation)||raw.length>16384)fail();
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(text.charCodeAt(0)===0xfeff||!text.endsWith('\n')||text.split('\n').length!==2)fail();strictJson(raw);
 const v=JSON.parse(text,(_k,value,context)=>{if(typeof value==='number'&&context?.source!=='1')fail();return value;});
 if(keys(v)!=='activation_performed,data,incomplete,operation,report_version,status'||v.report_version!==1||v.operation!==operation||!['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'].includes(v.status)||typeof v.incomplete!=='boolean'||v.activation_performed!==false)fail();
 if(v.status!=='ok'){if(v.data!==null)fail();return {current:null,reason:v.status==='busy'?'busy':v.status==='unsupported'?'unsupported':'unavailable'};}
 if(v.incomplete||keys(v.data)!=='current_snapshot,receipt,receipt_status'||v.data.receipt!==null||v.data.receipt_status!==null)fail();
 // Reuse only nested snapshot admission, after the new original selector/status gate.
 // This typed envelope is not an incoming Initialize report admitted as Inspect.
 const nested=parseSavedModeReport({report_version:1,operation:'inspect',status:'ok',incomplete:false,activation_performed:false,data:{current_snapshot:v.data.current_snapshot,receipt:null,receipt_status:null}});
 return {current:{kind:nested.snapshot.kind},reason:null};
}
