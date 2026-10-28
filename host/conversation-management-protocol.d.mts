import type {ObservationResult} from '../src/observation';
export type ManagementRequest={action:'retained'}|{action:'cancel';reference:string;invocation:string}|{action:'inspect';connection_id:string;boot_id:string;conversation:string;invocation:string}|{action:'prepare'|'confirm'|'status';connection_id:string;boot_id:string;reference:string;invocation:string};
export interface ManagementRetained {reference:string;connection_id:string;boot_id:string;conversation:string;state:'unknown'|'unchanged'|'unresolved';status_available:boolean}
export interface ManagementPreview {conversation:string;turns:number;source_records:number;export_associations:number}
export interface ManagementReport {operation:string;status:string;runtime_unverified:true;local_only:true;physical_reclamation:false;service_observation:'inactive'|'unverified';possible_effect:boolean;current_state:null|'live-original'|'desired-tombstones'|'changed'}
export interface ManagementView {state:string;reference:string|null;preview:ManagementPreview|null;report:ManagementReport|null;retained:ManagementRetained[]}
export interface ManagementResult extends ObservationResult {conversation_management:ManagementView}
export const parseManagementRequest:(v:unknown)=>ManagementRequest;
export const parseManagementResult:(v:unknown,request:ManagementRequest,validate:(v:unknown)=>unknown)=>ManagementResult;

export const parseManagementJson:(raw:Uint8Array)=>unknown;
