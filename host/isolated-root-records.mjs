// Host-private original custody. These records never cross the renderer boundary.
import {createHash} from 'node:crypto';
import {strictJson} from './strict-json.mjs';
import {prepareIsolatedRoot,parseIsolatedRootInput} from './isolated-root-private.mjs';
import {parseSavedModeReport} from './saved-mode.mjs';
import {localModeDigest,localModeUuid} from './local-mode-choice-protocol.mjs';

const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const size=v=>Buffer.byteLength(JSON.stringify(v));
const refuse=()=>{throw Error('Isolated backup storage unavailable');};
export const isolatedRootHash=v=>createHash('sha256').update(v).digest('hex');
export const isolatedRootIdentity=record=>`${record.snapshot.token.actor}/${record.snapshot.epoch}`;

export function readIsolatedRootRecord(value){
 try{
  if(keys(value)!=='boot_id,connection_id,input_base64,input_sha256,reference,snapshot'||size(value)>2048||
   ![value.reference,value.connection_id,value.input_sha256].every(localModeDigest)||!localModeUuid(value.boot_id)||
   typeof value.input_base64!=='string'||value.input_base64.length>684)refuse();
  const input=Buffer.from(value.input_base64,'base64');
  if(input.length<1||input.length>512||input.toString('base64')!==value.input_base64||isolatedRootHash(input)!==value.input_sha256)refuse();
  const parsed=parseIsolatedRootInput(strictJson(input));
  const inspect={report_version:1,operation:'inspect',status:'ok',incomplete:false,activation_performed:false,
   data:{current_snapshot:value.snapshot,receipt:null,receipt_status:null}};
  const original=prepareIsolatedRoot(Buffer.from(JSON.stringify(inspect)+'\n'),parsed.operation);
  if(JSON.stringify(parsed)!==JSON.stringify(original.input))refuse();
  return {record:structuredClone(value),input,original,view:parseSavedModeReport(inspect).snapshot};
 }catch{refuse();}
}

export function createIsolatedRootRecord(reference,sample,original){
 const input=Buffer.from(JSON.stringify(original.input));
 return readIsolatedRootRecord({reference,connection_id:sample.connection_id,boot_id:sample.boot_id,
  snapshot:structuredClone(original.snapshot),input_base64:input.toString('base64'),input_sha256:isolatedRootHash(input)});
}

export function readIsolatedRootRecords(response){
 try{
  if(keys(response)!=='digest,value'||response.digest!==null&&!localModeDigest(response.digest))refuse();
  if(response.value===null){if(response.digest!==null)refuse();return {digest:null,entries:[]};}
  const value=response.value;
  if(response.digest===null||keys(value)!=='originals,version'||value.version!==1||!Array.isArray(value.originals)||
   value.originals.length>8||size(value)+1>20480)refuse();
  const entries=value.originals.map(readIsolatedRootRecord),refs=new Set(),identities=new Set();
  for(const entry of entries){const identity=isolatedRootIdentity(entry.record);
   if(refs.has(entry.record.reference)||identities.has(identity))refuse();
   refs.add(entry.record.reference);identities.add(identity);
  }
  return {digest:response.digest,entries};
 }catch{refuse();}
}
