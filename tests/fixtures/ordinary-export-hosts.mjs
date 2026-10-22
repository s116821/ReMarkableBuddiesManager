import {modelFixture,tablet,defer} from './model-settings.mjs';
import {exportFixture} from './ordinary-export.mjs';
export {tablet};
export function hostFixture(){
 const f=modelFixture(),e=exportFixture(),run=f.observer.run,pending=new Map(),packets=[];let observations=0;const observe=f.observer.observe;f.observer.observe=async function(){observations++;return observe.call(this);};
 for(const [name,phase] of [['onPrepare','prepare'],['onApply','apply'],['onStatus','status']])e.state[name]=async(r,b)=>{if(e.state.mode==='delay-'+phase){const id=b.operation??b.intent.operation,gate=defer();pending.set(id,gate.resolve);await gate.promise;pending.delete(id);}return r;};
 f.observer.run=async function(action,q){if(action!=='ordinary-export')return run.call(this,action,q);packets.push({selector:q.selector,base64:q.input_base64});return e.observer.run.call(this,action,q);};
 const snapshot=()=>({observations,calls:e.state.calls.length,applies:e.state.calls.filter(x=>x.selector==='apply').length,statuses:e.state.calls.filter(x=>x.selector==='status').length,lastDestination:e.state.calls.findLast(x=>x.selector==='apply')?.body.destination??null,applyPacket:packets.findLast(x=>x.selector==='apply')?.base64??null,statusPacket:packets.findLast(x=>x.selector==='status')?.base64??null});
 return {f,e,pending,packets,snapshot};
}
