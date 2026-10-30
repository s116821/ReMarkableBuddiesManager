import {localModeFixture as setup} from './fixtures/local-mode-choice.mjs';
import {LocalModeChoiceHost} from '../host/local-mode-choice.mjs';
import {MaintenanceIO} from '../host/maintenance-io.mjs';
import {productFixture} from './fixtures/product-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseLocalModeRequest,parseLocalModeOriginal,parseLocalModeReport,parseLocalModeResult} from '../host/local-mode-choice-protocol.mjs';
import {validateResult} from '../host/observation-protocol.mjs';
import {tablet} from './fixtures/memory-inspection.mjs';
const fixtures=JSON.parse(await readFile(new URL('./fixtures/local-mode-choice-reports.json',import.meta.url)));
const reports=Object.fromEntries(fixtures.map(x=>[x.name,JSON.parse(x.report_utf8)]));
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity=s=>({connection_id:s.connection_id,boot_id:s.boot_id});
const originalFor=r=>({operation:r.operation,expected:{actor:reports['inspect-unconfigured'].data.current_snapshot.token.actor,sha256:r.expected},choice:{kind:'local-only'}});
test('all twelve sanitized source-derived fixtures retain their declared report contract',()=>{
 for(const {name,report_utf8,classification} of fixtures){
  assert.match(classification,/synthetic/);assert.equal(report_utf8.endsWith('\n'),true);const r=reports[name];
  const context=r.data?.receipt?{original:originalFor(r.data.receipt),request_sha256:r.data.receipt.request_sha256}:null;
  const out=parseLocalModeReport(r,r.operation,context);assert.equal(out.status,r.status);
 }
});
test('strict original and public requests refuse renderer-supplied authority',()=>{
 const original=originalFor(reports['choose-local-current'].data.receipt);assert.deepEqual(parseLocalModeOriginal(original),original);
 for(const mutate of [p=>{p.path='/tmp/file';},p=>{p.choice.extra=true;},p=>{p.choice.kind='shared-group';},p=>{p.expected.actor='00000000-0000-0000-0000-000000000000';},p=>{p.operation='bad';}]){const p=structuredClone(original);mutate(p);assert.throws(()=>parseLocalModeOriginal(p));}
 const q={action:'begin',...identity(tablet)};assert.equal(parseLocalModeRequest(q),q);
 for(const p of [{...q,operation:original.operation},{...q,choice:{kind:'local-only'}},{...q,reference:hash('ref')},{action:'choose',...identity(tablet)}, {action:'status',...identity(tablet),reference:hash('ref')}])assert.throws(()=>parseLocalModeRequest(p));
});
test('receipts require exact original identity/fingerprint and truthful epoch classification',()=>{
 const base=reports['choose-local-current'],context={original:originalFor(base.data.receipt),request_sha256:base.data.receipt.request_sha256};
 for(const mutate of [r=>{r.data.receipt.operation='11111111-1111-4111-8111-111111111111';},r=>{r.data.receipt.expected=hash('other');},r=>{r.data.receipt.request_sha256=hash('other');},r=>{r.data.receipt.mode.extra=true;},r=>{r.data.receipt_status='historical';},r=>{r.activation_performed=true;},r=>{r.incomplete=true;},r=>{r.report_version=2;},r=>{r.extra=true;}]){const r=structuredClone(base);mutate(r);assert.throws(()=>parseLocalModeReport(r,'choose',context));}
 const historical=reports['original-historical-retry'];assert.equal(parseLocalModeReport(historical,'choose',{original:originalFor(historical.data.receipt),request_sha256:historical.data.receipt.request_sha256}).receipt.historical,true);
});
test('one deliberate choice consumes its reference and returns only reduced receipt metadata',async()=>{
 const s=setup(),ready=await s.begin(),reference=ready.local_mode_choice.reference;
 assert.equal(ready.local_mode_choice.state,'ready');assert.equal(ready.local_mode_choice.current.kind,'unconfigured');
 const saved=await s.request('choose',reference);assert.equal(saved.local_mode_choice.state,'acknowledged');assert.equal(saved.local_mode_choice.receipt.historical,false);
 await s.request('choose',reference);assert.equal(s.chooseCount,1);
 const text=JSON.stringify([ready,saved]);for(const field of ['actor','sha256','operation','expected','request_sha256','token','binding_sha256','root_id'])assert.equal(text.includes('"'+field+'"'),false);
 assert.throws(()=>s.host.assertCurrent(ready));
});
test('unknown original blocks a new choice and current inspect does not reconcile it',async()=>{
 const s=setup({report:r=>({...r,status:'failed',incomplete:true,data:{...r.data,receipt:null,receipt_status:null}})}),ready=await s.begin(),ref=ready.local_mode_choice.reference;
 const lost=await s.request('choose',ref);assert.equal(lost.local_mode_choice.state,'unknown');
 const again=await s.begin();assert.equal(again.local_mode_choice.reference,ref);assert.equal(again.local_mode_choice.state,'unknown');assert.equal(s.calls.length,2);
 const refreshed=await s.request('refresh',ref);assert.equal(refreshed.local_mode_choice.state,'unknown');assert.equal(refreshed.local_mode_choice.current.kind,'local-only');assert.equal(refreshed.local_mode_choice.receipt,null);assert.equal(s.calls.at(-1).selector,'inspect');
 s.host.invalidate();const retained=await s.host.request({action:'retained'});assert.equal(retained.local_mode_choice.retained[0].state,'unknown');await s.request('choose',ref);assert.equal(s.chooseCount,1);
});
test('incomplete unsupported, failed, partial, duplicate and mismatched output stay unknown',async()=>{
 const cases=[{report:r=>({...r,status:'unsupported',incomplete:true,data:null})},{report:r=>({...r,status:'failed',incomplete:true,data:null})},{raw:'{"report_version":1}\n'},{raw:'{"report_version":1,"report_version":1}\n'},{raw:'partial'},{report:r=>{r.data.receipt.request_sha256=hash('wrong');return r;}}];
 for(const option of cases){const s=setup(option),ready=await s.begin();assert.equal((await s.request('choose',ready.local_mode_choice.reference)).local_mode_choice.state,'unknown');assert.equal(s.chooseCount,1);}
});
test('only complete known pre-mutation refusals close as refused',async()=>{
 for(const status of ['busy','conflict','invalid-input','unsupported']){const s=setup({report:r=>({...r,status,incomplete:false,data:null})}),ready=await s.begin();assert.equal((await s.request('choose',ready.local_mode_choice.reference)).local_mode_choice.state,'refused');}
});
test('expiry and cancellation before dispatch cannot invoke choose',async()=>{
 const s=setup(),ready=await s.begin();s.setClock(120000);await s.request('choose',ready.local_mode_choice.reference);assert.equal(s.chooseCount,0);
 const next=await s.begin();await s.host.request({action:'cancel',reference:next.local_mode_choice.reference});await s.request('choose',next.local_mode_choice.reference);assert.equal(s.chooseCount,0);
});
test('delayed successful output after cancellation cannot overwrite unknown or release another owner',async()=>{
 const s=setup({delay:true}),ready=await s.begin(),ref=ready.local_mode_choice.reference;
 const pending=s.request('choose',ref);assert.equal(s.chooseCount,1);
 await s.host.request({action:'cancel',reference:ref});const other=s.io.acquire('other','other','other');assert.ok(other);s.release();
 assert.equal((await pending).local_mode_choice.state,'unknown');assert.equal(s.io.owns(other),true);
});
test('Busy admission leaves an unrelated owner and a ready reference intact',async()=>{
 const s=setup(),ready=await s.begin(),ref=ready.local_mode_choice.reference,other=s.io.acquire('other','other','other');
 assert.equal((await s.request('choose',ref)).local_mode_choice.state,'busy');assert.equal(s.io.owns(other),true);assert.equal(s.chooseCount,0);s.host.assertCurrent(ready);s.io.release(other);
 assert.equal((await s.request('choose',ref)).local_mode_choice.state,'acknowledged');
});
test('same-ID invalidation rejects stale preview and foreign boot cannot use its reference',async()=>{
 const s=setup(),ready=await s.begin(),ref=ready.local_mode_choice.reference;s.host.invalidate();assert.throws(()=>s.host.assertCurrent(ready));await s.request('choose',ref);assert.equal(s.chooseCount,0);
 const next=await s.begin();s.observer.lastObservation.boot_id='33333333-3333-4333-8333-333333333333';await s.request('choose',next.local_mode_choice.reference);assert.equal(s.chooseCount,0);
});
test('capacity retains all eight uncertain originals without eviction',async()=>{
 const s=setup({raw:'partial'});
 for(let i=0;i<8;i++){s.observer.lastObservation.connection_id=hash('target'+i);const r=await s.begin();await s.request('choose',r.local_mode_choice.reference);}
 s.observer.lastObservation.connection_id=hash('ninth');assert.equal((await s.begin()).local_mode_choice.state,'capacity');assert.equal((await s.host.request({action:'retained'})).local_mode_choice.retained.length,8);assert.equal(s.chooseCount,8);
});
test('public validation rejects injected authority and current observation without session proof',async()=>{
 const s=setup(),ready=await s.begin(),q={action:'begin',...identity(tablet)};
 const leaked=structuredClone(ready);leaked.local_mode_choice.token={actor:'private'};assert.throws(()=>parseLocalModeResult(leaked,q,validateResult));
 const foreign=structuredClone(ready);foreign.observation.boot_id='33333333-3333-4333-8333-333333333333';assert.throws(()=>parseLocalModeResult(foreign,q,validateResult));
});
test('host budget bounds a never-resolving observer without retaining a read or another owner',async()=>{
 const io=new MaintenanceIO();let cancelled=0;const observer={lastObservation:structuredClone(tablet),run:()=>new Promise(()=>{}),cancel(){cancelled++;}};
 const host=new LocalModeChoiceHost({observer,io,budgetMs:25});const started=performance.now(),v=await host.request({action:'begin',...identity(tablet)});
 assert.equal(v.local_mode_choice.state,'invalidated');assert.ok(performance.now()-started<1000);assert.equal(cancelled,1);assert.equal(v.local_mode_choice.retained.length,0);const other=io.acquire('other','other','other');assert.ok(other);assert.equal(io.owns(other),true);
});
test('actual product/local coordinators share Busy admission and invalidate only when a peer read is admitted',async()=>{
 const io=new MaintenanceIO();let product;
 const local=setup({io,delay:true,beforeIO:()=>product?.invalidate()}),peer=productFixture({io,beforeIO:()=>local.host.invalidate()});product=peer.product;
 const ready=await local.begin(),ref=ready.local_mode_choice.reference,pending=local.request('choose',ref),before=peer.calls.length;
 assert.equal((await product.request({action:'begin',...identity(tablet)})).product_settings.state,'busy');assert.equal(peer.calls.length,before);
 assert.equal((await product.request({action:'retained'})).product_settings.state,'none');local.release();assert.equal((await pending).local_mode_choice.state,'acknowledged');
 const second=await local.begin();assert.equal((await product.request({action:'begin',...identity(tablet)})).product_settings.state,'ready');assert.throws(()=>local.host.assertCurrent(second));
 const beforeChoose=local.chooseCount;await local.request('choose',second.local_mode_choice.reference);assert.equal(local.chooseCount,beforeChoose);
});
test('actual product ready editor is invalidated by admitted Local-only review',async()=>{
 const io=new MaintenanceIO();let product;const local=setup({io,beforeIO:()=>product?.invalidate()}),peer=productFixture({io,beforeIO:()=>local.host.invalidate()});product=peer.product;
 const ready=await product.request({action:'begin',...identity(tablet)});assert.equal(ready.product_settings.state,'ready');await local.begin();assert.throws(()=>product.assertCurrent(ready));
});
