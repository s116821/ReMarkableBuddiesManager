import {createHash} from 'node:crypto';
import {matchesCandidateStopProfile,ORDINARY_STOP_EXEC_START,ORDINARY_STOP_ALIAS_TARGET} from './service-stop-profiles.mjs';
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('./service-stop-properties.json',import.meta.url),'utf8'));
const vendor=JSON.parse(readFileSync(new URL('./service-stop-vendor-policy.json',import.meta.url),'utf8'));
const fail=()=>{throw Error('Service stop facts refused');};
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const exact=(v,k)=>{if(keys(v)!==[...k].sort().join())fail();};
const ascii=(v,max=4096)=>typeof v==='string'&&v.length<=max&&/^[\x20-\x7e]*$/.test(v);
const decimal=(v,bits=64)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<(1n<<BigInt(bits));
const reasons=[null,'busy','unsupported','unavailable','invalid-response','cancelled','expired','session-changed','capacity','lifecycle-unqualified'];
const evidence=['buddy','helper','stock','process','platform','artifacts','recovery_profile_base64','lease_base64','lease_observation','configuration','companion','companion_group','vendor_policy'];
export const SERVICE_STOP_COMMAND='/bin/systemctl --system --no-pager --no-ask-password --no-block --job-mode=fail stop -- reader-buddy.service';
export function emptyServiceStopRaw(selector,reason='lifecycle-unqualified'){
 return {selector,command:'not-submitted',reason,buddy:null,helper:null,stock:null,process:null,platform:null,artifacts:null,recovery_profile_base64:null,lease_base64:null,lease_observation:'not-read',configuration:{read:'not-read',effective_mode:'unverified'},companion:null,companion_group:null,vendor_policy:null};
}
function jsonRecord(text,limit){
 if(typeof text!=='string'||Buffer.byteLength(text)>limit||text.charCodeAt(0)===0xfeff)fail();strictJson(Buffer.from(text));
 return JSON.parse(text,(_key,value,context)=>{if(typeof value==='number'){if(!/^(0|[1-9][0-9]*)$/.test(context.source))fail();return BigInt(context.source);}return value;});
}
function record(value){
 if(value===null)return null;
 if(typeof value!=='string'||value.length>43692)fail();const b=Buffer.from(value,'base64');
 try{if(b.length>32768||b.toString('base64')!==value)fail();return jsonRecord(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b),32768);}finally{b.fill(0);}
}
const u=(v,bits=64)=>typeof v==='bigint'&&v>=0n&&v<(1n<<BigInt(bits));
function hashArray(v){if(!Array.isArray(v)||v.length!==32||!v.every(x=>u(x,8))||v.every(x=>x===0n))fail();}
function recordProcess(v){exact(v,['pid','start_ticks']);if(!u(v.pid,32)||v.pid<=1n||!u(v.start_ticks)||v.start_ticks===0n)fail();}
function fileIdentity(v,kind=null){exact(v,['device','inode','uid','mode']);if(!u(v.device)||v.device===0n||!u(v.inode)||v.inode===0n||!u(v.uid,32)||!u(v.mode,32))fail();if(kind!==null&&((v.mode&0o170000n)!==kind||(v.mode&~(0o170000n|0o7777n))!==0n))fail();}
function recoveryProfile(v){
 if(v===null)return;
 const hashes=['native_profile_sha256','adapter_sha256','app_sha256','buddy_unit_sha256','helper_unit_sha256','stock_executable_sha256','stock_unit_sha256','stock_dropin_sha256'];
 exact(v,['version','companion','source_mode','firmware','kernel',...hashes,'buddy_policy','helper_policy','stock_policy']);if(v.version!==6n||v.companion!=='rm2-3.28.0.172-v1'||v.source_mode!=='resident-installed-output-v1'||v.firmware!=='3.28.0.172'||v.kernel!=='5.4.70-v1.6.3-rm11x')fail();
 for(const k of hashes)hashArray(v[k]);for(const k of ['buddy_policy','helper_policy','stock_policy']){exact(v[k],catalog.policy);for(const x of Object.values(v[k]))if(!ascii(x))fail();}
}
function groupRecord(g,unit){
 exact(g,['mount_path','unit','context','group','parent']);if(g.mount_path!=='/sys/fs/cgroup/unified'||g.unit!==unit)fail();fileIdentity(g.group,0o040000n);recordProcess(g.parent);
 exact(g.context,['boot','mount_namespace','cgroup_namespace','mount_record','mount','slice']);if(!basicUuid(g.context.boot)||!ascii(g.context.mount_record,4096))fail();for(const k of ['mount_namespace','cgroup_namespace'])fileIdentity(g.context[k],0o100000n);for(const k of ['mount','slice'])fileIdentity(g.context[k],0o040000n);
 const c=g.context;if(g.group.device!==c.mount.device||c.slice.device!==c.mount.device||new Set([g.group.inode,c.slice.inode,c.mount.inode]).size!==3)fail();const parts=c.mount_record.split(' - ');if(parts.length!==2)fail();const fields=parts[0].trim().split(/\s+/),tail=parts[1].trim().split(/\s+/);if(fields.length<6||!decimal(fields[0])||!decimal(fields[1])||fields[3]!=='/'||fields[4]!==g.mount_path||tail.length!==3||tail[0]!=='cgroup2')fail();
}
function stateFields(s){
 exact(s,catalog.state);for(const x of Object.values(s))if(!ascii(x))fail();
 for(const k of ['MainPID','ControlPID','ExecMainPID'])if(!decimal(s[k],32))fail();
 if(!decimal(s.ExecMainStartTimestampMonotonic)||!['reader-buddy.service','reader-buddy-stock-recovery.service','xochitl.service','rm-sync.service'].includes(s.Id))fail();
 if(s.InvocationID!==''&&(!/^[a-f0-9]{32}$/.test(s.InvocationID)||/^0+$/.test(s.InvocationID)))fail();
 const clear={ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlPID:'0',ExecMainPID:'0',ExecMainStartTimestampMonotonic:'0',Job:''};
 if(s.Id!=='rm-sync.service'||s.ControlGroup!=='/system.slice/rm-sync.service')clear.ControlGroup='';
 if(s.InvocationID===''&&!Object.entries(clear).every(([k,x])=>s[k]===x))fail();
}
export function parseCompanionBaseline(text){
 const v=jsonRecord(text,65536);exact(v,['version','snapshot','group']);if(v.version!==1n||typeof v.snapshot!=='string'||Buffer.byteLength(v.snapshot)>16384)fail();
 groupRecord(v.group,'rm-sync.service');const fields={};const lines=v.snapshot.split('\n');if(lines.at(-1)==='')lines.pop();
 for(const line of lines){const i=line.indexOf('='),key=line.slice(0,i),value=line.slice(i+1);if(i<1||Object.hasOwn(fields,key)||!ascii(value))fail();fields[key]=value;}
 exact(fields,[...catalog.state,...catalog.policy]);const s=Object.fromEntries(catalog.state.map(k=>[k,fields[k]])),p=Object.fromEntries(catalog.policy.map(k=>[k,fields[k]]));stateFields(s);
 if(s.Id!=='rm-sync.service'||s.LoadState!=='loaded'||s.ActiveState!=='active'||s.SubState!=='running'||s.ControlPID!=='0'||s.Job!==''||s.MainPID!==s.ExecMainPID||BigInt(s.MainPID)<=1n||s.MainPID!==String(v.group.parent.pid)||BigInt(s.ExecMainStartTimestampMonotonic)===0n||s.ControlGroup!=='/system.slice/rm-sync.service'||p.WatchdogUSec!=='0')fail();
 return {group:v.group,state:s,policy:p};
}
function sameRecord(a,b){return JSON.stringify(canonical(a),(_k,v)=>typeof v==='bigint'?v.toString():v)===JSON.stringify(canonical(b),(_k,v)=>typeof v==='bigint'?v.toString():v);}
function leaseRecord(v){
 if(v===null)return;
 exact(v,['version','activation','group','buddy_invocation','buddy_start_micros','stock','profile_sha256','adapter_sha256','recovery_profile_sha256','companion']);if(v.version!==3n||!basicUuid(v.activation)||(!/^([a-f0-9]{32})$/.test(v.buddy_invocation)||/^0+$/.test(v.buddy_invocation))||!u(v.buddy_start_micros)||v.buddy_start_micros===0n)fail();
 groupRecord(v.group,'reader-buddy.service');const companion=parseCompanionBaseline(v.companion);
 if(!sameRecord(companion.group.context,v.group.context)||sameRecord(companion.group.group,v.group.group))fail();
 exact(v.stock,['process','invocation','executable_sha256','unit_sha256','dropin_sha256']);recordProcess(v.stock.process);if(!/^[a-f0-9]{32}$/.test(v.stock.invocation)||/^0+$/.test(v.stock.invocation))fail();for(const k of ['executable_sha256','unit_sha256','dropin_sha256'])hashArray(v.stock[k]);for(const k of ['profile_sha256','adapter_sha256','recovery_profile_sha256'])hashArray(v[k]);
}
function snapshot(v){
 if(v===null)return;exact(v,['state','policy','stop_extra','hooks']);
 for(const section of ['state','policy','stop_extra']){exact(v[section],catalog[section]);for(const x of Object.values(v[section]))if(!ascii(x))fail();}
 exact(v.hooks,catalog.hooks);
 const unknown=['transport-incomplete','invalid-input','response-limit','invalid-exit-status','client-error','unexpected-stderr','malformed-json','wrong-envelope','wrong-signature','invalid-command-array'];
 for(const name of catalog.hooks){const h=v.hooks[name];exact(h,['property','observation','type_verified','reason']);if(h.property!==name||!(h.observation==='observed-empty'&&h.type_verified===true&&h.reason==='typed-empty'||h.observation==='observed-nonempty'&&h.type_verified===true&&h.reason==='typed-nonempty'||h.observation==='unknown'&&h.type_verified===false&&unknown.includes(h.reason)))fail();}
 if(Buffer.byteLength(JSON.stringify(v))>16384)fail();stateFields(v.state);
}
function ordinaryAlias(v){
 exact(v,['device','inode','uid','gid','mode','length','mtime_ns','ctime_ns','links','literal','link_parents_sha256','target_parents_sha256']);
 for(const k of ['device','inode','uid','gid','mode','length','mtime_ns','ctime_ns'])if(!decimal(v[k],['uid','gid','mode'].includes(k)?32:64))fail();
 if(v.device==='0'||v.inode==='0'||v.uid!=='0'||v.gid!=='0'||v.mode!==String(0o120777)||
    v.links!=='1'||v.literal!==ORDINARY_STOP_ALIAS_TARGET||v.length!==String(v.literal.length)||
    !basicDigest(v.link_parents_sha256)||!basicDigest(v.target_parents_sha256))fail();
}
export function parseServiceStopRaw(v,selector){
 if(Buffer.byteLength(JSON.stringify(v))>262144)fail();
 const alias=Object.hasOwn(v??{},'ordinary_alias');
 exact(v,['selector','command','reason',...evidence,...(alias?['ordinary_alias']:[])]);
 if(alias)ordinaryAlias(v.ordinary_alias);
 if(v.selector!==selector||!['review','stop','inspect'].includes(selector)||!['not-submitted','request-accepted','unknown'].includes(v.command)||selector!=='stop'&&v.command!=='not-submitted'||!reasons.includes(v.reason))fail();
 if(v.command==='request-accepted'&&v.reason!==null||v.command==='unknown'&&v.reason===null)fail();
 for(const k of ['buddy','helper','stock','companion']){snapshot(v[k]);if(v[k]&&v[k].state.Id!==({buddy:'reader-buddy.service',helper:'reader-buddy-stock-recovery.service',stock:'xochitl.service',companion:'rm-sync.service'})[k])fail();}
 if(![null,'populated','empty-original','original-absent'].includes(v.companion_group))fail();
 if(v.vendor_policy!==null){exact(v.vendor_policy,['stock','companion']);for(const p of Object.values(v.vendor_policy)){exact(p,vendor.keys);if(Buffer.byteLength(JSON.stringify(p))>16384||!Object.values(p).every(x=>ascii(x)))fail();}}
 exact(v.configuration,['read','effective_mode']);if(v.configuration.read!=='not-read'||v.configuration.effective_mode!=='unverified'||!['not-read','absent-final-component','occupied','refused'].includes(v.lease_observation))fail();
 if(v.platform!==null){exact(v.platform,['firmware','kernel']);if(!ascii(v.platform.firmware,128)||!ascii(v.platform.kernel,256)||!v.platform.firmware||!v.platform.kernel)fail();}
 if(v.process!==null){
   const p=v.process;
   exact(p,['pid','start_ticks','uid','gid','executable','argv','sha256']);
   for(const k of ['pid','start_ticks','uid','gid'])if(!decimal(p[k],k==='pid'?32:64))fail();
   const paths=alias?[ORDINARY_STOP_ALIAS_TARGET]:[ORDINARY_STOP_EXEC_START,'/home/root/.local/lib/remarkable-buddies/reader-buddy'];
   if(!paths.includes(p.executable)||!Array.isArray(p.argv)||p.argv.length!==1||
      p.argv[0]!==(alias?ORDINARY_STOP_EXEC_START:p.executable)||!basicDigest(p.sha256))fail();
 }
 if(v.artifacts!==null){exact(v.artifacts,['buddy_unit','buddy_executable','recovery_profile','native_profile','adapter','helper_unit','stock_executable','stock_unit','stock_dropin','companion_executable','companion_unit','companion_dropin']);for(const [slot,f] of Object.entries(v.artifacts)){if(f===null)continue;exact(f,['device','inode','uid','gid','mode','length','mtime_ns','ctime_ns','sha256']);for(const k of ['device','inode','uid','gid','mode','length','mtime_ns','ctime_ns'])if(!decimal(f[k],['uid','gid','mode'].includes(k)?32:64))fail();if(f.device==='0'||f.inode==='0'||!basicDigest(f.sha256)||BigInt(f.length)>BigInt(['buddy_executable','adapter','stock_executable','companion_executable'].includes(slot)?134217728:32768))fail();}}
 recoveryProfile(record(v.recovery_profile_base64));leaseRecord(record(v.lease_base64));
 if(v.lease_base64!==null&&v.lease_observation!=='occupied')fail();
 const ordinary=alias||v.process?.executable===ORDINARY_STOP_EXEC_START;
 if(alias&&(selector==='inspect'||!v.process||!v.artifacts?.buddy_executable||!v.artifacts?.buddy_unit||
     v.recovery_profile_base64!==null||v.lease_base64!==null||v.helper!==null||v.stock!==null))fail();
 if(selector==='inspect'||v.process===null||ordinary){
   if(v.companion!==null||v.companion_group!==null||v.vendor_policy!==null)fail();
   if(ordinary&&Object.entries(v.artifacts??{}).some(([k,f])=>!['buddy_unit','buddy_executable'].includes(k)&&f!==null))fail();
 }
 else if(v.companion===null||v.companion_group===null||v.vendor_policy===null||v.recovery_profile_base64===null||v.lease_base64===null||Object.values(v.artifacts??{}).length!==12||Object.values(v.artifacts).some(x=>x===null))fail();
 return v;
}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export function serviceStopSampleDigest(observation,profile,raw){
 if(!['ordinary-manual','resident-installed'].includes(profile))fail();
 return createHash('sha256').update(JSON.stringify(canonical({connection_id:observation.connection_id,boot_id:observation.boot_id,profile,...Object.fromEntries(evidence.map(k=>[k,raw[k]])),...(Object.hasOwn(raw,'ordinary_alias')?{ordinary_alias:raw.ordinary_alias}:{})}))).digest('hex');
}
// Deliberately no qualified production tuple. Metadata, hashes or a matching
// source shape cannot enroll a deployment. Enabling requires reviewed native
// shutdown/recovery qualification and a source change, never a caller flag.
const qualifiedStopTuples=Object.freeze([]);
export function admitServiceStopProfile(observation,raw){return qualifiedStopTuples.find(tuple=>matchesCandidateStopProfile(observation,raw,tuple))?.profile??null;}
export function currentServiceState(observation){
 const s=observation?.service;if(!s||s.LoadState!=='loaded')return null;
 const state=({inactive:'inactive',active:'active',activating:'transitioning',deactivating:'transitioning',reloading:'transitioning',failed:'failed'})[s.ActiveState];return state?{state}:null;
}
// Host-private collector boundary for the eventual qualified fixed-path sampler.
// Its caller supplies only a fixed capture function, never renderer paths/units.
// Two samples cannot establish native ownership or enable a production tuple.
export async function collectServiceStopSample({capture,now=()=>performance.now()},observation,profile,deadline){
 const read=async()=>{if(now()>=deadline)fail();const r=parseServiceStopRaw(await capture(), 'review');if(now()>=deadline||r.command!=='not-submitted')fail();return r;};
 const before=await read(),digest=serviceStopSampleDigest(observation,profile,before),after=await read();
 if(serviceStopSampleDigest(observation,profile,after)!==digest)fail();
 return {raw:after,sample_sha256:digest};
}
