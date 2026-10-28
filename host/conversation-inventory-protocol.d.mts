import type {ObservationResult} from '../src/observation';
export type ConversationRequest={connection_id:string;boot_id:string};
export interface ConversationView {status:'complete'|'too-large'|'unsupported'|'busy'|'unavailable'|'conflict';complete:boolean;candidates:string[]|null;candidate_count:number|null;eligibility_evaluated:false;mutation_authority:false;native_authority:false;runtime_unverified:true;physical_reclamation:false;local_only:true;service_observation:'inactive'|'unverified'}
export interface ConversationResult extends ObservationResult {conversation_inventory:{status:'reported'|'unsupported'|'unavailable'|'busy';view:ConversationView|null}}
export const parseConversationRequest:(v:unknown)=>ConversationRequest;
export const parseConversationView:(v:unknown)=>ConversationView;
export const parseConversationResult:(v:unknown,request:ConversationRequest,validate:(v:unknown)=>unknown)=>ConversationResult;
