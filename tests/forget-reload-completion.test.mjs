import test from 'node:test';import assert from 'node:assert/strict';import {completeForgetReload} from './fixtures/forget-reload-completion.mjs';
const proof=terminal=>({events:[{event:'startup-status-request'},{event:'startup-status-headers',status:200},terminal],readerEvents:['headers','chunk','eof','cancel','cancel-complete'],unknownRendered:true});
test('reload completion requires successful renderer consumption and exact restored state for either terminal event',()=>{
 assert.equal(completeForgetReload(proof({event:'startup-status-finished'})),true);assert.equal(completeForgetReload(proof({event:'startup-status-failed',reason:'net::ERR_ABORTED'})),true);
 const multiple=proof({event:'startup-status-finished'});multiple.readerEvents.splice(1,0,'chunk');assert.equal(completeForgetReload(multiple),true);
 for(const mutate of [p=>p.readerEvents.splice(2,1),p=>p.readerEvents.pop(),p=>p.readerEvents.splice(1,1),p=>p.readerEvents.splice(2,0,'read-failed'),p=>{p.unknownRendered=false;},p=>{p.events[1].status=503;},p=>p.events.push({event:'startup-status-request'}),p=>p.events.push({event:'startup-status-finished'}),p=>{p.events[2].reason='net::ERR_CONNECTION_RESET';},p=>p.readerEvents.splice(3,0,'chunk')]){const p=proof({event:'startup-status-failed',reason:'net::ERR_ABORTED'});mutate(p);assert.equal(completeForgetReload(p),false);}
});
