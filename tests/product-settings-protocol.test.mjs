import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseProductRawFrame,parseProductSettingsReport,parseProductSettingsRequest,parseProductSettingsResult} from '../host/product-settings-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
const bytes=await readFile(new URL('./fixtures/product-settings-c3d095c-vectors.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'9f0f2b6e1f2e9c49323390f8038f93fc5a0cd6765dde9f2400e0215e08914152');
const vectors=JSON.parse(bytes);
for(const row of vectors.raw_protocol)test('reviewed raw frame '+row.id,()=>{
 const run=()=>parseProductSettingsReport(parseProductRawFrame(Buffer.from(row.raw_utf8)),row.operation,row.context);
 if(row.accept)assert.doesNotThrow(run);else assert.throws(run);
});
for(const row of vectors.public_requests)test('reviewed public request '+row.id,()=>{
 const run=()=>parseProductSettingsRequest(row.input);if(row.accept)assert.doesNotThrow(run);else assert.throws(run);
});
for(const row of vectors.public_results)test('reviewed public result '+row.id,()=>{
 const run=()=>parseProductSettingsResult(row.input,row.request,validateResult);if(row.accept)assert.doesNotThrow(run);else assert.throws(run);
});
// The19 whole-file fixtures belong to the Rust writer, and the14 lifecycle
// catalog entries are expectations; neither is counted as an execution here.
