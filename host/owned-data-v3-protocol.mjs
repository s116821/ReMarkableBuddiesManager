// Separate reduced accounting DTO; raw owner/custody fields never reach the renderer.
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
export const STORAGE=Object.freeze(["structural", "record-metadata", "media-object", "unclassified-object", "retained-generation", "cache", "diagnostics", "staging"]);
export const DOMAINS=Object.freeze(["conversation", "source", "export-association", "subject-memory", "handwriting", "unassociated-feedback"]);
export const NOTEBOOKS=Object.freeze(["archived-normalized-source", "notebook-plan", "notebook-stage"]);
export const ISSUES=Object.freeze(["configuration-unavailable", "invalid-paths", "missing-owner", "invalid-owner", "missing-current", "missing-lock", "busy-writer", "lock-unavailable", "lock-unsupported", "lease-identity-changed", "unsupported-generation", "missing-entry", "unreadable-entry", "unsafe-entry", "unexpected-entry", "entry-limit", "metadata-limit", "byte-count-overflow", "invalid-metadata", "invalid-reference", "missing-object", "uninspected-reference", "omitted-media", "size-mismatch", "inconsistent-reference", "state-changed", "state-unverifiable", "cache-unavailable", "cache-owner-mismatch", "unsupported-platform", "report-limit", "unclassified-object"]);
export const FALSE_FLAGS=Object.freeze(['reference_totals_additive','notebook_record_totals_additive','media_content_verified','logical_liveness_evaluated','credentials_inspected','native_documents_inspected']);
const fields='schema_version status current_generation_format retained_generation_formats observed_files observed_apparent_bytes complete_apparent_bytes storage observed_domains observed_notebook_records domain_accounting_complete cache_inspected shared_media_files shared_media_apparent_bytes issues'.split(' ').concat(FALSE_FLAGS);
export const refuse=()=>{throw Error('Stored data report refused');};
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v):refuse();
export function exact(v,fields){if(keys(v).sort().join()!==[...fields].sort().join())refuse();}
export function counter(v){if(typeof v!=='string'||v.length>20||!/^(?:0|[1-9][0-9]*)(?![\s\S])/.test(v)||BigInt(v)>18446744073709551615n)refuse();return BigInt(v);}
const optional=v=>v===null?null:counter(v);
const size=v=>new TextEncoder().encode(JSON.stringify(v)).length;
export function parseOwnedV3Request(v){exact(v,['connection_id','boot_id']);if(!basicDigest(v.connection_id)||!basicUuid(v.boot_id)||size(v)>256)refuse();return {connection_id:v.connection_id,boot_id:v.boot_id};}
export function parseOwnedV3View(v){
 exact(v,fields);if(v.schema_version!==1||!['complete','partial','unsupported','unavailable','busy'].includes(v.status)||!FALSE_FLAGS.every(k=>v[k]===false)||typeof v.cache_inspected!=='boolean'||typeof v.domain_accounting_complete!=='boolean')refuse();
 if(v.current_generation_format!==null&&![1,2,3,4].includes(v.current_generation_format))refuse();
 if(!Array.isArray(v.retained_generation_formats)||v.retained_generation_formats.length>4||v.retained_generation_formats.some((n,i,a)=>![1,2,3,4].includes(n)||i>0&&a[i-1]>=n))refuse();
 const files=counter(v.observed_files),total=optional(v.observed_apparent_bytes),complete=optional(v.complete_apparent_bytes),shared=optional(v.shared_media_apparent_bytes);
 if(files>4096n||counter(v.shared_media_files)>files||shared!==null&&total!==null&&shared>total)refuse();
 if(keys(v.issues).some(k=>!ISSUES.includes(k)||counter(v.issues[k])===0n))refuse();
 let unknown=false;const byte=n=>{const a=optional(n);if(a===null)unknown=true;return a;};
 const map=(value,allowed,usage)=>{if(keys(value).some(k=>!allowed.includes(k)))refuse();for(const r of Object.values(value))usage(r);};
 const usage=r=>{exact(r,['files','apparent_bytes']);counter(r.files);byte(r.apparent_bytes);};
 map(v.storage,STORAGE,usage);map(v.observed_notebook_records,NOTEBOOKS,usage);
 const domainFields='observed_record_files observed_record_bytes declared_media_bytes present_referenced_media_bytes missing_references uninspected_references size_mismatched_references omitted_references'.split(' ');
 map(v.observed_domains,DOMAINS,r=>{exact(r,domainFields);for(const k of domainFields){if(k.endsWith('_bytes'))byte(r[k]);else counter(r[k]);}});
 const storage=Object.values(v.storage),sum=(rows,k)=>rows.reduce((n,r)=>n+counter(r[k]),0n);
 if(sum(storage,'files')!==files)refuse();
 if(v.storage['unclassified-object']&&counter(v.storage['unclassified-object'].files)>0n&&!Object.hasOwn(v.issues,'unclassified-object'))refuse();
 const allKnown=storage.every(r=>r.apparent_bytes!==null),physical=allKnown?sum(storage,'apparent_bytes'):null;
 if(physical===null?total!==null:physical>18446744073709551615n?total!==null:total!==physical)refuse();
 byte(v.observed_apparent_bytes);byte(v.shared_media_apparent_bytes);
 if(unknown&&!Object.hasOwn(v.issues,'byte-count-overflow'))refuse();
 const subset=(names,domain)=>{const rows=names.map(n=>v.observed_notebook_records[n]).filter(Boolean),r=v.observed_domains[domain];if(!rows.length)return;if(!r){if(rows.some(x=>counter(x.files)!==0n||x.apparent_bytes!==null&&counter(x.apparent_bytes)!==0n))refuse();return;}if(sum(rows,'files')>counter(r.observed_record_files))refuse();if(r.observed_record_bytes!==null&&sum(rows.filter(x=>x.apparent_bytes!==null),'apparent_bytes')>counter(r.observed_record_bytes))refuse();};
 subset(['archived-normalized-source'],'source');subset(['notebook-plan','notebook-stage'],'conversation');
 if(v.status==='complete'){
  if(total===null||complete!==total||shared===null||!v.domain_accounting_complete||!v.cache_inspected||keys(v.issues).length||v.current_generation_format===null||unknown)refuse();
  exact(v.storage,STORAGE);exact(v.observed_domains,DOMAINS);exact(v.observed_notebook_records,NOTEBOOKS);
  if(Object.values(v.observed_domains).some(r=>['missing_references','uninspected_references','size_mismatched_references','omitted_references'].some(k=>r[k]!=='0')))refuse();
  if(v.current_generation_format!==4&&!v.retained_generation_formats.includes(4)&&Object.values(v.observed_notebook_records).some(r=>r.files!=='0'||r.apparent_bytes!=='0'))refuse();
 }else if(complete!==null||v.domain_accounting_complete||v.status==='partial'&&!keys(v.issues).length)refuse();
 if(size(v)>16384)refuse();return structuredClone(v);
}
export function parseOwnedV3Result(v,request,validate){const q=parseOwnedV3Request(request);exact(v,['contract_version','status','observation','owned_data_v3']);if(size(v)>16384)refuse();validate({contract_version:v.contract_version,status:v.status,observation:v.observation});const c=v.owned_data_v3;exact(c,['status','view']);if(!['reported','unsupported','unavailable','busy'].includes(c.status))refuse();if(c.status==='reported'){if(v.status!=='observed'||v.observation.connection_id!==q.connection_id||v.observation.boot_id!==q.boot_id)refuse();parseOwnedV3View(c.view);}else if(c.view!==null||v.status!=='unconfigured'||v.observation!==null)refuse();return v;}
