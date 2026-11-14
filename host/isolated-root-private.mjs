// Privileged host only. Conditional tokens and provider bindings never enter IPC.
import {strictJson} from './strict-json.mjs';
import {parseSavedModeReport} from './saved-mode.mjs';
import {localModeDigest,localModeUuid} from './local-mode-choice-protocol.mjs';

const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const refuse=()=>{throw Error('Isolated backup preparation response refused');};
const statuses=['ok','invalid-input','unsupported','unavailable','busy','conflict','failed'];
const outcomes=Object.freeze({
 'root-verified':['ok',false],
 'outcome-unknown':['unavailable',true],
 'authorization-required':['unavailable',true],
 'retry-later':['unavailable',true],
 'recovery-required':['failed',true],
 'provider-binding-unqualified':['unsupported',false]
});
export class IsolatedRootUnsupported extends Error {
 constructor(){super('Isolated backup preparation unsupported');}
}
function frame(raw){
 if(!(raw instanceof Uint8Array)||raw.byteLength<1||raw.byteLength>16384)refuse();
 try{
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
  if(text.charCodeAt(0)===0xfeff||!text.endsWith('\n')||text.split('\n').length!==2)refuse();
  return strictJson(raw);
 }catch{refuse();}
}
function savedSnapshot(value){
 return parseSavedModeReport({report_version:1,operation:'inspect',status:'ok',
  incomplete:false,activation_performed:false,
  data:{current_snapshot:value,receipt:null,receipt_status:null}}).snapshot;
}
export function parseIsolatedRootInput(value){
 if(keys(value)!=='control_version,expected,operation'||value.control_version!==1||
  !localModeUuid(value.operation)||keys(value.expected)!=='actor,sha256'||
  !localModeUuid(value.expected.actor)||!localModeDigest(value.expected.sha256))refuse();
 return {control_version:1,operation:value.operation,
  expected:{actor:value.expected.actor,sha256:value.expected.sha256}};
}
function context(value){
 if(keys(value)!=='input,snapshot')refuse();
 const input=parseIsolatedRootInput(value.input),view=savedSnapshot(value.snapshot);
 if(view.kind!=='isolated-backup'||value.snapshot.token.actor!==input.expected.actor||
  value.snapshot.token.sha256!==input.expected.sha256)refuse();
 return {input,snapshot:value.snapshot,view};
}

// The caller supplies a newly owned operation UUID, never a renderer-supplied one.
// Retain this complete private context and the exact serialized input before send.
export function prepareIsolatedRoot(rawInspect,operation){
 const report=frame(rawInspect),parsed=parseSavedModeReport(report);
 if(parsed.status!=='ok'||parsed.incomplete||parsed.snapshot?.kind!=='isolated-backup')refuse();
 const original={input:parseIsolatedRootInput({control_version:1,operation,
  expected:report.data.current_snapshot.token}),snapshot:structuredClone(report.data.current_snapshot)};
 context(original);
 return original;
}

export function parseIsolatedRootRaw(raw,original){
 const retained=context(original),report=frame(raw);
 if(!Number.isSafeInteger(report?.report_version)||report.report_version<1)refuse();
 if(report.report_version!==1)throw new IsolatedRootUnsupported();
 if(keys(report)!=='activation_performed,data,incomplete,operation,report_version,status'||
  report.operation!=='provision-isolated-backup'||!statuses.includes(report.status)||
  typeof report.incomplete!=='boolean'||report.activation_performed!==false)refuse();
 const reduced={status:report.status,incomplete:report.incomplete,current:null,result:null};
 if(report.data===null){if(report.status==='ok')refuse();return reduced;}
 const data=report.data,shape=keys(data);
 // The producer omits isolated_root when it has no valid result custody.
 if(!['current_snapshot,receipt,receipt_status','current_snapshot,isolated_root,receipt,receipt_status'].includes(shape)||
  data.receipt!==null||data.receipt_status!==null)refuse();
 reduced.current=savedSnapshot(data.current_snapshot);
 if(data.current_snapshot.token.actor!==retained.input.expected.actor)refuse();
 if(!Object.hasOwn(data,'isolated_root')){if(report.status==='ok')refuse();return reduced;}
 const root=data.isolated_root;
 if(keys(root)!=='backup,currency,device,epoch,operation,outcome'||
  root.operation!==retained.input.operation||root.device!==retained.view.device||
  root.backup!==retained.view.backup||root.epoch!==retained.view.epoch||
  typeof root.outcome!=='string'||!Object.hasOwn(outcomes,root.outcome)||
  !['current','historical'].includes(root.currency))refuse();
 const [status,incomplete]=outcomes[root.outcome];
 if(report.status!==status||report.incomplete!==incomplete)refuse();
 // An admitted original cannot lose its Store's persisted device or become
 // unconfigured. The producer keeps one immutable token/choice per epoch.
 if(reduced.current.device!==retained.view.device||reduced.current.kind==='unconfigured')refuse();
 const current=reduced.current.epoch===retained.view.epoch;
 const originalToken=data.current_snapshot.token.sha256===retained.input.expected.sha256;
 const originalBackup=reduced.current.kind==='isolated-backup'&&reduced.current.backup===retained.view.backup;
 if(originalBackup&&data.current_snapshot.mode.binding_sha256!==retained.snapshot.mode.binding_sha256)refuse();
 if(current?(!originalToken||!originalBackup):originalToken)refuse();
 if(root.currency!==(current?'current':'historical'))refuse();
 reduced.result={device:root.device,backup:root.backup,epoch:root.epoch,
  outcome:root.outcome,currency:root.currency};
 return reduced;
}
