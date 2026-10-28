import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {startHelper} from '../host/browser-helper.mjs';
import {conversationFixture} from './fixtures/conversation-inventory.mjs';
import {addManagementFixture,defer} from './fixtures/conversation-management.mjs';
import {verifyHundredThirtyTwoDirections,verifyHundredThirtyTwoBusyDirections} from './fixtures/maintenance-twelve-lanes.mjs';
const routes={conversationManagement:'conversation-management',sourceCacheCleanup:'source-cache-cleanup',inspectSourceCache:'source-cache-inventory',inspectConversations:'conversation-inventory',modelSettings:'model-settings',basicSettings:'basic-settings',memoryForget:'memory-forget',ordinaryExport:'ordinary-export',researchSettings:'research-settings',memorySettings:'memory-settings',credentialReference:'credential-reference',modelCredential:'model-credential'};
test('actual browser factory132 grant exclusions and132 active-owner Busy directions preserve110',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'manager-conversation-factory-'));await writeFile(path.join(root,'index.html'),'<!doctype html>');t.after(()=>rm(root,{recursive:true,force:true}));
 const f=addManagementFixture(conversationFixture());let gate=null;const previous=f.observer.run;f.observer.run=async function(...args){if(gate){gate.entered.resolve();await gate.wait.promise;}return previous.apply(this,args);};
 const helper=await startHelper({root,observer:f.observer,driveAuth:{dispose(){}},downloads:{dispose(){}}});t.after(()=>helper.close());const first=await fetch(helper.origin+'/preview/');const cookie=first.headers.get('set-cookie').split(';')[0];await first.text();
 const request=async(name,q)=>{const r=await fetch(helper.origin+'/manager-'+routes[name],{method:'POST',headers:{Origin:helper.origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(q)});assert.equal(r.status,200,name);return r.json();};
 await verifyHundredThirtyTwoDirections(request);await verifyHundredThirtyTwoBusyDirections(request,{hold:async()=>{gate={entered:defer(),wait:defer()};},entered:()=>gate.entered.promise,snapshot:async()=>[f.calls.length,f.observer.cancels,f.managementState.hooks],release:async()=>{const old=gate;gate=null;old.wait.resolve();}});
 for(const [suffix,body,status] of [['?x=1','{}',403],['','x'.repeat(385),413],['','{"action":"retained","action":"retained"}',400],['','{"action":"retained","intent":{}}',400]]){const r=await fetch(helper.origin+'/manager-conversation-management'+suffix,{method:'POST',headers:{Origin:helper.origin,'Content-Type':'application/json',Cookie:cookie},body});assert.equal(r.status,status);await r.text();}
});
