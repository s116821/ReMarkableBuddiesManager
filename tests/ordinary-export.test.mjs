import test from 'node:test';import assert from 'node:assert/strict';
import {exportFixture,tablet,destination,defer} from './fixtures/ordinary-export.mjs';
const identity={connection_id:tablet.connection_id,boot_id:tablet.boot_id};
const prepare=f=>f.host.request({action:'prepare',...identity,destination});
const confirm=(f,r)=>f.host.request({action:'confirm',...identity,reference:r.ordinary_export.reference});
const status=(f,r)=>f.host.request({action:'status',...identity,reference:r.ordinary_export.reference});
test('explicit preview/confirm preserves exact stdin/private absence and terminal state; partial output is honest',async()=>{
 const f=exportFixture(),q={action:'prepare',...identity,destination};const pending=f.host.request(q);q.destination='/MUTATED';const r=await pending;assert.equal(r.ordinary_export.state,'ready');assert.equal(f.state.calls[0].body.destination,destination);assert.equal(JSON.stringify(r).includes('PRIVATE'),false);assert.equal(f.state.calls.length,1);
 const result=await confirm(f,r);assert.equal(result.ordinary_export.state,'verified');assert.equal(f.state.calls[1].body.destination,destination);assert.equal(result.ordinary_export.report.runtime_activation,'unverified');assert.deepEqual((await f.host.request({action:'retained'})).ordinary_export.retained,[]);
 assert.equal((await confirm(f,r)).ordinary_export.state,'unavailable');const p=await prepare(f);f.state.mode='not-published';assert.equal((await confirm(f,p)).ordinary_export.state,'not-published');f.host.invalidate();
});
test('unknown/unresolved original packets survive refusals/reload-style snapshots, capacity and cross-lane stale cancel/status',async()=>{
 const f=exportFixture();f.state.mode='lost';const r=await prepare(f),unknown=await confirm(f,r);assert.equal(unknown.ordinary_export.state,'unknown');const original=structuredClone(f.state.calls[1].body);f.state.mode='unresolved';assert.equal((await status(f,r)).ordinary_export.state,'unresolved');assert.deepEqual(f.state.calls[2].body,original);
 f.state.mode='status-refused';const refused=await status(f,r);assert.equal(refused.ordinary_export.state,'unavailable');assert.equal(refused.ordinary_export.retained.length,1);
 const token=f.io.acquire('basic','other','save'),calls=f.state.calls.length,hooks=f.state.hooks;assert.equal((await status(f,r)).ordinary_export.state,'busy');await f.host.request({action:'cancel',reference:r.ordinary_export.reference});assert.equal(f.state.calls.length,calls);assert.equal(f.state.hooks,hooks);assert.equal(f.state.cancels,0);assert.equal(f.io.owns(token),true);f.io.release(token);
 f.state.mode='normal';assert.equal((await status(f,r)).ordinary_export.state,'desired-archive-observed');assert.deepEqual(f.state.calls.at(-1).body,original);
 f.state.mode='lost';for(let n=0;n<8;n++)await confirm(f,await prepare(f));assert.equal((await prepare(f)).ordinary_export.state,'capacity');assert.equal((await f.host.request({action:'retained'})).ordinary_export.retained.length,8);f.host.invalidate();
});
test('ready expiry, packet expansion and deadline crossing never dispatch confirmation; lost/late apply stays unknown',async()=>{
 let now=0;const f=exportFixture({now:()=>now}),r=await prepare(f);now=120001;assert.equal((await confirm(f,r)).ordinary_export.state,'unavailable');assert.equal(f.state.calls.length,1);
 const big=exportFixture();big.state.onPrepare=r=>{r.data.intent.configuration_snapshot_sha256='a'.repeat(64);r.data.source.configuration_included=true;return r;};assert.equal((await big.host.request({action:'prepare',...identity,destination:'/'+'\x01'.repeat(2600)})).ordinary_export.state,'unavailable');assert.equal(big.state.calls.length,1);big.host.invalidate();
 now=0;const late=exportFixture({now:()=>now});late.state.onPrepare=r=>{now=13001;return r;};assert.equal((await prepare(late)).ordinary_export.state,'unavailable');assert.equal(late.state.calls.length,1);
 now=0;late.state.onPrepare=null;const next=await prepare(late);late.state.onApply=r=>{now+=13001;return r;};assert.equal((await confirm(late,next)).ordinary_export.state,'unknown');assert.equal((await late.host.request({action:'retained'})).ordinary_export.retained.length,1);late.host.invalidate();f.host.invalidate();
});
test('targeted stop and old completion cannot release a newer owner or erase its private original',async()=>{
 const f=exportFixture(),r=await prepare(f),gate=defer();f.state.onApply=async r=>{await gate.promise;return r;};const pending=confirm(f,r);await new Promise(r=>setImmediate(r));assert.equal((await f.host.request({action:'cancel',reference:r.ordinary_export.reference})).ordinary_export.state,'unknown');const token=f.io.acquire('model','newer','save');gate.resolve();assert.equal((await pending).ordinary_export.state,'unknown');assert.equal(f.io.owns(token),true);assert.equal((await f.host.request({action:'retained'})).ordinary_export.retained.length,1);f.io.release(token);f.host.invalidate();
});
