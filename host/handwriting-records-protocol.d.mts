import type{ObservationResult}from'../src/observation';
export type HandwritingOutcome='not-dispatched'|'unknown'|'removal-observed'|'historical-removal-observed';
type Identity={connection_id:string;boot_id:string;invocation:string};
export type HandwritingRequest={action:'retained'}|Identity&({action:'query';profile:string;query_text:string|null}|{action:'inspect'|'prepare-remove';profile:string;correction:string}|{action:'confirm-remove'|'check-remove';reference:string}|{action:'cancel';reference:string|null});
export interface HandwritingContext{action:HandwritingRequest['action'];connection_id?:string;boot_id?:string;invocation?:string;profile?:string;correction?:string;reference?:string|null;expected_original_outcome?:HandwritingOutcome|null}
export interface HandwritingRetained{reference:string;connection_id:string;boot_id:string;original_outcome:HandwritingOutcome;expired:boolean}
export interface HandwritingContent{correction:string;original_text:string;corrected_text:string;confirmed_ms:number;provenance:{kind:'caller-confirmed-sample';description:string;source:[string,string,string]|null};sample:{sha256:string;bytes:number;media_type:'image/png'};width:number;height:number}
export interface HandwritingHead{record:string;revision:string;parents:string[];state:'value'|'tombstone'|'unsupported';conflicted:boolean;content:HandwritingContent|null;sample_availability:'available'|'unavailable'|'not-examined'|'not-applicable'}
export interface HandwritingView{kind:'query'|'inspect'|'confirmation';profile:string;correction:string|null;heads:HandwritingHead[];partial:boolean}
export interface HandwritingDiagnostics{status:string;failure:string|null;scanned:number;matched:number;omitted:number;conflicted:number;unsupported:number;missing_media:number}
export interface HandwritingState{state:string;reference:string|null;invocation:string|null;view:HandwritingView|null;original_outcome:HandwritingOutcome|null;check_outcome:'historical-removal-observed'|'unresolved'|null;diagnostics:HandwritingDiagnostics|null;retained:HandwritingRetained[]}
export interface HandwritingResult extends ObservationResult{handwriting_records:HandwritingState}
export const hwUuid:(v:unknown)=>boolean;export const hwText:(v:unknown,n:number)=>boolean;
export const parseHandwritingRequest:(v:unknown)=>HandwritingRequest;
export const handwritingContext:(q:HandwritingRequest,original?:HandwritingOutcome|null)=>HandwritingContext;
export const parseHandwritingResult:(v:unknown,q:HandwritingContext,validate:(v:unknown)=>unknown)=>Promise<HandwritingResult>;
export const parseHandwritingJson:(raw:Uint8Array)=>unknown;
