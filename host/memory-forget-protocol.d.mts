import type { MemoryKey } from './memory-inspection.mjs';
import type { MemoryMatch } from './memory-query.mjs';
export type ForgetRequest = {action:'status'} | {action:'prepare';connection_id:string;boot_id:string;key:MemoryKey} | {action:'confirm'|'receipt'|'cancel';reference:string};
export type ForgetState = 'none'|'preparing'|'prepared'|'confirming'|'checking-receipt'|'invalidated'|'busy'|'unsupported'|'unavailable'|'not-dispatched'|'unknown'|'unresolved'|'acknowledged';
export interface ForgetReport {selector:'prepare-forget'|'forget'|'forget-receipt';status:string;incomplete:boolean;outcome:null|'acknowledged'|'not-dispatched'|'unknown'|'unresolved'}
export interface ForgetView {state:ForgetState;reference:string|null;preview:null|{key:MemoryKey;head:{record:string;revision:string;fact:MemoryMatch['fact']};scope:{kind:'local'|'selected';group:string|null}};acknowledgement:null|{operation:string;transaction:string};report:ForgetReport|null}
export const parseForgetRequest:(v:unknown)=>ForgetRequest;
export const parseForgetResult:(v:unknown,validate:(v:unknown)=>unknown)=>Promise<unknown>;
export const parseForgetReport:(v:unknown,selector:string,context:unknown)=>Promise<unknown>;
export const canonicalEnvelope:(v:unknown)=>string;
export const sha256:(v:string)=>Promise<string>;
export const sortValue:(v:unknown)=>unknown;
export const uuid:(v:unknown)=>boolean;
export const digest:(v:unknown)=>boolean;
