import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {portableHash,parsePortableReport} from '../host/portable-configuration-private.mjs';
import {portableCanonical,portableArtifactBytes} from '../host/portable-configuration-protocol.mjs';
import {portableFixture,identity} from './fixtures/portable-configuration.mjs';
const root=new URL('./fixtures/portable-configuration-e5bf3b8/',import.meta.url),corpus=JSON.parse(await readFile(new URL('corpus.json',root))),manifestRaw=await readFile(new URL('file-manifest.json',root)),manifest=JSON.parse(manifestRaw);
const pathHash=p=>portableHash('remarkable-buddies-portable-import-path-v1\0'+p);
test('original transferred corpus manifest/source/build identity and all raw capture bytes remain attributed',async()=>{
 assert.equal(portableHash(manifestRaw),'4f69dfca80558fd52cfe56bc5fb6e878d7735f2209022fb849aa32c74a11d76c');assert.equal(corpus.source_contents_commit,'e5bf3b8ad7f5681f3f90d7cfc097aee3cae53ca3');assert.equal(corpus.producer_version_stdout,'remarkable-reader-buddy dev.v0.73.0-dirty\n');assert.equal(corpus.cases.length,26);
 for(const [name,expected] of Object.entries(manifest.files)){const raw=await readFile(new URL(name,root));assert.equal(raw.length,expected.bytes,name);assert.equal(portableHash(raw),expected.sha256,name);}
 for(const c of corpus.cases){const raw=await readFile(new URL('cases/'+c.name+'.stdout.bin',root)),input=await readFile(new URL('cases/'+c.name+'.stdin.bin',root));assert.equal(c.exit,0);assert.equal(c.stderr_utf8,'');assert.deepEqual(raw,Buffer.from(c.stdout_utf8));assert.deepEqual(input,Buffer.from(c.stdin_base64,'base64'));assert.equal(portableHash(raw),c.stdout_sha256);assert.equal(portableHash(input),c.stdin_sha256);}
});
test('all26 actual producer phase reports validate without rewriting Windows path or build identity',()=>{
 const byName=new Map(corpus.cases.map(c=>[c.name,c]));
 for(const c of corpus.cases){const r=JSON.parse(c.stdout_utf8),input=c.stdin_base64?JSON.parse(Buffer.from(c.stdin_base64,'base64')):null;let context={config_path_sha256:pathHash(c.selected_config_path)};
  if(r.operation==='prepare'){
   const inspect=JSON.parse(byName.get(c.name+'-inspect').stdout_utf8);context={...context,...inspect.data,...input,artifact_sha256:portableHash(portableCanonical(input.artifact))};
  }else if(['apply','status'].includes(r.operation)&&r.status==='ok'){
   const original=corpus.cases.map(x=>JSON.parse(x.stdout_utf8)).find(x=>x.operation==='prepare'&&x.data?.intent?.operation===input.intent.operation);assert.ok(original,c.name);context={...context,intent:input.intent,summary:{kind:'import',changed_settings:original.data.changed_settings,before:original.data.before,after:original.data.after}};
  }
  const parsed=parsePortableReport(Buffer.from(c.stdout_utf8),r.operation,context);assert.equal(parsed.report.status,r.status,c.name);assert.equal(parsed.report.runtime_activation,'unverified');parsed.file?.fill(0);
 }
});
test('actual Rust compact artifact bytes match Node ordering/escaping including Unicode/control text and explicit export host boundary',async()=>{
 for(const a of corpus.artifacts){const original=await readFile(new URL(a.file,root)),value=portableArtifactBytes(original);assert.equal(original.length,a.bytes);assert.equal(portableHash(original),a.producer_digest);assert.deepEqual(Buffer.from(portableCanonical(value)),original);const reversed={settings:Object.fromEntries(Object.entries(value.settings).reverse()),portable_configuration_version:1};assert.equal(portableCanonical(reversed),original.toString());}
 const actual=corpus.cases.find(c=>c.name==='export-rich'),f=portableFixture();f.portableState.onExport=()=>actual.stdout_utf8;const result=await f.portable.request({action:'export',...identity});assert.equal(result.portable_configuration.state,'exported');const file=Buffer.from(result.portable_configuration.export_file.bytes_base64,'base64');assert.equal(portableHash(file.subarray(0,-1)),corpus.artifacts[0].producer_digest);f.portable.dispose();
});
