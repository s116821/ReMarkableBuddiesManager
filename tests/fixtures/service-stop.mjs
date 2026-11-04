// Synthetic DTOs only. Real factories always use the empty production registry.
import {initializationFixture} from './storage-initialization.mjs';
import {emptyServiceStopRaw} from '../../host/service-stop-private.mjs';
export {identity,tablet,invocation,defer} from './storage-initialization.mjs';
export function serviceStopFixture(){const f=initializationFixture(),previous=f.observer.run;f.stop={calls:[],raw:null,onRun:null};f.observer.run=async function(action,q){if(action!=='service-stop')return previous.call(this,action,q);f.initialization.all++;if(f.initialization.gate){f.initialization.gate.entered=true;await f.initialization.gate.promise;}f.stop.calls.push(structuredClone(q));if(f.stop.onRun)await f.stop.onRun(q);const raw=emptyServiceStopRaw(q.selector,null);if(q.selector==='stop')raw.command='request-accepted';return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),service_stop_raw:f.stop.raw??raw};};return f;}
