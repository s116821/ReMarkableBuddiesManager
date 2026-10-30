import test from 'node:test';import assert from 'node:assert/strict';import {completeForgetReload,completeForgetPrepare} from './fixtures/forget-reload-completion.mjs';
const proof=terminal=>({events:[{event:'startup-status-request'},{event:'startup-status-headers',status:200},terminal],readerEvents:['headers','chunk','eof','cancel','cancel-complete'],unknownRendered:true});
test('reload completion requires successful renderer consumption and exact restored state for either terminal event',()=>{
 assert.equal(completeForgetReload(proof({event:'startup-status-finished'})),true);assert.equal(completeForgetReload(proof({event:'startup-status-failed',reason:'net::ERR_ABORTED'})),true);
 const multiple=proof({event:'startup-status-finished'});multiple.readerEvents.splice(1,0,'chunk');assert.equal(completeForgetReload(multiple),true);
 for(const mutate of [p=>p.readerEvents.splice(2,1),p=>p.readerEvents.pop(),p=>p.readerEvents.splice(1,1),p=>p.readerEvents.splice(2,0,'read-failed'),p=>{p.unknownRendered=false;},p=>{p.events[1].status=503;},p=>p.events.push({event:'startup-status-request'}),p=>p.events.push({event:'startup-status-finished'}),p=>{p.events[2].reason='net::ERR_CONNECTION_RESET';},p=>p.readerEvents.splice(3,0,'chunk')]){const p=proof({event:'startup-status-failed',reason:'net::ERR_ABORTED'});mutate(p);assert.equal(completeForgetReload(p),false);}
});
test('initial preparation requires the entire reader lifecycle and every original preview check for either terminal',()=>{
 const initial=terminal=>({events:[{event:'initial-prepare-request'},{event:'initial-prepare-headers',status:200},terminal],readerEvents:['headers','chunk','eof','cancel','cancel-complete'],previewChecks:{unicode:true,publication:true,observed:true,asserted:true}});
 for(const terminal of [{event:'initial-prepare-finished'},{event:'initial-prepare-failed',reason:'net::ERR_ABORTED'}]){
  assert.equal(completeForgetPrepare(initial(terminal)),true);
  const multiple=initial(terminal);multiple.readerEvents.splice(1,0,'chunk');assert.equal(completeForgetPrepare(multiple),true);
  for(const key of ['unicode','publication','observed','asserted'])for(const value of [false,undefined,'true']){const p=initial(terminal);p.previewChecks[key]=value;assert.equal(completeForgetPrepare(p),false);}
  for(const mutate of [p=>p.readerEvents.splice(2,1),p=>p.readerEvents.pop(),p=>p.readerEvents.splice(1,1),p=>p.readerEvents.splice(2,0,'read-failed'),p=>p.readerEvents.splice(3,0,'chunk'),p=>{p.events[1].status=503;},p=>p.events.push({event:'initial-prepare-request'}),p=>p.events.push({event:'initial-prepare-finished'}),p=>p.events.pop(),p=>p.events.splice(1,1),p=>{p.previewChecks=null;}]){const p=initial(terminal);mutate(p);assert.equal(completeForgetPrepare(p),false);}
 }
 for(const reason of ['net::ERR_CONNECTION_RESET','net::ERR_FAILED','unknown'])assert.equal(completeForgetPrepare(initial({event:'initial-prepare-failed',reason})),false);
 assert.equal(completeForgetPrepare({...initial({event:'initial-prepare-finished'}),events:proof({event:'startup-status-finished'}).events}),false);
});
