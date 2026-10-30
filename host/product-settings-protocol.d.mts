import type { ObservationResult } from '../src/observation';
export type ProductKey='export_destination'|'reader_enabled'|'writer_enabled';
export type ProductFields=Record<ProductKey,{origin:'default'|'declared';value:'mem'|'disabled'|boolean}>;
export type ProductChanges=Partial<Record<ProductKey,{action:'clear'}|{action:'set';value:string|boolean}>>;
export type ProductOperation='inspect'|'prepare'|'apply'|'status';
export type ProductReport={operation:ProductOperation;status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';outcome:'read-only'|'prepared'|'no-change'|'verified'|'desired-file-observed'|'unresolved'|'not-dispatched'|'unknown';disk_readback_verified:boolean;runtime_activation:'unverified'|'restart-required'};
export type ProductIdentity={connection_id:string;boot_id:string};
export type ProductSettingsRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&ProductIdentity)|({action:'save';reference:string;changes:ProductChanges}&ProductIdentity)|({action:'status';reference:string}&ProductIdentity);
export type ProductState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'not-dispatched'|'no-change'|'verified'|'unknown'|'unresolved'|'desired-file-observed';
export type ProductRetained=ProductIdentity&{reference:string;state:'unknown'|'unresolved'};
export interface ProductView {state:ProductState;reference:string|null;current:ProductFields|null;report:ProductReport|null;retained:ProductRetained[]}
export interface ProductSettingsResult extends ObservationResult {product_settings:ProductView}
export const PRODUCT_KEYS:readonly ProductKey[];
export const productDigest:(v:unknown)=>boolean;
export const productUuid:(v:unknown)=>boolean;
export const parseProductFields:(v:unknown)=>ProductFields;
export const parseProductChanges:(v:unknown)=>ProductChanges;
export const changedProductFields:(before:unknown,changes:unknown)=>ProductFields;
export const parseProductSettingsRequest:(v:unknown)=>ProductSettingsRequest;
export const parseProductSettingsResult:(v:unknown,request:ProductSettingsRequest,validate:(v:unknown)=>unknown)=>ProductSettingsResult;
export const parseProductIntent:(v:unknown)=>unknown;
export const parseProductSettingsReport:(v:unknown,operation:ProductOperation,context?:unknown)=>{report:ProductReport;current:ProductFields|null;before:ProductFields|null;after:ProductFields|null;intent:unknown;base_sha256:string|null;config_path_sha256:string|null};

export const parseProductRawFrame:(raw:Uint8Array)=>unknown;
