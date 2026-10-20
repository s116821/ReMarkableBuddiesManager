import type {ObservationResult} from '../src/observation';
export type ExportIdentity={connection_id:string;boot_id:string};
export type ExportSummary={format:1;manifests:number;objects:number;complete_media:boolean;configuration_included:boolean};
export type ExportReport={operation:'prepare'|'apply'|'status';status:'ok'|'invalid-input'|'unavailable'|'unsupported'|'busy'|'conflict'|'failed';outcome:'prepared'|'verified'|'desired-archive-observed'|'unresolved'|'not-dispatched'|'not-published'|'read-only'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'};
export type ExportRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'prepare';destination:string}&ExportIdentity)|({action:'confirm'|'status';reference:string}&ExportIdentity);
export type ExportState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'not-published'|'verified'|'unknown'|'unresolved'|'desired-archive-observed';
export type ExportRetained=ExportIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface ExportView {state:ExportState;reference:string|null;summary:ExportSummary|null;report:ExportReport|null;retained:ExportRetained[]}
export interface ExportResult extends ObservationResult {ordinary_export:ExportView}
export type ExportContext={action:ExportRequest['action'];reference?:string;connection_id?:string;boot_id?:string};
export const EXPORT_CONFIG:string;
export const exportDigest:(v:unknown)=>boolean;
export const exportUuid:(v:unknown)=>boolean;
export const exportPath:(v:unknown)=>boolean;
export const parseExportRequest:(v:unknown)=>ExportRequest;
export const exportResponseContext:(v:ExportRequest)=>ExportContext;
export const parseExportSummary:(v:unknown)=>ExportSummary;
export const parseExportIntent:(v:unknown)=>unknown;
export const parseExportReport:(v:unknown,operation:'prepare'|'apply'|'status',context?:unknown)=>{report:ExportReport;summary:ExportSummary|null;intent:unknown};
export const parseExportResult:(v:unknown,request:ExportContext,validate:(v:unknown)=>unknown)=>ExportResult;
