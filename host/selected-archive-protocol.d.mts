import type {ObservationResult} from '../src/observation';
export type ArchiveOutcome='not-dispatched'|'exported'|'partial-media'|'unknown';
export type ArchiveRequest={action:'retained'}|{action:'inspect'|'prepare-export';connection_id:string;boot_id:string;invocation:string;path:string}|{action:'confirm-export'|'check-export';connection_id:string;boot_id:string;invocation:string;reference:string}|{action:'cancel';connection_id:string;boot_id:string;invocation:string;reference:string|null};
export interface ArchiveContext {action:ArchiveRequest['action'];connection_id?:string;boot_id?:string;invocation?:string;reference?:string|null;expected_original_outcome?:ArchiveOutcome|null}
export interface ArchiveSummary {format:1|2|3;manifests:number;objects:number;selected_scopes:number;selection_receipts:number;complete_media:boolean;configuration_included:boolean}
export interface ArchiveRetained {reference:string;connection_id:string;boot_id:string;original_outcome:ArchiveOutcome;expired:boolean}
export interface ArchiveView {state:string;reference:string|null;invocation:string|null;summary:ArchiveSummary|null;original_outcome:ArchiveOutcome|null;check_outcome:'archive-observed'|'incomplete-media-observed'|'unresolved'|null;retained:ArchiveRetained[]}
export interface ArchiveResult extends ObservationResult {selected_archive:ArchiveView}
export const archivePath:(v:unknown)=>boolean;
export const archiveSummary:(v:unknown)=>ArchiveSummary;
export const parseArchiveRequest:(v:unknown)=>ArchiveRequest;
export const archiveResponseContext:(q:ArchiveRequest,expectedOriginal?:ArchiveOutcome|null)=>ArchiveContext;
export const parseArchiveResult:(v:unknown,q:ArchiveContext|ArchiveRequest,validate:(v:unknown)=>unknown)=>ArchiveResult;
export const parseArchiveJson:(raw:Uint8Array)=>unknown;
