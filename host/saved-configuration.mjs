// Producer wire pinned by the central saved-configuration contract. No raw Config.
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const refuse=()=>{throw Error('Saved configuration response refused');};
const digest=v=>typeof v==='string'&&v.length===64&&!/[^a-f0-9]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
export const DEFAULT_FIELDS=Object.freeze({config_schema_version:1,model:false,base_url:false,model_credential:false,trigger_corner:null,log_level:null,debug_dump:null,'paths.data':true,'paths.cache':true,'paths.credentials':true,'memory.enabled':false,'memory.profile':false,'memory.selection':false,'sync.enabled':false,'sync.media':false,'sync.create_new':false,'sync.namespaces':Object.freeze([]),'sync.max_media_bytes':33554432,'sync.poll_seconds':60,'sync.batch_items':32,'sync.collection':false,'personalization.schema_version':1,'personalization.enabled':false,'personalization.text':false,'personalization.text_bytes':0});
export const FIELD_KEYS=Object.freeze(Object.keys(DEFAULT_FIELDS));
export const UNSUPPORTED_SETTINGS=Object.freeze(['reader-enablement','writer-enablement','retrieval-policy','research-policy','mem-destination','handwriting-settings']);
const presence=new Set(['model','base_url','model_credential','memory.profile','memory.selection','sync.collection']);
const nullable=new Set(['trigger_corner','log_level','debug_dump']);
const paths=['paths.data','paths.cache','paths.credentials'];
const booleans=new Set(['memory.enabled','sync.enabled','sync.media','sync.create_new','personalization.enabled','personalization.text']);
const namespaces=['conversation','export-association','handwriting','source','subject-memory'];
const ranges={'sync.max_media_bytes':[0,268435456],'sync.poll_seconds':[5,3600],'sync.batch_items':[1,128],'personalization.text_bytes':[0,16384]};
const statuses=['ok','unavailable','invalid-input','unsupported'];
export function parseSavedConfigurationRequest(v){
 if(keys(v)!=='boot_id,connection_id'||!digest(v.connection_id)||!uuid(v.boot_id)||bytes(v)>256)refuse();
 return v;
}
function fields(v){
 if(keys(v)!==[...FIELD_KEYS].sort().join())refuse();
 for(const name of FIELD_KEYS){
  const field=v[name];
  if(keys(field)!=='origin,value'||!['default','declared','declared-null'].includes(field.origin))refuse();
  const {origin,value}=field;
  if(origin==='default'&&JSON.stringify(value)!==JSON.stringify(DEFAULT_FIELDS[name]))refuse();
  if(presence.has(name)){
   if(typeof value!=='boolean'||value!==(origin==='declared'))refuse();
  }else if(nullable.has(name)){
   if(origin!=='declared'){if(value!==null)refuse();}
   else if(name==='debug_dump'){if(typeof value!=='boolean')refuse();}
   else if(!(name==='trigger_corner'?['UR','UL','LR','LL']:['off','error','warn','info','debug','trace']).includes(value))refuse();
  }else{
   if(origin==='declared-null')refuse();
   if(paths.includes(name)){if(value!==true)refuse();}
   else if(booleans.has(name)){if(typeof value!=='boolean')refuse();}
   else if(name==='sync.namespaces'){
    if(!Array.isArray(value)||value.length>5||!value.every((n,i)=>namespaces.includes(n)&&(i===0||value[i-1]<n)))refuse();
   }else if(Object.hasOwn(ranges,name)){
    const [min,max]=ranges[name];if(!Number.isSafeInteger(value)||value<min||value>max)refuse();
   }else if(value!==1)refuse();
  }
 }
 const value=name=>v[name].value;
 if(new Set(paths.map(name=>v[name].origin)).size!==1||v['personalization.text'].origin!==v['personalization.text_bytes'].origin||value('personalization.text')!==(value('personalization.text_bytes')>0))refuse();
 if((value('memory.enabled')||value('memory.selection'))&&!value('memory.profile')||value('sync.create_new')&&!value('sync.collection')||value('sync.enabled')&&(value('memory.selection')||value('memory.enabled')&&value('sync.namespaces').includes('subject-memory')))refuse();
 return Object.fromEntries(FIELD_KEYS.map(name=>[name,{origin:v[name].origin,value:Array.isArray(v[name].value)?[...v[name].value]:v[name].value}]));
}
function snapshot(s,raw){
 if(keys(s)!==(raw?'byte_basis,config_sha256,declared_roots_validated,fields,schema_version,unsupported,validation_basis':'byte_basis,declared_roots_validated,fields,schema_version,unsupported,validation_basis')||s.schema_version!==1||s.byte_basis!=='saved-file-bytes'||s.validation_basis!=='typed-values-only'||s.declared_roots_validated!==false||raw&&!digest(s.config_sha256)||JSON.stringify(s.unsupported)!==JSON.stringify(UNSUPPORTED_SETTINGS))refuse();
 return {schema_version:1,byte_basis:s.byte_basis,validation_basis:s.validation_basis,declared_roots_validated:false,fields:fields(s.fields),unsupported:[...UNSUPPORTED_SETTINGS]};
}
export function parseSavedConfigurationReport(v){
 if(!Number.isSafeInteger(v?.report_version)||v.report_version<1)refuse();
 if(v.report_version!==1)throw Error('Saved configuration report version unsupported');
 if(keys(v)!=='operation,report_version,runtime_activation,snapshot,status'||v.operation!=='inspect'||v.runtime_activation!=='unverified'||!statuses.includes(v.status)||bytes(v)+1>131072)refuse();
 if(v.status!=='ok'){if(v.snapshot!==null)refuse();return {status:v.status,runtime_activation:'unverified',snapshot:null};}
 return {status:'ok',runtime_activation:'unverified',snapshot:snapshot(v.snapshot,true)};
}
export function parseSavedConfigurationView(v){
 if(keys(v)!=='runtime_activation,snapshot,status'||v.runtime_activation!=='unverified'||!statuses.includes(v.status)||bytes(v)>32768)refuse();
 if(v.status!=='ok'){if(v.snapshot!==null)refuse();}
 else snapshot(v.snapshot,false);
 return v;
}
function observation(v,request,validate){
 parseSavedConfigurationRequest(request);
 if(keys(v)!=='contract_version,observation,saved_configuration,status')refuse();
 validate({contract_version:v.contract_version,status:v.status,observation:v.observation});
 if(v.status==='observed'&&(v.observation.connection_id!==request.connection_id||v.observation.boot_id!==request.boot_id))refuse();
}
export function parseSavedConfigurationResult(v,request,validate){
 observation(v,request,validate);if(bytes(v)>32768)refuse();
 const q=v.saved_configuration;
 if(keys(q)!=='status,view'||!['reported','unsupported','unavailable'].includes(q.status))refuse();
 if(q.status==='reported'){if(v.status!=='observed')refuse();parseSavedConfigurationView(q.view);}
 else if(q.view!==null)refuse();
 return v;
}
export function reduceSavedConfigurationResult(v,request,validate){
 observation(v,request,validate);if(bytes(v)>139264)refuse();
 const q=v.saved_configuration;
 if(keys(q)!=='report,status'||!['reported','unsupported','unavailable'].includes(q.status))refuse();
 let status=q.status,view=null;
 if(status==='reported'){
  if(v.status!=='observed')refuse();
  try{view=parseSavedConfigurationReport(q.report);}catch(error){if(error.message!=='Saved configuration report version unsupported')throw error;status='unsupported';}
 }else if(q.report!==null)refuse();
 return parseSavedConfigurationResult({contract_version:v.contract_version,status:v.status,observation:v.observation,saved_configuration:{status,view}},request,validate);
}
