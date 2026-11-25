import type {ObservationResult} from '../src/observation';
import type {SavedModeSnapshot} from './saved-mode.mjs';
export type IsolatedRootIdentity={connection_id:string;boot_id:string};
export type IsolatedRootRequest={action:'retained'}|{action:'cancel';reference:string;wait_id:string}|({action:'begin';wait_id:string}&IsolatedRootIdentity)|({action:'prepare'|'retry';reference:string;wait_id:string}&IsolatedRootIdentity);
export type IsolatedRootState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'storage-unavailable'|'unknown'|'verified';
export type IsolatedRootRetained=IsolatedRootIdentity&{reference:string;state:'unknown'|'verified';device:string;backup:string;epoch:string};
export type IsolatedRootReport={status:'ok'|'invalid-input'|'unsupported'|'unavailable'|'busy'|'conflict'|'failed';incomplete:boolean;current:SavedModeSnapshot|null;result:null|{device:string;backup:string;epoch:string;outcome:'root-verified'|'outcome-unknown'|'authorization-required'|'retry-later'|'recovery-required'|'provider-binding-unqualified';currency:'current'|'historical'}};
export interface IsolatedRootView{state:IsolatedRootState;reference:string|null;preview:SavedModeSnapshot|null;report:IsolatedRootReport|null;retained:IsolatedRootRetained[]}
export interface IsolatedRootResult extends ObservationResult{isolated_root_preparation:IsolatedRootView}
export const parseIsolatedRootRequest:(v:unknown)=>IsolatedRootRequest;
export const parseIsolatedRootResult:(v:unknown,q:IsolatedRootRequest,validate:(v:unknown)=>unknown)=>IsolatedRootResult;
