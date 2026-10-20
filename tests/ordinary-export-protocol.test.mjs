import {validateResult} from '../host/observation-protocol.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {parseExportReport,parseExportRequest,parseExportResult,exportResponseContext,exportPath,EXPORT_CONFIG} from '../host/ordinary-export-protocol.mjs';
import {exportFixture,summary,intent,report,hash,destination,tablet} from './fixtures/ordinary-export.mjs';
test('all38 unchanged historical Windows reports and76hashes parse without granting POSIX destination authority',async()=>{
 const j=JSON.parse(await readFile(new URL('./fixtures/ordinary-export-adee57d-corpus.json',import.meta.url)));let count=0;
 for(const row of j.records){assert.equal(hash(Buffer.from(row.stdin_base64,'base64')),row.stdin_sha256);assert.equal(hash(row.stdout_utf8),row.stdout_sha256);const r=JSON.parse(row.stdout_utf8);parseExportReport(r,r.operation);count++;if(r.outcome==='prepared'){assert.throws(()=>parseExportReport(r,'prepare',{operation:r.data.intent.operation,destination_path_sha256:hash('urn:remarkable-buddies:ordinary-export-path:v1:'+destination),config_path_sha256:hash('urn:remarkable-buddies:ordinary-export-config:v1:'+EXPORT_CONFIG)}));}}
 assert.equal(count,38);assert.equal(j.source_commit,'adee57de94478e78627b45cb21ace470f8070bb4');
});
test('exact path/scalar/body/report/header/count/intent/summary refusal and golden references',async()=>{
 assert.equal(exportPath(destination),true);for(const p of ['/','C:\\Windows','relative','/a\0b','/\ud800','/'+'x'.repeat(4096)])assert.equal(exportPath(p),false);
 const q={action:'prepare',connection_id:tablet.connection_id,boot_id:tablet.boot_id,destination};parseExportRequest(q);for(const v of [{...q,extra:true},{...q,connection_id:'bad'},{...q,destination:'/'+'\x01'.repeat(4095)}])assert.throws(()=>parseExportRequest(v));
 const i=intent('11111111-1111-4111-8111-111111111111',destination),r=report('prepare','prepared',{source:summary,intent:i});parseExportReport(r,'prepare');
 for(const v of [{...r,data:{...r.data,secret:'PRIVATE'}},{...r,runtime_activation:'restart-required'},{...r,disk_readback_verified:true},{...r,data:{...r.data,source:{...summary,manifests:4097}}},{...r,data:{...r.data,intent:{...i,operation:'00000000-0000-0000-0000-000000000000'}}}])assert.throws(()=>parseExportReport(v,'prepare'));
 const path=JSON.parse(await readFile(new URL('./fixtures/ordinary-export-path-vector.json',import.meta.url)));assert.equal(hash('urn:remarkable-buddies:ordinary-export-path:v1:'+path.destination),path.destination_path_sha256);
 const empty=JSON.parse(await readFile(new URL('./fixtures/ordinary-export-empty-vector.json',import.meta.url)));assert.equal(Buffer.byteLength(empty.backup_utf8),85);assert.equal(hash(empty.backup_utf8),empty.archive_sha256);assert.equal(hash('urn:remarkable-buddies:ordinary-history:v1:\n'),empty.empty_history_sha256);
});

test('finite public projection refuses private extras, wrong action/state and mismatched identity/reference',async()=>{
 const f=exportFixture(),q={action:'prepare',connection_id:tablet.connection_id,boot_id:tablet.boot_id,destination},ready=await f.host.request(q),context=exportResponseContext(q);parseExportResult(ready,context,validateResult);
 for(const change of [v=>{v.ordinary_export.destination='PRIVATE';},v=>{v.ordinary_export.summary.path='PRIVATE';},v=>{v.ordinary_export.report.data={intent:{}};},v=>{v.ordinary_export.state='verified';},v=>{v.observation.boot_id='99999999-9999-4999-8999-999999999999';},v=>{v.ordinary_export.reference='a'.repeat(64);},v=>{v.ordinary_export.retained=[{reference:ready.ordinary_export.reference,connection_id:tablet.connection_id,boot_id:tablet.boot_id,state:'ready'}];}]){const value=structuredClone(ready);change(value);assert.throws(()=>parseExportResult(value,context,validateResult));}f.host.invalidate();
});
