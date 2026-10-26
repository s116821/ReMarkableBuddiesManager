// Identity-only requests and safe metadata views. No producer owner data decoder.
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const refuse=()=>{throw Error('Source cache inventory response refused');};
const bytes=v=>{try{const s=JSON.stringify(v);if(typeof s!=='string')return refuse();return new TextEncoder().encode(s).length;}catch{return refuse();}};
export const CACHE_BYTE_BASIS='apparent-file-length-per-owned-slot; no-allocated-or-reclaimable-claim';
export function parseSourceCacheRequest(v){if(keys(v)!=='boot_id,connection_id'||!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||bytes(v)>256)refuse();return {connection_id:v.connection_id,boot_id:v.boot_id};}
export function parseSourceCacheView(v){
 if(keys(v)!=='byte_basis,cleanup_authority,entries,entry_payloads_read,entry_payloads_validated,runtime_unverified,source_freshness_verified,status,total_apparent_bytes'||!['ok','unavailable','unsupported','busy','conflict'].includes(v.status)||v.runtime_unverified!==true||v.cleanup_authority!==false||v.entry_payloads_read!==false||v.entry_payloads_validated!==false||v.source_freshness_verified!==false||v.byte_basis!==CACHE_BYTE_BASIS)refuse();
 if(v.status==='ok'){
  if(!Array.isArray(v.entries)||v.entries.length>16||!Number.isSafeInteger(v.total_apparent_bytes)||v.total_apparent_bytes<0||v.total_apparent_bytes>536870912)refuse();let previous=null,total=0;
  for(const e of v.entries){if(keys(e)!=='apparent_bytes,document'||!basicUuid(e.document)||previous!==null&&previous>=e.document||!Number.isSafeInteger(e.apparent_bytes)||e.apparent_bytes<0||e.apparent_bytes>33554432)refuse();previous=e.document;total+=e.apparent_bytes;}if(total!==v.total_apparent_bytes)refuse();
 }else if(v.entries!==null||v.total_apparent_bytes!==null)refuse();
 return {status:v.status,entries:v.entries===null?null:v.entries.map(e=>({document:e.document,apparent_bytes:e.apparent_bytes})),total_apparent_bytes:v.total_apparent_bytes,runtime_unverified:true,cleanup_authority:false,entry_payloads_read:false,entry_payloads_validated:false,source_freshness_verified:false,byte_basis:CACHE_BYTE_BASIS};
}
export function parseSourceCacheResult(v,request,validate){
 const q=parseSourceCacheRequest(request);if(keys(v)!=='contract_version,observation,source_cache_inventory,status'||bytes(v)>8192)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});const c=v.source_cache_inventory;
 if(keys(c)!=='status,view'||!['reported','unsupported','unavailable','busy'].includes(c.status))refuse();
 if(c.status==='reported'){if(v.status!=='observed'||v.observation.connection_id!==q.connection_id||v.observation.boot_id!==q.boot_id)refuse();parseSourceCacheView(c.view);}
 else if(c.view!==null||v.status!=='unconfigured'||v.observation!==null)refuse();return v;
}
