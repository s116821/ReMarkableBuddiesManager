// Host-private producer admission. Never import into renderer code.
import {createHash} from 'node:crypto';
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const fields=['intent_version','operation','document','config_path_sha256','config_bytes_sha256','roots_sha256','actor','generation','store_owner_sha256','cache_owner_sha256','namespace_owner_sha256','namespace_identity_sha256','entry_identity_sha256','entry_bytes','entry_sha256'];
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const refuse=()=>{throw Error('Cache cleanup report refused');};
export const cleanupHash=v=>createHash('sha256').update(v).digest('hex');
export function cleanupFrame(domain,parts){const h=createHash('sha256').update(domain,'ascii').update(Buffer.from([0]));for(const part of parts){const b=Buffer.from(String(part),'utf8'),size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(b.length));h.update(size).update(b);}return h.digest('hex');}
export const CLEANUP_CONFIG='/home/root/.config/remarkable-buddies/config.json';
const pathDigest=cleanupFrame('buddy-cache-config-path-v1',[CLEANUP_CONFIG]);
const length=v=>Number.isSafeInteger(v)&&v>=1&&v<=33554432;
export class CleanupUnsupported extends Error {constructor(){super('Cache cleanup unsupported');}}
export function parseCleanupIntent(v){
 if(keys(v)!==[...fields,'intent_sha256'].sort().join()||v.intent_version!==1||!['operation','document','actor','generation'].every(k=>basicUuid(v[k]))||!fields.filter(k=>k.endsWith('sha256')).concat('intent_sha256').every(k=>basicDigest(v[k]))||!length(v.entry_bytes)||v.config_path_sha256!==pathDigest||cleanupFrame('buddy-source-cache-cleanup-intent-v1',fields.map(k=>v[k]))!==v.intent_sha256)refuse();
 return Object.fromEntries([...fields,'intent_sha256'].map(k=>[k,v[k]]));
}
export function parseCleanupReport(v,selector,{document,operation,intent}={}){
 if(!v||!Number.isSafeInteger(v.report_version)||v.report_version<1)refuse();if(v.report_version!==1)throw new CleanupUnsupported();
 const statuses={prepare:['prepared','absent','conflict','unavailable','busy','unsupported','invalid-input'],apply:['applied','unknown','absent','conflict','unavailable','busy','unsupported','invalid-input'],status:['unchanged','absent','conflict','unavailable','busy','unsupported','invalid-input']};
 if(keys(v)!=='document,entry_bytes,entry_sha256,intent,operation,possible_effect,report_version,runtime_unverified,status'||!statuses[selector]?.includes(v.status)||v.operation!==selector||v.runtime_unverified!==true||v.possible_effect!==(selector==='apply'&&['applied','unknown'].includes(v.status)))refuse();
 if(v.status==='invalid-input'?v.document!==null:v.status==='unsupported'?v.document!==null&&v.document!==document:v.document!==document)refuse();
 if(v.document!==null&&!basicUuid(v.document))refuse();
 const present=v.entry_bytes!==null||v.entry_sha256!==null;
 if(present&&(!length(v.entry_bytes)||!basicDigest(v.entry_sha256)))refuse();
 const required=selector==='prepare'&&v.status==='prepared'||selector==='apply'&&['applied','unknown'].includes(v.status)||selector==='status'&&v.status==='unchanged';
 if(required?!present:present&&!(selector!=='prepare'&&v.status==='conflict'))refuse();
 let admitted=null;
 if(selector==='prepare'&&v.status==='prepared'){
  admitted=parseCleanupIntent(v.intent);if(admitted.operation!==operation||admitted.document!==document||admitted.entry_bytes!==v.entry_bytes||admitted.entry_sha256!==v.entry_sha256)refuse();
 }else if(v.intent!==null)refuse();
 if(selector!=='prepare'){const original=parseCleanupIntent(intent);if(original.document!==document)refuse();if(required&&(v.entry_bytes!==original.entry_bytes||v.entry_sha256!==original.entry_sha256))refuse();}
 return {report:{operation:selector,status:v.status,runtime_unverified:true,possible_effect:v.possible_effect},intent:admitted,preview:admitted?{document,entry_bytes:v.entry_bytes}:null};
}
export function parseCleanupRaw(raw,selector,context){
 if(raw.length>16384)refuse();const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(!text.endsWith('\n')||text.split('\n').length!==2)refuse();const v=strictJson(raw);if(text.charCodeAt(0)===0xfeff)refuse();return parseCleanupReport(v,selector,context);
}
