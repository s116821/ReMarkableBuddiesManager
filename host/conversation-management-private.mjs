// Host-private original-bound producer admission; never imported by renderer.
import {createHash} from 'node:crypto';
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const exact=(v,k)=>keys(v)===k.split(' ').sort().join();
const refuse=()=>{throw Error('Conversation management report refused');};
export const managementHash=v=>createHash('sha256').update(v).digest('hex');
export const MANAGEMENT_CONFIG='/home/root/.config/remarkable-buddies/config.json';
export class ManagementUnsupported extends Error {constructor(){super('Conversation management unsupported');}}
export function managementUuid(operation,role){
 const b=createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex')).update(`urn:remarkable-buddies:conversation-cleanup:v1:${operation}:${role}`,'utf8').digest().subarray(0,16);
 b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=4096;
const summary=v=>exact(v,'turns source_records export_associations')&&Object.values(v).every(count);
const fields=['intent_version','operation','conversation','config_path_sha256','config_bytes_sha256','roots_sha256','actor','generation','mode_sha256','target_history_sha256','root','binding','summary'];
export function parseManagementIntent(v){
 if(!exact(v,[...fields,'intent_sha256'].join(' '))||v.intent_version!==1||!['operation','conversation','actor','generation'].every(k=>basicUuid(v[k]))||!['config_path_sha256','config_bytes_sha256','roots_sha256','mode_sha256','target_history_sha256','intent_sha256'].every(k=>basicDigest(v[k]))||v.config_path_sha256!==managementHash(MANAGEMENT_CONFIG)||!exact(v.root,'revision sha256')||!basicUuid(v.root.revision)||!basicDigest(v.root.sha256)||!summary(v.summary))refuse();
 if(v.binding!==null&&(!exact(v.binding,'id revision sha256')||!basicUuid(v.binding.id)||!basicUuid(v.binding.revision)||!basicDigest(v.binding.sha256)))refuse();
 const prefix=Object.fromEntries(fields.map(k=>[k,v[k]]));prefix.root={revision:v.root.revision,sha256:v.root.sha256};prefix.binding=v.binding===null?null:{id:v.binding.id,revision:v.binding.revision,sha256:v.binding.sha256};prefix.summary={turns:v.summary.turns,source_records:v.summary.source_records,export_associations:v.summary.export_associations};
 if(managementHash('RMB-CONVERSATION-DELETE-V1\n'+JSON.stringify(prefix))!==v.intent_sha256)refuse();
 return {...prefix,intent_sha256:v.intent_sha256};
}
export function parseManagementReport(v,selector,{conversation,operation,intent}={}){
 if(!['inspect','prepare','apply','status'].includes(selector))refuse();
 if(!v||!Number.isSafeInteger(v.report_version)||v.report_version<1)refuse();if(v.report_version!==1)throw new ManagementUnsupported();
 if(!exact(v,'report_version operation status runtime_unverified local_only physical_reclamation service_observation possible_effect conversation intent receipt current_state summary')||v.operation!==selector||v.runtime_unverified!==true||v.local_only!==true||v.physical_reclamation!==false||!['inactive','unverified'].includes(v.service_observation)||typeof v.possible_effect!=='boolean'||v.conversation!==null&&v.conversation!==conversation||v.current_state!==null&&!['live-original','desired-tombstones','changed'].includes(v.current_state))refuse();
 const original=['apply','status'].includes(selector)?parseManagementIntent(intent):null;
 if(original&&original.conversation!==conversation)refuse();
 const empty=v.intent===null&&v.receipt===null&&v.summary===null;
 const selected=v.conversation===conversation;
 const inactive=v.service_observation==='inactive';let admitted=null,preview=null;
 switch(v.status){
 case 'ready':case 'prepared':
  if(selector!==(v.status==='ready'?'inspect':'prepare')||!selected||!inactive||v.possible_effect||v.current_state!=='live-original'||!summary(v.summary)||v.receipt!==null)refuse();
  if(v.status==='prepared'){admitted=parseManagementIntent(v.intent);if(admitted.conversation!==conversation||admitted.operation!==operation||JSON.stringify(admitted.summary)!==JSON.stringify({turns:v.summary.turns,source_records:v.summary.source_records,export_associations:v.summary.export_associations}))refuse();}else if(v.intent!==null)refuse();
  preview={conversation,turns:v.summary.turns,source_records:v.summary.source_records,export_associations:v.summary.export_associations};break;
 case 'acknowledged':{
  if(!original||!selected||!inactive||!v.possible_effect||v.current_state===null||v.intent!==null||v.summary!==null||!exact(v.receipt,'operation transaction root_revision binding_revision'))refuse();
  const r=v.receipt;if(r.operation!==original.operation||r.transaction!==managementUuid(original.operation,'transaction')||r.root_revision!==managementUuid(original.operation,'root-revision')||r.binding_revision!==(original.binding===null?null:managementUuid(original.operation,'binding-revision')))refuse();break;
 }
 case 'unchanged':if(selector!=='status'||!empty||!selected||!inactive||v.possible_effect||v.current_state!=='live-original')refuse();break;
 case 'unresolved':if(!original||!empty||!selected||!inactive||v.current_state===null||selector==='apply'&&!v.possible_effect)refuse();break;
 case 'unknown':if(!original||!empty||!selected||!v.possible_effect||!(v.service_observation==='unverified'&&v.current_state===null||selector==='apply'&&inactive&&v.current_state==='live-original'))refuse();break;
 case 'invalid-input':case 'unavailable':case 'unsupported':case 'busy':case 'conflict':
  if(!empty||v.current_state!==null||v.status==='invalid-input'&&v.conversation!==null)refuse();
  if(v.possible_effect&&!(original&&v.status==='conflict'&&inactive&&selected))refuse();break;
 default:refuse();
 }
 return {intent:admitted,preview,report:{operation:selector,status:v.status,runtime_unverified:true,local_only:true,physical_reclamation:false,service_observation:v.service_observation,possible_effect:v.possible_effect,current_state:v.current_state}};
}
export function parseManagementRaw(raw,selector,context){
 if(raw.length>32768)refuse();const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(!text.endsWith('\n')||text.split('\n').length!==2||text.charCodeAt(0)===0xfeff)refuse();return parseManagementReport(strictJson(raw),selector,context);
}
