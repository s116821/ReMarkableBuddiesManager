import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCleanupRaw,CleanupUnsupported} from '../host/source-cache-cleanup-private.mjs';
import {parseCleanupRequest} from '../host/source-cache-cleanup-protocol.mjs';
import {strictJson} from '../host/strict-json.mjs';
const v=JSON.parse(readFileSync(new URL('./fixtures/source-cache-cleanup-reference-vectors.json',import.meta.url),'utf8'));
const context={document:v.private_intent.document,operation:v.private_intent.operation,intent:v.private_intent};
test('independent cleanup report corpus: 30 valid, 72 invalid, 3 future',()=>{
 for(const c of v.valid){const p=parseCleanupRaw(Buffer.from(c.hex,'hex'),c.selector,context);assert.deepEqual(p.report,c.expected.report,c.name);assert.deepEqual(p.preview,c.expected.preview,c.name);}
 for(const c of v.invalid)assert.throws(()=>parseCleanupRaw(Buffer.from(c.hex,'hex'),c.selector,context),c.name);
 for(const c of v.future)assert.throws(()=>parseCleanupRaw(Buffer.from(c.hex,'hex'),c.selector,context),CleanupUnsupported,c.name);
});
test('independent public request shapes reject all 18 invalid vectors',()=>{for(const c of v.public_invalid)assert.throws(()=>{const raw=Buffer.from(c.hex,'hex');if(raw.length>384)throw Error('Original public bytes refused');return parseCleanupRequest(strictJson(raw));},c.name);for(const c of v.public_request_sizes)assert.deepEqual(parseCleanupRequest(c.request),c.request);});
test('safe action/report coherence rejects invented unknown status and cancel Busy/unsupported authority',async()=>{
 const {cleanupFixture,identity}=await import('./fixtures/source-cache-cleanup.mjs'),{parseCleanupResult}=await import('../host/source-cache-cleanup-protocol.mjs'),{validateResult}=await import('../host/observation-protocol.mjs'),{randomUUID}=await import('node:crypto');const f=cleanupFixture(),ready=(await f.prepare()).source_cache_cleanup,confirm={action:'confirm',...identity,reference:ready.reference,invocation:randomUUID()},unknown=await f.host.request(confirm);const status={action:'status',...identity,reference:ready.reference,invocation:randomUUID()},bad=structuredClone(unknown);bad.status='unconfigured';bad.observation=null;bad.source_cache_cleanup.report=null;assert.throws(()=>parseCleanupResult(bad,status,validateResult));for(const state of ['busy','unsupported']){bad.source_cache_cleanup.state=state;assert.throws(()=>parseCleanupResult(bad,{action:'cancel',reference:ready.reference,invocation:randomUUID()},validateResult));}f.host.invalidate();
});
