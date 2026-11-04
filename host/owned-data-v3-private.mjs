// Host only. Original numeric spelling is checked before any report value is admitted.
import {strictJson} from './strict-json.mjs';
import {basicUuid} from './basic-settings-protocol.mjs';
import {parseOwnedV3View,exact,refuse,FALSE_FLAGS} from './owned-data-v3-protocol.mjs';
const PRIVATE=['owner_actor','current_generation','byte_basis','lease_identity_check','excluded_scopes'];
export function parseOwnedV3Raw(raw){
 if(raw.length>32768)refuse();const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
 if(text.charCodeAt(0)===0xfeff||!text.endsWith('\n')||text.split('\n').length!==2)refuse();strictJson(raw);
 const v=JSON.parse(text,(_key,value,context)=>{if(typeof value==='number'&&(!context||typeof context.source!=='string'||!/^(?:0|[1-9][0-9]*)(?![\s\S])/.test(context.source)))refuse();return value;});
 const publicKeys='status current_generation_format retained_generation_formats observed_files observed_apparent_bytes complete_apparent_bytes storage observed_domains observed_notebook_records domain_accounting_complete cache_inspected shared_media_files shared_media_apparent_bytes issues'.split(' ').concat(FALSE_FLAGS);
 exact(v,['report_version',...publicKeys,...PRIVATE]);if(v.report_version!==3)refuse();
 for(const k of ['owner_actor','current_generation'])if(v[k]!==null&&!basicUuid(v[k]))refuse();
 if(v.byte_basis!=='apparent-file-length-per-owned-path; data-and-cache-only; no-allocated-or-reclaimable-claim'||!['device-inode','unavailable'].includes(v.lease_identity_check)||JSON.stringify(v.excluded_scopes)!==JSON.stringify(['credentials','native-documents','legacy-cache','external-transient-diagnostics']))refuse();
 if(v.status==='complete'&&(!basicUuid(v.owner_actor)||!basicUuid(v.current_generation)||v.lease_identity_check!=='device-inode'))refuse();
 const view={schema_version:1};for(const k of publicKeys)view[k]=v[k];return parseOwnedV3View(view);
}
