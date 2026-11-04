import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalModeChoiceController} from '../src/local-mode-choice.ts';
import {localModeFixture,tablet} from './fixtures/local-mode-choice.mjs';
const open=options=>{const f=localModeFixture(options);return {...f,fixture:f,controller:new LocalModeChoiceController(()=>{}),adapter:{localModeChoice:q=>f.host.request(q)}};};
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('explicit review and once-only confirmation show historical receipt independently of saved metadata',async()=>{
 const f=open();await f.controller.begin(f.adapter,tablet,async()=>true);assert.equal(f.controller.state.view.state,'ready');await f.controller.choose(f.adapter,tablet);assert.equal(f.controller.state.view.state,'acknowledged');assert.equal(f.controller.state.view.receipt.kind,'local-only');await f.controller.choose(f.adapter,tablet);assert.equal(f.fixture.chooseCount,1);f.controller.clear();
});
test('unknown choice survives clear and inspect refresh without replay or invented reconciliation',async()=>{
 const f=open({raw:'partial'});await f.controller.begin(f.adapter,tablet,async()=>true);await f.controller.choose(f.adapter,tablet);assert.match(f.controller.state.status,/not confirmed/);assert.equal(f.controller.state.retained[0].state,'unknown');f.controller.clear();
 const r=f.controller.state.retained[0];await f.controller.refresh(f.adapter,tablet,r,async()=>true);assert.equal(f.controller.state.view.state,'unknown');assert.equal(f.controller.state.view.current.kind,'local-only');assert.match(f.controller.state.status,/earlier save is still unconfirmed/);assert.equal(f.fixture.chooseCount,1);assert.equal(f.calls.at(-1).selector,'inspect');f.controller.clear();
});
test('queued observation pause cannot dispatch after clear or failed quiescence',async()=>{
 const f=open(),gate=defer(),pending=f.controller.begin(f.adapter,tablet,()=>gate.promise);f.controller.clear();gate.resolve(true);await pending;assert.equal(f.calls.length,0);
 await f.controller.begin(f.adapter,tablet,async()=>false);assert.equal(f.controller.state.busy,false);assert.equal(f.calls.length,0);f.controller.clear();
});
test('cancelled delayed choice retains unknown and late success cannot repopulate UI',async()=>{
 const f=open({delay:true});await f.controller.begin(f.adapter,tablet,async()=>true);const pending=f.controller.choose(f.adapter,tablet);await f.controller.stop(f.adapter,async()=>{});assert.match(f.controller.state.status,/not confirmed/);f.fixture.release();await pending;assert.equal(f.controller.state.view,null);assert.equal(f.controller.state.retained[0].state,'unknown');f.controller.clear();
});
test('stopping retained local diagnostics never cancels any invocation',async()=>{
 const f=open({raw:'partial'});await f.controller.begin(f.adapter,tablet,async()=>true);await f.controller.choose(f.adapter,tablet);const gate=defer(),requests=[];
 const adapter={localModeChoice:q=>{requests.push(q.action);return q.action==='retained'?gate.promise:f.host.request(q);}};
 const pending=f.controller.retained(adapter);let cancellations=0;await f.controller.stop(adapter,async()=>{cancellations++;});assert.deepEqual(requests,['retained']);assert.equal(cancellations,0);gate.resolve(await f.host.request({action:'retained'}));await pending;assert.equal(f.controller.state.retained[0].state,'unknown');f.controller.clear();
});
test('duplicate clicks during a pending choice cannot submit twice',async()=>{
 const f=open({delay:true});await f.controller.begin(f.adapter,tablet,async()=>true);const pending=f.controller.choose(f.adapter,tablet);await f.controller.choose(f.adapter,tablet);assert.equal(f.fixture.chooseCount,1);f.fixture.release();await pending;assert.equal(f.controller.state.view.state,'acknowledged');f.controller.clear();
});
