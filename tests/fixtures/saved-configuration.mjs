// Original actual CLI report corpus; transport/observation functions below are synthetic.
import { readFileSync } from 'node:fs';
import { tablet } from './memory-inspection.mjs';
export { tablet };
export const corpus=JSON.parse(readFileSync(new URL('./saved-configuration-4bc7eb0-corpus.json',import.meta.url),'utf8'));
export const request=()=>({connection_id:tablet.connection_id,boot_id:tablet.boot_id});
export const specimen=name=>corpus.cases.find(c=>c.name===name);
export const report=(name='default')=>JSON.parse(specimen(name).stdout_utf8);
export const privateReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),saved_configuration:{status:'reported',report:r}});
export const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
