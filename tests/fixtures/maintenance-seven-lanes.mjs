import assert from 'node:assert/strict';
import {identity} from './model-settings.mjs';
import {prepareRequest} from './memory-forget.mjs';
import {destination} from './ordinary-export.mjs';

// Exercise actual factory coordinators through the public host boundary.
export const lanes={
 credentialReference:{key:'credential_reference',begin:()=>({action:'begin',...identity}),change:{action:'set',value:'SYNTHETIC_PRIVATE'}},
 memorySettings:{key:'memory_settings',begin:()=>({action:'begin',...identity}),changes:{enabled:{action:'set',value:true}}},
 researchSettings:{key:'research_settings',begin:()=>({action:'begin',...identity}),changes:{research_policy:{action:'set',value:'disabled'}}},
 modelSettings:{key:'model_settings',begin:()=>({action:'begin',...identity}),changes:{model:{action:'set',value:'SYNTHETIC'}}},
 basicSettings:{key:'basic_settings',begin:()=>({action:'begin',...identity}),changes:{debug_dump:{action:'set',value:true}}},
 memoryForget:{key:'forget',begin:()=>prepareRequest()},
 ordinaryExport:{key:'ordinary_export',begin:()=>({action:'prepare',...identity,destination})},
};
export async function verifyFortyTwoDirections(request){
 let pairs=0;
 for(const [old,a] of Object.entries(lanes))for(const [newer,b] of Object.entries(lanes)){
  if(old===newer)continue;
  const ready=(await request(old,a.begin()))[a.key];assert.ok(ready.reference,old);
  assert.ok((await request(newer,b.begin()))[b.key].reference,newer);
  const q=a.change?{action:'save',...identity,reference:ready.reference,change:a.change}:a.changes?{action:'save',...identity,reference:ready.reference,changes:a.changes}:old==='memoryForget'?{action:'confirm',reference:ready.reference}:{action:'confirm',...identity,reference:ready.reference};
  const result=(await request(old,q))[a.key];assert.ok(['invalidated','unavailable','not-dispatched'].includes(result.state),`${old} after ${newer}: ${result.state}`);pairs++;
 }
 assert.equal(pairs,42);return pairs;
}
