import type { ObservationResult } from '../src/observation';
export type BasicKey='debug_dump'|'log_level'|'trigger_corner';
export type BasicFields=Record<BasicKey,{origin:'default'|'declared'|'declared-null';value:string|boolean|null}>;
export type BasicChanges=Partial<Record<BasicKey,{action:'clear'}|{action:'set';value:string|boolean}>>;
export type BasicOperation='inspect'|'prepare'|'apply'|'status';
export type BasicReport={operation:BasicOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'|'restart-required'};
export type BasicIdentity={connection_id:string;boot_id:string};
export type BasicSettingsRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&BasicIdentity)|({action:'save';reference:string;changes:BasicChanges}&BasicIdentity)|({action:'status';reference:string}&BasicIdentity);
export type BasicState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type BasicRetained=BasicIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface BasicView {state:BasicState;reference:string|null;current:BasicFields|null;report:BasicReport|null;retained:BasicRetained[]}
export interface BasicSettingsResult extends ObservationResult {basic_settings:BasicView}
export const BASIC_KEYS:readonly BasicKey[];
export const basicDigest:(v:unknown)=>boolean;
export const basicUuid:(v:unknown)=>boolean;
export const parseBasicFields:(v:unknown)=>BasicFields;
export const parseBasicChanges:(v:unknown)=>BasicChanges;
export const changedBasicFields:(before:unknown,changes:unknown)=>BasicFields;
export const parseBasicSettingsRequest:(v:unknown)=>BasicSettingsRequest;
export const parseBasicSettingsResult:(v:unknown,request:BasicSettingsRequest,validate:(v:unknown)=>unknown)=>BasicSettingsResult;
export const parseBasicIntent:(v:unknown)=>unknown;
export const parseBasicSettingsReport:(v:unknown,operation:BasicOperation,context?:unknown)=>{report:BasicReport;current:BasicFields|null;before:BasicFields|null;after:BasicFields|null;intent:unknown;base_sha256:string|null;config_path_sha256:string|null};
