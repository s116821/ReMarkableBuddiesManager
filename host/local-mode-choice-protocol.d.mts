import type {ObservationResult} from '../src/observation';
import type {SavedModeSnapshot} from './saved-mode.mjs';
export type LocalModeIdentity={connection_id:string;boot_id:string};
export type LocalModeRequest={action:'retained'}|{action:'cancel';reference:string}|({action:'begin'}&LocalModeIdentity)|({action:'choose'|'refresh';reference:string}&LocalModeIdentity);
export type LocalModeState='none'|'ready'|'invalidated'|'unsupported'|'unavailable'|'busy'|'capacity'|'refused'|'acknowledged'|'unknown';
export type LocalModeReceipt={kind:'local-only';epoch:string;historical:boolean};
export type LocalModeRetained=LocalModeIdentity&{reference:string;state:'unknown'|'acknowledged'|'refused'};
export interface LocalModeView{state:LocalModeState;reference:string|null;current:SavedModeSnapshot|null;receipt:LocalModeReceipt|null;retained:LocalModeRetained[]}
export interface LocalModeResult extends ObservationResult{local_mode_choice:LocalModeView}
export const localModeDigest:(v:unknown)=>boolean;
export const localModeUuid:(v:unknown)=>boolean;
export const parseLocalModeRequest:(v:unknown)=>LocalModeRequest;
export const parseLocalModeResult:(v:unknown,q:LocalModeRequest,validate:(v:unknown)=>unknown)=>LocalModeResult;
export const parseLocalModeOriginal:(v:unknown)=>unknown;
export const parseLocalModeReport:(v:unknown,operation:'inspect'|'choose',context?:unknown)=>unknown;
