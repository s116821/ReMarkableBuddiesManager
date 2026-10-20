// Synthetic transport/report data. The serialization golden is attributed separately.
import { readFileSync } from 'node:fs';
import { canonicalEnvelope, sha256 } from '../../host/memory-forget-protocol.mjs';
import { memoryRecordId } from '../../host/memory-inspection.mjs';
import { tablet, key, id } from './memory-inspection.mjs';
export { tablet,key,id };
export const golden=JSON.parse(readFileSync(new URL('./prepared-forget-envelope-golden.json',import.meta.url),'utf8'));
export const operation=id(800), transaction=id(801), reference='9'.repeat(64);
export const prepareRequest=(k=key)=>({action:'prepare',connection_id:tablet.connection_id,boot_id:tablet.boot_id,key:structuredClone(k)});
export function binding(selected=false) {
  const group=id(600), digest='b'.repeat(64);
  const pin=n=>({scope:{group,key_sha256:String(n).padStart(64,'0'),binding_sha256:digest},store_generation:id(700),aggregate_generation:id(710+n),accepted_base_sha256:'a'.repeat(64),selection_sha256:'c'.repeat(64),head_sha256:'d'.repeat(64)});
  return {config_sha256:'e'.repeat(64),mode:{actor:id(701),sha256:'f'.repeat(64)},actor:id(702),store_generation:id(700),domain:selected?{kind:'selected',identity:{group,profile:key.profile,binding_sha256:digest},pins:[pin(1),pin(2)]}:{kind:'local'}};
}
export async function prepared(op=operation,k=key,selected=false) {
  const preview=structuredClone(golden.input);preview.payload.key=structuredClone(k);preview.record_id=await memoryRecordId(k);
  return {report_version:1,operation:'prepare-forget',status:'ok',incomplete:false,data:{schema_version:1,preview,intent:{prepared_version:1,operation:op,key:structuredClone(k),expected:[{revision:preview.revision_id,sha256:await sha256(canonicalEnvelope(preview))}],binding:binding(selected)}}};
}
export const ack=(selector='forget',op=operation)=>({report_version:1,operation:selector,status:'ok',incomplete:false,data:{schema_version:1,outcome:'acknowledged',operation:op,transaction}});
export const failure=(selector,status,incomplete,outcome=null)=>({report_version:1,operation:selector,status,incomplete,data:outcome===null?null:{schema_version:1,outcome}});
export const rawReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),forget_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(r)+'\n').toString('base64')}});
export function observer(handler=async(selector,body)=>selector==='prepare-forget'?prepared(body.operation,body.key):ack(selector,body.intent.operation)) {
  const calls=[];
  const host={lastObservation:structuredClone(tablet),cancel(){},async observe(){this.lastObservation=structuredClone(tablet);return {contract_version:1,status:'observed',observation:this.lastObservation};},async run(action,q){if(action!=='memory-forget')throw Error('Unexpected fixture action');const bytes=Buffer.from(q.input_base64,'base64');const body=JSON.parse(bytes.toString());calls.push({selector:q.selector,bytes,body});return rawReply(await handler(q.selector,body));}};
  return {host,calls};
}
