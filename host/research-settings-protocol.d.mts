import type { ObservationResult } from '../src/observation';
export type ResearchKey='research_policy';
export type ResearchFields={research_policy:{origin:'default'|'declared'|'declared-null';value:'required'|'disabled'}};
export type ResearchChanges={research_policy:{action:'clear'}|{action:'set';value:'required'|'disabled'}};
export type ResearchOperation='inspect'|'prepare'|'apply'|'status';
export type ResearchReport={operation:ResearchOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'};
export type ResearchIdentity={connection_id:string;boot_id:string};
export type ResearchSettingsRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&ResearchIdentity)|({action:'save';reference:string;changes:ResearchChanges}&ResearchIdentity)|({action:'status';reference:string}&ResearchIdentity);
export type ResearchState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type ResearchRetained=ResearchIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface ResearchView {state:ResearchState;reference:string|null;current:ResearchFields|null;report:ResearchReport|null;retained:ResearchRetained[]}
export interface ResearchSettingsResult extends ObservationResult {research_settings:ResearchView}
export const RESEARCH_KEYS:readonly ResearchKey[];
export const researchDigest:(v:unknown)=>boolean;
export const researchUuid:(v:unknown)=>boolean;
export const parseResearchFields:(v:unknown)=>ResearchFields;
export const parseResearchChanges:(v:unknown)=>ResearchChanges;
export const changedResearchFields:(before:unknown,changes:unknown)=>ResearchFields;
export const parseResearchSettingsRequest:(v:unknown)=>ResearchSettingsRequest;
export const parseResearchSettingsResult:(v:unknown,request:ResearchResponseContext,validate:(v:unknown)=>unknown)=>ResearchSettingsResult;
export const parseResearchIntent:(v:unknown)=>unknown;
export const parseResearchSettingsReport:(v:unknown,operation:ResearchOperation,context?:unknown)=>{report:ResearchReport;current:ResearchFields|null;before:ResearchFields|null;after:ResearchFields|null;intent:unknown;base_sha256:string|null;config_path_sha256:string|null};

export const researchPatchJson:(v:unknown)=>string;
export type ResearchResponseContext={action:ResearchSettingsRequest["action"];reference?:string;connection_id?:string;boot_id?:string};
export const researchResponseContext:(v:ResearchSettingsRequest)=>ResearchResponseContext;

export const RESEARCH_CONFIG:string;
