// Observed Windows producer frames, replayed through real consumer code with synthetic transport.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';import {createHash,randomUUID} from 'node:crypto';
import {parseArchiveRaw} from '../host/notebook-archive-private.mjs';
import {NotebookArchiveHost} from '../host/notebook-archive.mjs';
import {tablet} from './fixtures/ordinary-restore.mjs';
const root=new URL('./fixtures/notebook-archive-interop/',import.meta.url),read=n=>readFileSync(new URL(n,root)),json=n=>JSON.parse(read(n));
const sha=b=>createHash('sha256').update(b).digest('hex');
const cases=[['01-busy','refused'],['02-missing','unavailable'],['03-export','exported'],['04-inspect','inspected'],['05-existing','refused'],['06-legacy-inspect','unavailable']];
test('actual producer frame/executable/source provenance and complete archive fixture byte custody',()=>{
 const provenance=json('provenance.json');assert.equal(provenance.source,'5e18c63edbde1b69970a6540668a0d9f08f96a90');assert.equal(provenance.source_tree,'871a4935722350d9abe115bac4c1f5128b10c674');
 for(const [name,f]of Object.entries(provenance.files)){const bytes=read(name);assert.equal(bytes.length,f.bytes,name);assert.equal(sha(bytes),f.sha256,name);}
 const executable=json('executable.receipt.json');assert.equal(executable.source,provenance.source);assert.equal(executable.tree,provenance.source_tree);assert.equal(executable.platform,'Windows');assert.equal(executable.sha256,'b827f577725ba2baf8733cfd07d7d3fbde048653a67c410936926fcc357be2ef');
 const archive=json('format4-archive/backup.json'),exported=json('03-export.stdout').data.inspection;assert.equal(archive.format,4);assert.equal(archive.complete_media,true);assert.equal(archive.manifests.length,exported.manifests);assert.equal(archive.objects.length,42);assert.equal(exported.objects,42);
 assert.deepEqual(readdirSync(new URL('format4-archive/objects/',root)).sort(),archive.objects.map(o=>o.sha256).sort());
 for(const o of archive.objects){const bytes=read('format4-archive/objects/'+o.sha256);assert.equal(bytes.length,o.bytes);assert.equal(sha(bytes),o.sha256);}
 assert.deepEqual(json('03-export.stdout').data,json('04-inspect.stdout').data);
});
for(const [stem,expected]of cases)test(`observed ${stem} frame through parser and original-custody host boundary`,async()=>{
 const receipt=json(stem+'.receipt.json'),stdout=read(stem+'.stdout'),stderr=read(stem+'.stderr');assert.equal(receipt.exit_code,0);assert.equal(stdout.length,receipt.stdout_bytes);assert.equal(sha(stdout),receipt.stdout_sha256);assert.equal(stderr.length,receipt.stderr_bytes);assert.equal(sha(stderr),receipt.stderr_sha256);
 const legacy=receipt.operation==='inspect',selector=legacy?'inspect-notebook':receipt.operation;
 if(legacy)assert.throws(()=>parseArchiveRaw(stdout,selector));else assert.equal(parseArchiveRaw(stdout,selector).status,json(stem+'.stdout').status);
 let calls=0;
 const observer={lastObservation:structuredClone(tablet),cancel(){},async run(action,q){calls++;assert.equal(action,'notebook-archive');assert.equal(q.selector,selector);assert.deepEqual(JSON.parse(Buffer.from(q.input_base64,'base64')),{path:'/synthetic/private-notebook-fixture'});return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),archive_raw:{status:'reported',stdout_base64:stdout.toString('base64')}};}};
 const host=new NotebookArchiveHost({observer});const q=(action,fields)=>({action,connection_id:tablet.connection_id,boot_id:tablet.boot_id,invocation:randomUUID(),...fields});let result;
 if(selector==='export-notebook'){
  const review=(await host.request(q('prepare-export',{path:'/synthetic/private-notebook-fixture'}))).notebook_archive;assert.equal(calls,0);result=(await host.request(q('confirm-export',{reference:review.reference}))).notebook_archive;assert.equal(result.original_outcome,expected);
 }else result=(await host.request(q('inspect',{path:'/synthetic/private-notebook-fixture'}))).notebook_archive;
 assert.equal(result.state,expected);assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('private-notebook-fixture'),false);
 if(['exported','inspected'].includes(expected))assert.deepEqual(result.summary,json(stem+'.stdout').data.inspection);else assert.equal(result.summary,null);host.invalidate();
});
