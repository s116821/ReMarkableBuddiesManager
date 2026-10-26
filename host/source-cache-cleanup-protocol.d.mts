import type {ObservationResult} from '../src/observation';
export type CleanupRequest={action:'retained'}|{action:'cancel';reference:string;invocation:string}|{action:'prepare';connection_id:string;boot_id:string;document:string;invocation:string}|{action:'confirm'|'status';connection_id:string;boot_id:string;reference:string;invocation:string};
export interface CleanupRetained {reference:string;connection_id:string;boot_id:string;document:string;state:'unknown'|'unchanged'|'conflict';status_available:boolean}
export interface CleanupView {state:string;reference:string|null;preview:{document:string;entry_bytes:number}|null;report:{operation:string;status:string;runtime_unverified:true;possible_effect:boolean}|null;retained:CleanupRetained[]}
export interface CleanupResult extends ObservationResult {source_cache_cleanup:CleanupView}
export const parseCleanupRequest:(v:unknown)=>CleanupRequest;
export const parseCleanupResult:(v:unknown,request:CleanupRequest,validate:(v:unknown)=>unknown)=>CleanupResult;
