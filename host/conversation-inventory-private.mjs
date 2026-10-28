// Host-only closed producer report; never exposed as a renderer decoder.
import {strictJson} from './strict-json.mjs';
import {parseConversationView} from './conversation-inventory-protocol.mjs';
export class ConversationUnsupported extends Error {constructor(){super('Conversation inventory unsupported');}}
export function parseConversationReport(v){
 const refuse=()=>{throw Error('Conversation inventory report refused');};
 if(!v||typeof v!=='object'||Array.isArray(v)||!Number.isSafeInteger(v.report_version)||v.report_version<1)refuse();if(v.report_version!==1)throw new ConversationUnsupported();
 if(Object.keys(v).sort().join()!=='candidate_count,candidates,complete,eligibility_evaluated,local_only,mutation_authority,native_authority,physical_reclamation,report_version,runtime_unverified,scope,service_observation,status'||v.scope!=='ordinary-current-root-candidates')refuse();
 const {report_version,scope,...view}=v;void report_version;void scope;return parseConversationView(view);
}
export function parseConversationRaw(raw){
 if(raw.length>8192)throw Error('Conversation inventory report refused');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);if(!text.endsWith('\n')||text.split('\n').length!==2)throw Error('Conversation inventory framing refused');strictJson(raw);return parseConversationReport(JSON.parse(text));
}
