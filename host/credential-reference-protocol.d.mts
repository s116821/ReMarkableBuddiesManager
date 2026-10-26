export type CredentialKey='model_credential';
import type { ObservationResult } from '../src/observation';
export type CredentialFields={model_credential:{origin:'default'|'declared'|'declared-null';present:boolean}};
export type CredentialChange={action:'clear'}|{action:'set';value:string};
export type CredentialOperation='inspect'|'prepare'|'apply'|'status';
export type CredentialReport={operation:CredentialOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'};
export type CredentialIdentity={connection_id:string;boot_id:string};
export type CredentialReferenceRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&CredentialIdentity)|({action:'save';reference:string;change:CredentialChange}&CredentialIdentity)|({action:'status';reference:string}&CredentialIdentity);
export type CredentialState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type CredentialRetained=CredentialIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface CredentialView {state:CredentialState;reference:string|null;current:CredentialFields|null;report:CredentialReport|null;retained:CredentialRetained[]}
export interface CredentialReferenceResult extends ObservationResult {credential_reference:CredentialView}
export const credentialDigest:(v:unknown)=>boolean;
export const credentialUuid:(v:unknown)=>boolean;
export const parseCredentialFields:(v:unknown)=>CredentialFields;
export const parseCredentialChange:(v:unknown)=>CredentialChange;
export const changedCredentialFields:(before:unknown,change:unknown)=>CredentialFields;
export const parseCredentialReferenceRequest:(v:unknown)=>CredentialReferenceRequest;
export const parseCredentialReferenceResult:(v:unknown,request:CredentialResponseContext,validate:(v:unknown)=>unknown)=>CredentialReferenceResult;
export const parseCredentialIntent:(v:unknown)=>unknown;
export const parseCredentialReferenceReport:(v:unknown,operation:CredentialOperation,context?:unknown)=>{report:CredentialReport;current:CredentialFields|null;before:CredentialFields|null;after:CredentialFields|null;intent:unknown;base_sha256:string|null;config_path_sha256:string|null};

export const credentialName:(v:unknown)=>boolean;
export const credentialPatchJson:(v:unknown)=>string;
export type CredentialResponseContext={action:CredentialReferenceRequest["action"];reference?:string;connection_id?:string;boot_id?:string};
export const credentialResponseContext:(v:CredentialReferenceRequest)=>CredentialResponseContext;

export const CREDENTIAL_CONFIG:string;

export const CREDENTIAL_KEYS:readonly CredentialKey[];
