export interface SavedConfigurationRequest {connection_id:string;boot_id:string}
export interface SavedConfigurationField {origin:'default'|'declared'|'declared-null';value:null|boolean|string|number|string[]}
export interface SavedConfigurationSnapshot {schema_version:1;byte_basis:'saved-file-bytes';validation_basis:'typed-values-only';declared_roots_validated:false;fields:Record<string,SavedConfigurationField>;unsupported:string[]}
export interface SavedConfigurationView {status:'ok'|'unavailable'|'invalid-input'|'unsupported';runtime_activation:'unverified';snapshot:SavedConfigurationSnapshot|null}
export const DEFAULT_FIELDS:Readonly<Record<string,SavedConfigurationField['value']>>;
export const FIELD_KEYS:readonly string[];
export const UNSUPPORTED_SETTINGS:readonly string[];
export const parseSavedConfigurationRequest:(v:unknown)=>SavedConfigurationRequest;
export const parseSavedConfigurationReport:(v:unknown)=>SavedConfigurationView;
export const parseSavedConfigurationView:(v:unknown)=>SavedConfigurationView;
export const parseSavedConfigurationResult:(v:unknown,request:SavedConfigurationRequest,validate:(v:unknown)=>unknown)=>unknown;
export const reduceSavedConfigurationResult:(v:unknown,request:SavedConfigurationRequest,validate:(v:unknown)=>unknown)=>unknown;
