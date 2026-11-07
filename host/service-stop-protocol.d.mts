import type {ObservationResult} from '../src/observation';
export type ServiceStopRequest={action:'begin';connection_id:string;boot_id:string}|{action:'confirm'|'refresh';connection_id:string;boot_id:string;reference:string;invocation:string}|{action:'cancel';reference:string;invocation:string|null}|{action:'retained'};
export type ServiceStopReason=null|'busy'|'unsupported'|'unavailable'|'invalid-response'|'cancelled'|'expired'|'session-changed'|'capacity'|'lifecycle-unqualified';
export interface ServiceStopRetained {reference:string;connection_id:string;boot_id:string;outcome:'request-accepted'|'unknown';reason:ServiceStopReason}
export interface ServiceStopView {state:'none'|'ready'|'invalidated'|'expired'|'busy'|'unavailable'|'unsupported'|'capacity'|'request-accepted'|'unknown';reference:string|null;invocation:string|null;current:{state:'inactive'|'active'|'transitioning'|'failed'}|null;reason:ServiceStopReason;retained:ServiceStopRetained[]}
export interface ServiceStopResult extends ObservationResult {service_stop:ServiceStopView}
export const parseServiceStopRequest:(v:unknown)=>ServiceStopRequest;
export const parseServiceStopResult:(v:unknown,q:ServiceStopRequest,validate:(v:unknown)=>unknown)=>ServiceStopResult;
