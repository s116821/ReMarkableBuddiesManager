// Independent source-derived Report vectors; these are not observed producer stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseArchiveRaw} from '../host/notebook-archive-private.mjs';
import {archiveSummary,parseArchiveRequest,parseArchiveResult} from '../host/notebook-archive-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {parseArchiveRaw as legacyRaw} from '../host/selected-archive-private.mjs';
const vectors=JSON.parse(readFileSync(new URL('./fixtures/selected-archive-reference-vectors.json',import.meta.url)));
const observation=vectors.public_cases.find(x=>x.id==='inspected-valid').result.observation;
const summary={format:4,manifests:2,objects:7,selected_scopes:0,selection_receipts:0,complete_media:true,configuration_included:true};
const request={action:'inspect',connection_id:observation.connection_id,boot_id:observation.boot_id,invocation:observation.boot_id,path:'/archive'};
const frame=(operation='inspect-notebook',status='ok')=>({report_version:1,operation,status,incomplete:['unavailable','failed'].includes(status),activation_performed:false,data:status==='ok'?{inspection:{...summary}}:null});
const raw=v=>Buffer.from(JSON.stringify(v)+'\n');
test('closed notebook success/refusal schema, no legacy format widening',()=>{
 for(const operation of ['inspect-notebook','export-notebook']){
  for(const configuration_included of [true,false])assert.equal(parseArchiveRaw(raw({...frame(operation),data:{inspection:{...summary,configuration_included}}}),operation).status,'ok');
  for(const status of ['invalid-input','unavailable','unsupported',...(operation==='export-notebook'?['busy','failed']:[])]){
   assert.equal(parseArchiveRaw(raw(frame(operation,status)),operation).status,status);
   assert.throws(()=>parseArchiveRaw(raw({...frame(operation,status),incomplete:!frame(operation,status).incomplete}),operation));
   assert.throws(()=>parseArchiveRaw(raw({...frame(operation,status),data:{inspection:summary}}),operation));
  }
 }
 const ok=frame();for(const changed of [{report_version:2},{operation:'inspect'},{status:'busy'},{incomplete:true},{activation_performed:true},{extra:0},{data:null},{data:{inspection:summary,extra:0}}])assert.throws(()=>parseArchiveRaw(raw({...ok,...changed}),'inspect-notebook'));
 for(const changed of [{format:1},{format:2},{format:3},{format:5},{complete_media:false},{selected_scopes:1},{selection_receipts:1},{configuration_included:0},{manifests:-1},{objects:4097},{objects:1.5},{objects:true},{objects:1e30},{extra:0}])assert.throws(()=>archiveSummary({...summary,...changed}));
 for(const n of [0,4096])assert.doesNotThrow(()=>archiveSummary({...summary,manifests:n,objects:n}));
 assert.throws(()=>legacyRaw(raw(frame()),'inspect-notebook'));
});
test('report bytes reject duplicates, framing, BOM, invalid UTF8, future/extra fields and exact cap edge',()=>{
 const good=raw(frame());assert.doesNotThrow(()=>parseArchiveRaw(Buffer.concat([good.subarray(0,-1),Buffer.alloc(16384-good.length,32),Buffer.from('\n')]),'inspect-notebook'));
 for(const bad of [Buffer.concat([good.subarray(0,-1),Buffer.alloc(16385-good.length,32),Buffer.from('\n')]),Buffer.concat([Buffer.from([239,187,191]),good]),Buffer.from([255,10]),Buffer.concat([good,good]),Buffer.concat([good,Buffer.from('\n')]),good.subarray(0,-1),Buffer.from(good.toString().replace('"report_version":1','"report_version":1,"report_version":1')),Buffer.from(good.toString().replace('"manifests":2','"manifests":NaN')),Buffer.from(good.toString().replace('\n','\r\n'))])assert.throws(()=>parseArchiveRaw(bad,'inspect-notebook'));
});
test('public path requests retain exact private scalars and closed action authority',()=>{
 assert.equal(parseArchiveRequest({...request,path:'/a\r\n '}).path,'/a\r\n ');
 for(const path of ['/','relative','/nul\0','/surrogate\ud800','/'+ 'é'.repeat(2048)])assert.throws(()=>parseArchiveRequest({...request,path}));
 assert.doesNotThrow(()=>parseArchiveRequest({...request,path:'/'+'x'.repeat(4095)}));
 for(const q of [{...request,intent:{}},{...request,action:'export-notebook'},{...request,action:'retained'},{action:'retained',path:'/a'},{...request,path:undefined}])assert.throws(()=>parseArchiveRequest(q));
 assert.deepEqual(parseArchiveRequest({action:'retained'}),{action:'retained'});
});
test('closed public notebook summary is private and action-correlated',()=>{
 const value={contract_version:1,status:'observed',observation,notebook_archive:{state:'inspected',reference:'1'.repeat(64),invocation:request.invocation,summary,original_outcome:null,check_outcome:null,retained:[]}};
 assert.doesNotThrow(()=>parseArchiveResult(value,request,validateResult));
 for(const changed of [{summary:{...summary,format:2}},{summary:{...summary,path:'/private'}},{state:'partial-media'},{state:'exported'},{invocation:'0'.repeat(36)},{extra:0},{original_outcome:'unknown'}])assert.throws(()=>parseArchiveResult({...value,notebook_archive:{...value.notebook_archive,...changed}},request,validateResult));
 assert.throws(()=>parseArchiveResult({...value,path:'/private'},request,validateResult));
});
