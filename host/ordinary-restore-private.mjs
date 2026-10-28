// Host-private producer admission; never imported by the renderer.
import {createHash} from 'node:crypto';
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
import {restorePath,restoreSummary,restorePreview,restorePublicReport} from './ordinary-restore-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const exact=(v,k)=>keys(v)===k.split(' ').sort().join();
const refuse=()=>{throw Error('Ordinary restore report refused');};
export const restoreHash=v=>createHash('sha256').update(v).digest('hex');
export const RESTORE_CONFIG='/home/root/.config/remarkable-buddies/config.json';
export const restorePathHash=(kind,path)=>restoreHash(`urn:remarkable-buddies:ordinary-restore-${kind}-path:v1:${path}`);
export class RestoreUnsupported extends Error{constructor(){super('Ordinary restore unsupported');}}
const fields=['restore_version','operation','config_path_sha256','config_sha256','source_path_sha256','archive_sha256','actor','mode_sha256','base_generation','base_history_sha256','target_generation','target_history_sha256','staged_configuration_sha256','complete_media'];
export function parseRestoreIntent(v,{source,operation}={}){
 if(!exact(v,fields.join(' '))||v.restore_version!==1||!['operation','actor','base_generation','target_generation'].every(k=>basicUuid(v[k]))||v.base_generation===v.target_generation||!['config_path_sha256','config_sha256','source_path_sha256','archive_sha256','mode_sha256','base_history_sha256','target_history_sha256'].every(k=>basicDigest(v[k]))||v.staged_configuration_sha256!==null&&!basicDigest(v.staged_configuration_sha256)||typeof v.complete_media!=='boolean'||v.config_path_sha256!==restorePathHash('config',RESTORE_CONFIG)||source!==undefined&&(!restorePath(source)||v.source_path_sha256!==restorePathHash('source',source))||operation!==undefined&&v.operation!==operation)refuse();
 return Object.fromEntries(fields.map(k=>[k,v[k]]));
}
export function parseRestoreReport(v,selector,context={}){
 if(!['prepare','apply','status'].includes(selector)||!v||!Number.isSafeInteger(v.report_version)||v.report_version<1)refuse();if(v.report_version!==1)throw new RestoreUnsupported();
 if(!exact(v,'report_version operation status outcome disk_readback_verified runtime_activation data'))refuse();
 const report=restorePublicReport(Object.fromEntries(['operation','status','outcome','disk_readback_verified','runtime_activation'].map(k=>[k,v[k]])),selector);
 let intent=null,preview=null,inspection=null;
 if(v.status!=='ok'){if(v.data!==null)refuse();}
 else if(selector==='prepare'){
  if(!exact(v.data,'preview intent'))refuse();preview=restorePreview(v.data.preview);intent=parseRestoreIntent(v.data.intent,context);
  if(intent.complete_media!==preview.target.complete_media||(intent.staged_configuration_sha256!==null)!==preview.target.configuration_included)refuse();
 }else{
  const original=parseRestoreIntent(context.intent,{source:context.source,operation:context.operation});
  if(v.outcome==='unresolved'){if(v.data!==null)refuse();}
  else{if(!exact(v.data,'inspection configuration_applied')||v.data.configuration_applied!==false)refuse();inspection=restoreSummary(v.data.inspection);const target=restoreSummary(context.preview.target);if(JSON.stringify(inspection)!==JSON.stringify(target)||inspection.complete_media!==original.complete_media||(original.staged_configuration_sha256!==null)!==inspection.configuration_included)refuse();}
 }
 return {intent,preview,inspection,report};
}
export function parseRestoreRaw(raw,selector,context){if(raw.length>16384)refuse();const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(!text.endsWith('\n')||text.split('\n').length!==2||text.charCodeAt(0)===0xfeff)refuse();return parseRestoreReport(strictJson(raw),selector,context);}
