export type ModelCredentialKey='model_credential';
import type { ObservationResult } from '../src/observation';
export type ModelCredentialFields={present:boolean};
export type ModelCredentialChange={action:'remove'}|{action:'install'|'replace';value:string};
export type ModelCredentialOperation='inspect'|'prepare'|'apply'|'status';
export type ModelCredentialReport={operation:ModelCredentialOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'};
export type ModelCredentialIdentity={connection_id:string;boot_id:string};
export type ModelCredentialRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&ModelCredentialIdentity)|({action:'save';reference:string;change:ModelCredentialChange}&ModelCredentialIdentity)|({action:'status';reference:string}&ModelCredentialIdentity);
export type ModelCredentialState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type ModelCredentialRetained=ModelCredentialIdentity&{reference:string;state:'unknown'|'unresolved';status_available:boolean};
export interface ModelCredentialView {state:ModelCredentialState;reference:string|null;current:ModelCredentialFields|null;report:ModelCredentialReport|null;retained:ModelCredentialRetained[]}
export interface ModelCredentialResult extends ObservationResult {model_credential:ModelCredentialView}
export const modelCredentialText:(v:unknown)=>boolean;
export const parseModelCredentialChange:(v:unknown)=>ModelCredentialChange;
export const parseModelCredentialRequest:(v:unknown)=>ModelCredentialRequest;
export type ModelCredentialResponseContext={action:ModelCredentialRequest['action'];reference?:string;connection_id?:string;boot_id?:string};
export const modelCredentialContext:(v:ModelCredentialRequest)=>ModelCredentialResponseContext;
export const parseModelCredentialResult:(v:unknown,request:ModelCredentialResponseContext,validate:(v:unknown)=>unknown)=>ModelCredentialResult;
