import type { ObservationResult } from '../src/observation';
export type ModelKey='base_url'|'model';
export type ModelFields=Record<ModelKey,{origin:'default'|'declared'|'declared-null';present:boolean}>;
export type ModelChanges=Partial<Record<ModelKey,{action:'clear'}|{action:'set';value:string}>>;
export type ModelOperation='inspect'|'prepare'|'apply'|'status';
export type ModelReport={operation:ModelOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'|'restart-required'};
export type ModelIdentity={connection_id:string;boot_id:string};
export type ModelSettingsRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&ModelIdentity)|({action:'save';reference:string;changes:ModelChanges}&ModelIdentity)|({action:'status';reference:string}&ModelIdentity);
export type ModelState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type ModelRetained=ModelIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface ModelView {state:ModelState;reference:string|null;current:ModelFields|null;report:ModelReport|null;retained:ModelRetained[]}
export interface ModelSettingsResult extends ObservationResult {model_settings:ModelView}
export const MODEL_KEYS:readonly ModelKey[];
export const modelDigest:(v:unknown)=>boolean;
export const modelUuid:(v:unknown)=>boolean;
export const parseModelFields:(v:unknown)=>ModelFields;
export const parseModelChanges:(v:unknown)=>ModelChanges;
export const changedModelFields:(before:unknown,changes:unknown)=>ModelFields;
export const parseModelSettingsRequest:(v:unknown)=>ModelSettingsRequest;
export const parseModelSettingsResult:(v:unknown,request:ModelResponseContext,validate:(v:unknown)=>unknown)=>ModelSettingsResult;
export const parseModelIntent:(v:unknown)=>unknown;
export const parseModelSettingsReport:(v:unknown,operation:ModelOperation,context?:unknown)=>{report:ModelReport;current:ModelFields|null;before:ModelFields|null;after:ModelFields|null;intent:unknown;base_sha256:string|null;config_path_sha256:string|null};

export const modelText:(key:string,v:unknown)=>boolean;
export const modelPatchJson:(v:unknown)=>string;
export type ModelResponseContext={action:ModelSettingsRequest["action"];reference?:string;connection_id?:string;boot_id?:string};
export const modelResponseContext:(v:ModelSettingsRequest)=>ModelResponseContext;
