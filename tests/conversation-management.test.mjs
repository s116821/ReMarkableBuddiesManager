import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseManagementRaw,parseManagementIntent,managementHash} from '../host/conversation-management-private.mjs';
import {parseManagementRequest,parseManagementJson} from '../host/conversation-management-protocol.mjs';
const vectors=JSON.parse(readFileSync(new URL('./fixtures/conversation-management-reference-vectors.json',import.meta.url),'utf8'));
for(const c of vectors.cases)test(`management raw: ${c.name}`,()=>{
 const f=vectors.intent_fixtures.find(f=>f.name===c.fixture),context={conversation:f.intent.conversation,operation:f.intent.operation,intent:f.intent};
 if(c.expected.admit){const parsed=parseManagementRaw(Buffer.from(c.raw),c.selector,context);assert.equal(parsed.report.operation,c.selector);assert.equal(parsed.report.runtime_unverified,true);assert.equal('receipt' in parsed.report,false);assert.equal('intent' in parsed.report,false);}
 else assert.throws(()=>parseManagementRaw(Buffer.from(c.raw),c.selector,context));
});
test('correctly rehashed wrong path fails fixed path admission',()=>{const c=vectors.cases.find(c=>c.name==='wrong-path-valid-intent-hash'),i=JSON.parse(c.raw).intent;const {intent_sha256,...prefix}=i;assert.equal(managementHash('RMB-CONVERSATION-DELETE-V1\n'+JSON.stringify(prefix)),intent_sha256);assert.throws(()=>parseManagementIntent(i));});
test('public request excludes producer tokens and config/selector paths',()=>{
 const f=vectors.intent_fixtures[0],q={action:'inspect',connection_id:'a'.repeat(64),boot_id:f.intent.actor,invocation:f.intent.operation,conversation:f.intent.conversation};assert.deepEqual(parseManagementRequest(q),q);
 for(const field of ['intent','operation','selector','path','budget_ms'])assert.throws(()=>parseManagementRequest({...q,[field]:'private'}));
 for(const value of [null,[],{},true,{action:'retained',extra:true}])assert.throws(()=>parseManagementRequest(value));
});
test('raw rejects fatal UTF8 and every byte beyond report cap',()=>{const f=vectors.intent_fixtures[0];for(const raw of [Buffer.from([255]),Buffer.alloc(32769,32)])assert.throws(()=>parseManagementRaw(raw,'inspect',{conversation:f.intent.conversation}));});

test('safe browser JSON rejects BOM, recursive duplicates and excess bytes',()=>{for(const raw of [Buffer.from('\ufeff{}'),Buffer.from('{\"x\":{\"y\":1,\"y\":1}}'),Buffer.alloc(8193,32)])assert.throws(()=>parseManagementJson(raw));assert.deepEqual(parseManagementJson(Buffer.from('{}')),{});});
