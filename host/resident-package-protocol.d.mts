import type {ObservationResult} from '../src/observation';
export type PackageOperation='disable'|'remove'|'replace';
export type ResidentPackageRequest={action:'begin';operation:PackageOperation;connection_id:string;boot_id:string}|{action:'confirm'|'refresh'|'resume';reference:string;invocation:string;connection_id:string;boot_id:string}|{action:'cancel';reference:string;invocation:string|null}|{action:'retained'};
export interface PackageCurrent {phase:'review'|'stop'|'recovery'|'disable'|'package';outcome:'ready'|'pending'|'prepared'|'disabled'|'removed'|'replaced';installed_version:string|null;candidate_version:string|null;data_preserved:true}
export type PackageReason=null|'busy'|'unsupported'|'unavailable'|'invalid-response'|'cancelled'|'expired'|'session-changed'|'capacity'|'lifecycle-unqualified'|'candidate-unavailable'|'recovery-pending'|'continuation-required';
export interface PackageRetained {reference:string;operation:PackageOperation;connection_id:string;boot_id:string;state:'unknown'|'continuable'|'completed';reason:PackageReason}
export interface ResidentPackageView {state:'none'|'ready'|'busy'|'unavailable'|'unsupported'|'expired'|'invalidated'|'unknown'|'continuable'|'completed';operation:PackageOperation|null;reference:string|null;invocation:string|null;reason:PackageReason;current:PackageCurrent|null;retained:PackageRetained[]}
export interface ResidentPackageResult extends ObservationResult {resident_package:ResidentPackageView}
export const packageKeys:(v:unknown)=>string;
export const packageCurrent:(v:unknown,op:PackageOperation)=>PackageCurrent;
export const parseResidentPackageRequest:(v:unknown)=>ResidentPackageRequest;
export const parseResidentPackageResult:(v:unknown,q:ResidentPackageRequest,validate:(v:unknown)=>unknown)=>ResidentPackageResult;
