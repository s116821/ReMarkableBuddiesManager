import {createHash,randomUUID} from 'node:crypto';
import {OrdinaryExportHost} from '../../host/ordinary-export.mjs';
import {MaintenanceIO} from '../../host/maintenance-io.mjs';
import {EXPORT_CONFIG} from '../../host/ordinary-export-protocol.mjs';
export {tablet,defer} from './model-settings.mjs';
import {tablet} from './model-settings.mjs';
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const destination='/home/root/exports/SYNTHETIC_PRIVATE_😀\r\n ';
export const summary={format:1,manifests:0,objects:0,complete_media:true,configuration_included:false};
export function intent(operation,path){return {export_version:1,operation,config_path_sha256:hash('urn:remarkable-buddies:ordinary-export-config:v1:'+EXPORT_CONFIG),config_sha256:'a'.repeat(64),destination_path_sha256:hash('urn:remarkable-buddies:ordinary-export-path:v1:'+path),actor:'11111111-1111-4111-8111-111111111111',mode_sha256:'b'.repeat(64),base_generation:'22222222-2222-4222-8222-222222222222',base_history_sha256:'19bf4c537633f421ba1fcec5e6897e9a29a392d701b7fe2ecdce93c21ec1272b',configuration_snapshot_sha256:null,archive_sha256:'2d61ecb63ec1e95d63e178bad36e1a04131c04e586a00c829782f62c7daa1d61',complete_media:true};}
export const report=(operation,outcome,data=null,status='ok')=>({report_version:1,operation,status,outcome,disk_readback_verified:operation==='apply'&&status==='ok',runtime_activation:'unverified',data});
export const rawReply=r=>({contract_version:1,status:'observed',observation:structuredClone(tablet),export_raw:{status:'reported',stdout_base64:Buffer.from(JSON.stringify(r)+'\n').toString('base64')}});
export function exportFixture(options={}){
 const state={mode:'normal',calls:[],cancels:0,onPrepare:null,onApply:null,onStatus:null,hooks:0};const io=options.io??new MaintenanceIO();
 const observer={lastObservation:structuredClone(tablet),cancel(){state.cancels++;},async run(action,q){if(action!=='ordinary-export')throw Error('Unexpected fixture action');const body=JSON.parse(Buffer.from(q.input_base64,'base64'));state.calls.push({selector:q.selector,body});let r;
 if(q.selector==='prepare')r=report('prepare','prepared',{source:structuredClone(summary),intent:intent(body.operation,body.destination)});
 else if(q.selector==='apply')r=state.mode==='lost'?report('apply','unknown',null,'failed'):state.mode==='not-published'?report('apply','not-published',null,'failed'):report('apply','verified',{archive_sha256:body.intent.archive_sha256,inspection:structuredClone(summary)});
 else r=state.mode==='unresolved'?report('status','unresolved'):state.mode==='status-refused'?report('status','read-only',null,'unavailable'):report('status','desired-archive-observed',{archive_sha256:body.intent.archive_sha256,inspection:structuredClone(summary)});
 const hook={prepare:state.onPrepare,apply:state.onApply,status:state.onStatus}[q.selector];if(hook)r=await hook(r,body);return rawReply(r);
 }};
 const host=new OrdinaryExportHost({observer,io,beforeIO(){state.hooks++;options.beforeIO?.();},uuid:randomUUID,...options});return {host,observer,state,io};
}
