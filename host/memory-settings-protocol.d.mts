import type { ObservationResult } from '../src/observation';
export type MemoryKey='enabled'|'profile';
export type MemoryFields={enabled:{origin:'default'|'declared';value:boolean};profile:{origin:'default'|'declared'|'declared-null';present:boolean}};
export type MemoryChanges={enabled?:{action:'clear'}|{action:'set';value:boolean};profile?:{action:'clear'}|{action:'set';value:string}};
export type MemoryOperation='inspect'|'prepare'|'apply'|'status';
export type MemoryReport={operation:MemoryOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'};
export type MemoryIdentity={connection_id:string;boot_id:string};
export type MemorySettingsRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&MemoryIdentity)|({action:'save';reference:string;changes:MemoryChanges}&MemoryIdentity)|({action:'status';reference:string}&MemoryIdentity);
export type MemoryState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type MemoryRetained=MemoryIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface MemoryView {state:MemoryState;reference:string|null;current:MemoryFields|null;report:MemoryReport|null;retained:MemoryRetained[]}
export interface MemorySettingsResult extends ObservationResult {memory_settings:MemoryView}
export const MEMORY_KEYS:readonly MemoryKey[];
export const memoryDigest:(v:unknown)=>boolean;
export const memoryUuid:(v:unknown)=>boolean;
export const parseMemoryFields:(v:unknown)=>MemoryFields;
export const parseMemoryChanges:(v:unknown)=>MemoryChanges;
export const changedMemoryFields:(before:unknown,changes:unknown)=>MemoryFields;
export const parseMemorySettingsRequest:(v:unknown)=>MemorySettingsRequest;
export const parseMemorySettingsResult:(v:unknown,request:MemoryResponseContext,validate:(v:unknown)=>unknown)=>MemorySettingsResult;
export const parseMemoryIntent:(v:unknown)=>unknown;
export const parseMemorySettingsReport:(v:unknown,operation:MemoryOperation,context?:unknown)=>{report:MemoryReport;current:MemoryFields|null;before:MemoryFields|null;after:MemoryFields|null;intent:unknown;base_sha256:string|null;config_path_sha256:string|null};

export const memoryText:(key:string,v:unknown)=>boolean;
export const memoryPatchJson:(v:unknown)=>string;
export type MemoryResponseContext={action:MemorySettingsRequest["action"];reference?:string;connection_id?:string;boot_id?:string};
export const memoryResponseContext:(v:MemorySettingsRequest)=>MemoryResponseContext;

export const MEMORY_CONFIG:string;
