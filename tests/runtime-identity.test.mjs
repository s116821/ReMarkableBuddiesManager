import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeIdentityController } from '../src/runtime-identity.ts';
import { parseRuntimeIdentity } from '../host/runtime-identity.mjs';
import { startHelper } from '../host/browser-helper.mjs';
import { WiredObserver } from '../host/observer.mjs';
import { tablet } from './fixtures/owned-report.mjs';
export const identity = (status='reported') => ({ report_version:1,status,binary_version:status==='reported'?'0.1.4-dev-synthetic':null,provenance:'unknown',package_owner:'unknown',running_version:null,installation_eligible:false });
const reply = report => ({contract_version:1,status:'observed',observation:tablet,runtime_identity:report});
test('strict identity is unqualified and refuses forged provenance/eligibility, multiline, fields and unsupported schema',()=>{
  assert.equal(parseRuntimeIdentity(identity()).installation_eligible,false);
  for(const extra of [{provenance:'official'},{running_version:'0.1.4'},{installation_eligible:true},{report_version:2},{binary_version:'0.1.4\nPRIVATE_SENTINEL'},{secret:'PRIVATE_SENTINEL'},{binary_version:'x'.repeat(97)}]) assert.throws(()=>parseRuntimeIdentity({...identity(),...extra}));
  for(const status of ['missing','unsafe','unsupported','unavailable']) assert.equal(parseRuntimeIdentity(identity(status)).binary_version,null);
});
test('shared display suppresses late/cross-boot results and does not convert self-report into running or installed authority',async()=>{
  const c=new RuntimeIdentityController(()=>{});await c.inspect({inspectRuntime:async()=>reply(identity())},tablet);assert.match(c.state.status,/unverified/);assert.equal(c.state.report.running_version,null);
  let finish;const pending=c.inspect({inspectRuntime:()=>new Promise(r=>finish=r)},tablet);c.clear();finish(reply(identity()));await pending;assert.equal(c.state.report,null);
  await c.inspect({inspectRuntime:async()=>({...reply(identity()),observation:{...tablet,boot_id:'22222222-2222-2222-2222-222222222222'}})},tablet);assert.equal(c.state.report,null);
  await c.inspect({inspectRuntime:async()=>reply({...identity(),secret:'PRIVATE_SENTINEL'})},tablet);assert.equal(c.state.report,null);
});
test('actual fixed child identity IO sanitizes malformed output, bounds responses and rejects changed session',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'manager-runtime-child-'));t.after(()=>rm(dir,{recursive:true,force:true}));const config=path.join(dir,'config');await writeFile(config,'normal');
  await writeFile(path.join(dir,'runtime_identity_transport.py'),`const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const q=JSON.parse(raw);if(Object.keys(q).sort().join()!=='boot_id,connection_id'||process.argv.length!==2)throw Error('wrong child input');const mode=fs.readFileSync(process.env.MANAGER_WIRED_CONFIG,'utf8');if(mode==='oversize'){console.log('x'.repeat(8193));return}const v=${JSON.stringify(reply(identity()))};if(mode==='changed')v.observation.boot_id='22222222-2222-2222-2222-222222222222';if(mode==='secret')v.runtime_identity.secret='PRIVATE_SENTINEL';console.log(JSON.stringify(v))});`);
  const host=new WiredObserver({config,python:process.execPath,script:path.join(dir,'wired_observer.py')});assert.equal((await host.inspectRuntime()).runtime_identity,null);host.lastObservation=tablet;assert.equal((await host.inspectRuntime()).runtime_identity.binary_version,'0.1.4-dev-synthetic');
  for(const mode of ['oversize','changed','secret']){await writeFile(config,mode);const value=await host.inspectRuntime();assert.equal(value.runtime_identity,null);assert.equal(JSON.stringify(value).includes('PRIVATE_SENTINEL'),false);}
});

test('actual helper fixed runtime action refuses extra command/path and remote origin before dispatch',async t=>{
 let calls=0;const helper=await startHelper({root:path.resolve('dist/manager/browser'),observer:{cancel(){},inspectRuntime:async()=>{calls++;return reply(identity());}},driveAuth:{dispose(){}}});t.after(()=>helper.close());
 const initial=await fetch(helper.origin+'/preview/');const cookie=initial.headers.get('set-cookie').split(';')[0];const headers={Origin:helper.origin,Cookie:cookie,'Content-Type':'application/json'};
 const send=(body,h=headers)=>fetch(helper.origin+'/manager-host',{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await send({action:'inspect-runtime',path:'/arbitrary'})).status,400);assert.equal((await send({action:'inspect-runtime'},{...headers,Origin:'https://untrusted.invalid'})).status,403);assert.equal(calls,0);
 assert.equal((await send({action:'inspect-runtime'})).status,200);assert.equal(calls,1);
});
