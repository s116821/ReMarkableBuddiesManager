// Host only: raw producer reports and owner/generation are never renderer DTOs.
import {strictJson} from './strict-json.mjs';
import {basicUuid} from './basic-settings-protocol.mjs';
import {parseSourceCacheView} from './source-cache-inventory-protocol.mjs';
export class SourceCacheUnsupported extends Error {constructor(){super('Source cache inventory unsupported');}}
export function parseSourceCacheReport(v){
 const refuse=()=>{throw Error('Source cache inventory report refused');};
 if(!v||typeof v!=='object'||Array.isArray(v)||!Number.isSafeInteger(v.report_version)||v.report_version<1)refuse();if(v.report_version!==1)throw new SourceCacheUnsupported();
 if(Object.keys(v).sort().join()!=='actor,byte_basis,cleanup_authority,entries,entry_payloads_read,entry_payloads_validated,generation,operation,report_version,runtime_unverified,source_freshness_verified,status,total_apparent_bytes'||v.operation!=='inspect-source-cache')refuse();
 if(v.status==='ok'){if(!basicUuid(v.actor)||!basicUuid(v.generation))refuse();}else if(v.actor!==null||v.generation!==null)refuse();
 const {actor,generation,report_version,operation,...view}=v;void actor;void generation;void report_version;void operation;return parseSourceCacheView(view);
}
export function parseSourceCacheRaw(raw){
 if(raw.length>8192)throw Error('Source cache inventory report refused');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(!text.endsWith('\n')||text.split('\n').length!==2)throw Error('Source cache inventory framing refused');strictJson(raw);return parseSourceCacheReport(JSON.parse(text));
}
