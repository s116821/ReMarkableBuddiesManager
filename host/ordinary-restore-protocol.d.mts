import type {ObservationResult} from '../src/observation';
export type RestoreRequest={action:'retained'}|{action:'prepare';connection_id:string;boot_id:string;invocation:string;source:string}|{action:'confirm'|'status'|'cancel';connection_id:string;boot_id:string;invocation:string;reference:string};
export type RestoreContext=Omit<Extract<RestoreRequest,{action:'prepare'}>,'source'>|Exclude<RestoreRequest,{action:'prepare'}>;
export interface RestoreSummary {manifests:number;objects:number;complete_media:boolean;configuration_included:boolean}
export interface RestorePreview {source:RestoreSummary;target:RestoreSummary;additional_manifests:number;additive:true;configuration_applied:false}
export interface RestoreReport {operation:string;status:string;outcome:string;disk_readback_verified:boolean;runtime_activation:'unverified'}
export interface RestoreRetained {reference:string;connection_id:string;boot_id:string;state:'unknown'|'not-activated'|'unresolved';apply_outcome:'unknown'|'not-activated';status_available:boolean}
export interface RestoreView {state:string;reference:string|null;preview:RestorePreview|null;inspection:RestoreSummary|null;report:RestoreReport|null;apply_outcome:null|'not-dispatched'|'not-activated'|'unknown'|'restored';retained:RestoreRetained[]}
export interface RestoreResult extends ObservationResult {ordinary_restore:RestoreView}
export const restorePath:(v:unknown)=>boolean;
export const restoreSummary:(v:unknown)=>RestoreSummary;
export const restorePreview:(v:unknown)=>RestorePreview;
export const parseRestoreRequest:(v:unknown)=>RestoreRequest;
export const restoreResponseContext:(v:RestoreRequest)=>RestoreContext;
export const parseRestoreResult:(v:unknown,q:RestoreRequest|RestoreContext,validate:(v:unknown)=>unknown)=>RestoreResult;
export const parseRestoreJson:(raw:Uint8Array)=>unknown;
export const restorePublicReport:(v:unknown,selector:string)=>RestoreReport;
