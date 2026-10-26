import type {ObservationResult} from '../src/observation';
export type SourceCacheRequest={connection_id:string;boot_id:string};
export interface SourceCacheView {status:'ok'|'unavailable'|'unsupported'|'busy'|'conflict';entries:{document:string;apparent_bytes:number}[]|null;total_apparent_bytes:number|null;runtime_unverified:true;cleanup_authority:false;entry_payloads_read:false;entry_payloads_validated:false;source_freshness_verified:false;byte_basis:string}
export interface SourceCacheResult extends ObservationResult {source_cache_inventory:{status:'reported'|'unsupported'|'unavailable'|'busy';view:SourceCacheView|null}}
export const CACHE_BYTE_BASIS:string;
export const parseSourceCacheRequest:(v:unknown)=>SourceCacheRequest;
export const parseSourceCacheView:(v:unknown)=>SourceCacheView;
export const parseSourceCacheResult:(v:unknown,request:SourceCacheRequest,validate:(v:unknown)=>unknown)=>SourceCacheResult;
