import type {ObservationResult} from '../src/observation';
export type OwnedV3Request={connection_id:string;boot_id:string};
export type FileUsage={files:string;apparent_bytes:string|null};
export type DomainUsage={observed_record_files:string;observed_record_bytes:string|null;declared_media_bytes:string|null;present_referenced_media_bytes:string|null;missing_references:string;uninspected_references:string;size_mismatched_references:string;omitted_references:string};
export interface OwnedV3View {schema_version:1;status:'complete'|'partial'|'unsupported'|'unavailable'|'busy';current_generation_format:number|null;retained_generation_formats:number[];observed_files:string;observed_apparent_bytes:string|null;complete_apparent_bytes:string|null;storage:Record<string,FileUsage>;observed_domains:Record<string,DomainUsage>;observed_notebook_records:Record<string,FileUsage>;domain_accounting_complete:boolean;cache_inspected:boolean;shared_media_files:string;shared_media_apparent_bytes:string|null;issues:Record<string,string>;reference_totals_additive:false;notebook_record_totals_additive:false;media_content_verified:false;logical_liveness_evaluated:false;credentials_inspected:false;native_documents_inspected:false}
export interface OwnedV3Result extends ObservationResult {owned_data_v3:{status:'reported'|'unsupported'|'unavailable'|'busy';view:OwnedV3View|null}}
export const STORAGE:readonly string[];export const DOMAINS:readonly string[];export const NOTEBOOKS:readonly string[];
export const parseOwnedV3Request:(v:unknown)=>OwnedV3Request;
export const parseOwnedV3View:(v:unknown)=>OwnedV3View;
export const parseOwnedV3Result:(v:unknown,q:OwnedV3Request,validate:(v:unknown)=>unknown)=>OwnedV3Result;
