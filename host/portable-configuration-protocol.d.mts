import type {ObservationResult} from '../src/observation';
export type PortableIdentity={connection_id:string;boot_id:string};
export type PortableRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'export'}&PortableIdentity)|({action:'prepare';artifact_base64:string}&PortableIdentity)|({action:'confirm'|'status';reference:string}&PortableIdentity);
export type PortableContext={action:PortableRequest['action'];reference?:string;connection_id?:string;boot_id?:string};
export type PortableOrigins=Record<'personalization'|'product_settings'|'research_policy','absent'|'declared'|'declared-null'>;
export type PortableSummary={kind:'export';declared_settings:number;personalization_included:boolean}|{kind:'import';changed_settings:string[];before:PortableOrigins|null;after:PortableOrigins|null};
export type PortableReport={status:string;runtime_activation:'unverified';outcome?:string;disk_readback_verified?:boolean};
export type PortableRetained=PortableIdentity&{reference:string;state:'unknown'|'unresolved'};
export type PortableFile={name:'remarkable-buddies-preferences.json';bytes_base64:string};
export interface PortableView {state:'none'|'exported'|'ready'|'no-change'|'invalidated'|'verified'|'not-dispatched'|'unknown'|'desired-file-observed'|'unresolved'|'unsupported'|'unavailable'|'busy'|'capacity';reference:string|null;summary:PortableSummary|null;report:PortableReport|null;retained:PortableRetained[];export_file:PortableFile|null}
export interface PortableResult extends ObservationResult {portable_configuration:PortableView}
export const PORTABLE_FILE:string;
export const PORTABLE_CONFIG:string;
export const PORTABLE_NAMES:string[];
export function parsePortableRequest(v:unknown):PortableRequest;
export function portableContext(v:PortableRequest):PortableContext;
export function parsePortableResult(v:unknown,q:PortableContext,validate:(v:unknown)=>unknown):PortableResult;
export function portableJson(raw:Uint8Array,limit:number):unknown;
export function portableBase64(v:unknown,limit?:number):Uint8Array;
export function portableArtifactBytes(raw:Uint8Array):unknown;
