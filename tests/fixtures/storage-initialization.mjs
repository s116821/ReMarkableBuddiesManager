// Synthetic initialization DTOs from accepted snapshot fields; not captured producer output.
import {readFileSync} from 'node:fs';
import {generation4Fixture,tablet,identity} from './owned-data-v3.mjs';
export {tablet,identity};
const rows=JSON.parse(readFileSync(new URL('./local-mode-choice-reports.json',import.meta.url)));
export const initializationReport=(operation='initialize',kind='unconfigured')=>{const row=rows.find(r=>r.name===(kind==='unconfigured'?'inspect-unconfigured':'choose-local-current')),r=JSON.parse(row.report_utf8);r.operation=operation;if(kind==='isolated-backup')r.data.current_snapshot.mode={kind,backup:invocation(90),binding_sha256:'c'.repeat(64)};if(kind==='shared-group')r.data.current_snapshot.mode={kind,group:invocation(91),binding_sha256:'d'.repeat(64),root_id:'PRIVATE_ROOT_CANARY'};r.data.receipt=null;r.data.receipt_status=null;return r;};
export const invocation=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
export function initializationFixture(){const f=generation4Fixture(),previous=f.observer.run,state={calls:[],all:0,gate:null,raw:null,onRun:null,kind:'unconfigured'};f.initialization=state;
 f.observer.run=async function(action,q){state.all++;if(state.gate){state.gate.entered=true;await state.gate.promise;}if(action!=='storage-initialization')return previous.call(this,action,q);state.calls.push(structuredClone(q));if(state.onRun)await state.onRun(q);const raw=state.raw??JSON.stringify(initializationReport(q.selector,state.kind))+'\n';return {contract_version:1,status:'observed',observation:structuredClone(this.lastObservation),storage_initialization_raw:{status:'reported',stdout_base64:Buffer.from(raw).toString('base64')}};};return f;}
