import type {ObservationResult} from '../src/observation';
export type StorageInitializationRequest={action:'begin';connection_id:string;boot_id:string}|{action:'confirm'|'refresh';connection_id:string;boot_id:string;reference:string;invocation:string}|{action:'cancel';reference:string;invocation:string|null}|{action:'retained'};
export type StorageInitializationReason=null|'busy'|'unsupported'|'unavailable'|'invalid-response'|'cancelled'|'expired'|'session-changed'|'capacity';
export interface StorageInitializationRetained {reference:string;connection_id:string;boot_id:string;outcome:'prepared'|'unknown';reason:StorageInitializationReason}
export interface StorageInitializationView {state:'none'|'ready'|'invalidated'|'expired'|'busy'|'unavailable'|'unsupported'|'capacity'|'prepared'|'unknown';reference:string|null;invocation:string|null;current:{kind:'unconfigured'|'local-only'|'isolated-backup'|'shared-group'}|null;reason:StorageInitializationReason;retained:StorageInitializationRetained[]}
export interface StorageInitializationResult extends ObservationResult {storage_initialization:StorageInitializationView}
export const parseStorageInitializationRequest:(v:unknown)=>StorageInitializationRequest;
export const parseStorageInitializationResult:(v:unknown,q:StorageInitializationRequest,validate:(v:unknown)=>unknown)=>StorageInitializationResult;
