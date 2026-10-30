import test from 'node:test';
import assert from 'node:assert/strict';
import {productFixture,begin,save,identity,defer} from './fixtures/product-settings.mjs';
const view=v=>v.product_settings;
test('single dirty declaration, exact retained packet, uncertainty and original status only',async()=>{
 const f=productFixture();f.state.onApply=()=>{throw Error('lost');};const reference=await begin(f),r=view(await save(f,reference));assert.equal(r.state,'unknown');
 assert.equal(r.current,null);assert.equal(r.retained.length,1);assert.deepEqual(f.calls[1].body.changes,{reader_enabled:{action:'set',value:false}});
 const original=f.calls[2].bytes;const calls=f.calls.length;assert.equal(view(await save(f,reference)).state,'unavailable');assert.equal(f.calls.length,calls);
 const result=view(await f.product.request({action:'status',...identity,reference}));assert.equal(result.state,'desired-file-observed');assert.deepEqual(f.calls.at(-1).bytes,original);
 for(const secret of ['sha256','intent','operation":"111','config_path'])assert.equal(JSON.stringify(r).includes(secret),false);
});
test('permanent ready cancellation defeats delayed Save and stale cancel preserves successor owner',async()=>{
 const f=productFixture(),old=await begin(f);assert.equal(view(await f.product.request({action:'cancel',reference:old})).state,'invalidated');const calls=f.calls.length;assert.equal(view(await save(f,old)).state,'unavailable');assert.equal(f.calls.length,calls);
 const fresh=await begin(f),d=defer();f.state.onPrepare=async r=>{await d.promise;return r;};const pending=save(f,fresh);await Promise.resolve();const owner=f.io.ownerFor('product-settings',fresh);assert.ok(owner);await f.product.request({action:'cancel',reference:old});assert.ok(f.io.owns(owner));d.resolve();assert.equal(view(await pending).state,'verified');
});
test('Busy refuses before hooks, ready expiry prevents apply, total budget decreases across phases',async()=>{
 let now=0,hooks=0;const f=productFixture({now:()=>now,beforeIO:()=>hooks++}),reference=await begin(f);const token=f.io.acquire('other','x','save'),calls=f.calls.length;
 assert.equal(view(await save(f,reference)).state,'busy');assert.equal(hooks,1);assert.equal(f.calls.length,calls);f.io.release(token);
 now=120000;assert.equal(view(await save(f,reference)).state,'unavailable');assert.equal(f.calls.length,calls);
 now=0;const next=await begin(f);f.state.onPrepare=r=>{now+=11000;return r;};assert.equal(view(await save(f,next)).state,'verified');assert.equal(f.calls.at(-1).budget_ms,2000);
});
test('thirty minute custody is nonrenewing; expired safe rows survive with no status or retry',async()=>{
 let now=0;const f=productFixture({now:()=>now});f.state.onApply=()=>{throw Error('lost');};const reference=await begin(f);await save(f,reference);now=1799999;
 f.state.onStatus=r=>({...r,outcome:'unresolved',data:{...r.data,observed_sha256:'9'.repeat(64)}});assert.equal(view(await f.product.request({action:'status',...identity,reference})).state,'unresolved');const calls=f.calls.length;now=1800000;
 assert.equal(view(await f.product.request({action:'status',...identity,reference})).state,'unavailable');assert.equal(f.calls.length,calls);assert.equal(view(await f.product.request({action:'retained'})).retained.length,1);assert.equal(view(await save(f,reference)).state,'unavailable');
});
test('32 executing statuses maximum; Busy consumes no original quota',async()=>{
 const f=productFixture();f.state.onApply=()=>{throw Error('lost');};const reference=await begin(f);await save(f,reference);f.state.onStatus=r=>({...r,outcome:'unresolved',data:{...r.data,observed_sha256:'9'.repeat(64)}});
 const token=f.io.acquire('peer','x','read');assert.equal(view(await f.product.request({action:'status',...identity,reference})).state,'busy');f.io.release(token);
 for(let i=0;i<32;i++)assert.equal(view(await f.product.request({action:'status',...identity,reference})).state,'unresolved');const calls=f.calls.length;assert.equal(view(await f.product.request({action:'status',...identity,reference})).state,'unavailable');assert.equal(f.calls.length,calls);
});
test('host total deadline settles even a nonresponding lower layer; late completion cannot apply',async()=>{
 const f=productFixture({budgetMs:30}),gate=defer();f.state.onPrepare=async r=>{await gate.promise;return r;};const reference=await begin(f),result=view(await save(f,reference));assert.equal(result.state,'not-dispatched');assert.equal(f.calls.filter(x=>x.selector==='apply').length,0);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(x=>x.selector==='apply').length,0);
});
test('eight expired originals occupy safe slots without eviction and have no private status dispatch',async()=>{
 let now=0;const f=productFixture({now:()=>now});f.state.onApply=()=>{throw Error('lost');};for(let i=0;i<8;i++){const reference=await begin(f);await save(f,reference,{reader_enabled:{action:'set',value:i%2===0?false:true}});}now=1800000;
 const rows=view(await f.product.request({action:'retained'})).retained;assert.equal(rows.length,8);const reference=await begin(f);assert.equal(view(await save(f,reference)).state,'capacity');const calls=f.calls.length;for(const row of rows)assert.equal(view(await f.product.request({action:'status',...identity,reference:row.reference})).state,'unavailable');assert.equal(f.calls.length,calls);assert.deepEqual(view(await f.product.request({action:'retained'})).retained,rows);
});
