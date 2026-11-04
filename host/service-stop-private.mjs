import {createHash} from 'node:crypto';
import {strictJson} from './strict-json.mjs';
import {basicDigest,basicUuid} from './basic-settings-protocol.mjs';
import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('./service-stop-properties.json',import.meta.url),'utf8'));
const fail=()=>{throw Error('Service stop facts refused');};
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().join():'';
const exact=(v,k)=>{if(keys(v)!==[...k].sort().join())fail();};
const ascii=(v,max=4096)=>typeof v==='string'&&v.length<=max&&/^[\x20-\x7e]*$/.test(v);
const decimal=(v,bits=64)=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<(1n<<BigInt(bits));
const reasons=[null,'busy','unsupported','unavailable','invalid-response','cancelled','expired','session-changed','capacity','lifecycle-unqualified'];
const evidence=['buddy','helper','stock','process','platform','artifacts','recovery_profile_base64','lease_base64','lease_observation','configuration'];
export const SERVICE_STOP_COMMAND='/bin/systemctl --system --no-pager --no-ask-password --no-block --job-mode=fail stop -- reader-buddy.service';
export function emptyServiceStopRaw(selector,reason='lifecycle-unqualified'){
 return {selector,command:'not-submitted',reason,buddy:null,helper:null,stock:null,process:null,platform:null,artifacts:null,recovery_profile_base64:null,lease_base64:null,lease_observation:'not-read',configuration:{read:'not-read',effective_mode:'unverified'}};
}
function record(value){
 if(value===null)return null;
 if(typeof value!=='string'||value.length>43692)fail();const b=Buffer.from(value,'base64');
 try{if(b.length>32768||b.toString('base64')!==value)fail();const t=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);if(t.charCodeAt(0)===0xfeff)fail();strictJson(b);return JSON.parse(t,(_key,value,context)=>{if(typeof value==='number'){if(!/^(0|[1-9][0-9]*)$/.test(context.source))fail();return BigInt(context.source);}return value;});}finally{b.fill(0);}
}
const u=(v,bits=64)=>typeof v==='bigint'&&v>=0n&&v<(1n<<BigInt(bits));
function hashArray(v){if(!Array.isArray(v)||v.length!==32||!v.every(x=>u(x,8))||v.every(x=>x===0n))fail();}
function recordProcess(v){exact(v,['pid','start_ticks']);if(!u(v.pid,32)||v.pid<=1n||!u(v.start_ticks)||v.start_ticks===0n)fail();}
function fileIdentity(v){exact(v,['device','inode','uid','mode']);if(!u(v.device)||v.device===0n||!u(v.inode)||v.inode===0n||!u(v.uid,32)||!u(v.mode,32))fail();}
function recoveryProfile(v){
 if(v===null)return;
 const hashes=['native_profile_sha256','adapter_sha256','app_sha256','buddy_unit_sha256','helper_unit_sha256','stock_executable_sha256','stock_unit_sha256','stock_dropin_sha256'];
 exact(v,['version','firmware','kernel',...hashes,'buddy_policy','helper_policy','stock_policy']);if(v.version!==1n||v.firmware!=='3.28.0.172'||v.kernel!=='5.4.70-v1.6.3-rm11x')fail();
 for(const k of hashes)hashArray(v[k]);for(const k of ['buddy_policy','helper_policy','stock_policy']){exact(v[k],catalog.policy);for(const x of Object.values(v[k]))if(!ascii(x))fail();}
}
function leaseRecord(v){
 if(v===null)return;
 exact(v,['version','activation','group','buddy_invocation','buddy_start_micros','stock','profile_sha256','adapter_sha256','recovery_profile_sha256']);if(v.version!==2n||!basicUuid(v.activation)||!/^([a-f0-9]{32})$/.test(v.buddy_invocation)||!u(v.buddy_start_micros)||v.buddy_start_micros===0n)fail();
 const g=v.group;exact(g,['mount_path','unit','context','group','parent']);if(g.mount_path!=='/sys/fs/cgroup/unified'||g.unit!=='reader-buddy.service')fail();fileIdentity(g.group);recordProcess(g.parent);
 exact(g.context,['boot','mount_namespace','cgroup_namespace','mount_record','mount','slice']);if(!basicUuid(g.context.boot)||!ascii(g.context.mount_record,16384))fail();for(const k of ['mount_namespace','cgroup_namespace','mount','slice'])fileIdentity(g.context[k]);
 exact(v.stock,['process','invocation','executable_sha256','unit_sha256','dropin_sha256']);recordProcess(v.stock.process);if(!/^[a-f0-9]{32}$/.test(v.stock.invocation))fail();for(const k of ['executable_sha256','unit_sha256','dropin_sha256'])hashArray(v.stock[k]);for(const k of ['profile_sha256','adapter_sha256','recovery_profile_sha256'])hashArray(v[k]);
}
function snapshot(v){
 if(v===null)return;exact(v,['state','policy','stop_extra']);
 for(const [section,names] of Object.entries(catalog)){exact(v[section],names);for(const x of Object.values(v[section]))if(!ascii(x))fail();}
 if(Buffer.byteLength(Object.values(v).flatMap(Object.entries).map(([k,x])=>`${k}=${x}\n`).join(''))>32768)fail();
 for(const name of ['MainPID','ControlPID','ExecMainPID'])if(!decimal(v.state[name],32))fail();
 if(!decimal(v.state.ExecMainStartTimestampMonotonic)||!['reader-buddy.service','reader-buddy-stock-recovery.service','xochitl.service'].includes(v.state.Id))fail();
 if(v.state.InvocationID!==''&&!/^[a-f0-9]{32}$/.test(v.state.InvocationID))fail();
}
export function parseServiceStopRaw(v,selector){
 if(Buffer.byteLength(JSON.stringify(v))>262144)fail();exact(v,['selector','command','reason',...evidence]);
 if(v.selector!==selector||!['review','stop','inspect'].includes(selector)||!['not-submitted','request-accepted','unknown'].includes(v.command)||selector!=='stop'&&v.command!=='not-submitted'||!reasons.includes(v.reason))fail();
 if(v.command==='request-accepted'&&v.reason!==null||v.command==='unknown'&&v.reason===null)fail();
 for(const k of ['buddy','helper','stock']){snapshot(v[k]);if(v[k]&&v[k].state.Id!==({buddy:'reader-buddy.service',helper:'reader-buddy-stock-recovery.service',stock:'xochitl.service'})[k])fail();}
 exact(v.configuration,['read','effective_mode']);if(v.configuration.read!=='not-read'||v.configuration.effective_mode!=='unverified'||!['not-read','absent-final-component','occupied','refused'].includes(v.lease_observation))fail();
 if(v.platform!==null){exact(v.platform,['firmware','kernel']);if(!ascii(v.platform.firmware,128)||!ascii(v.platform.kernel,256)||!v.platform.firmware||!v.platform.kernel)fail();}
 if(v.process!==null){const p=v.process;exact(p,['pid','start_ticks','uid','gid','executable','argv','sha256']);for(const k of ['pid','start_ticks','uid','gid'])if(!decimal(p[k],k==='pid'?32:64))fail();if(!['/opt/bin/reader-buddy','/home/root/.local/lib/reader-buddy/reader-buddy'].includes(p.executable)||!Array.isArray(p.argv)||p.argv.length!==1||p.argv[0]!==p.executable||!basicDigest(p.sha256))fail();}
 if(v.artifacts!==null){exact(v.artifacts,['buddy_unit','buddy_executable','recovery_profile','native_profile','adapter','helper_unit','stock_executable','stock_unit','stock_dropin']);for(const [slot,f] of Object.entries(v.artifacts)){if(f===null)continue;exact(f,['device','inode','uid','gid','mode','length','mtime_ns','ctime_ns','sha256']);for(const k of ['device','inode','uid','gid','mode','length','mtime_ns','ctime_ns'])if(!decimal(f[k],['uid','gid','mode'].includes(k)?32:64))fail();if(f.device==='0'||f.inode==='0'||!basicDigest(f.sha256)||BigInt(f.length)>BigInt(['buddy_executable','adapter','stock_executable'].includes(slot)?134217728:32768))fail();}}
 recoveryProfile(record(v.recovery_profile_base64));leaseRecord(record(v.lease_base64));
 if(v.lease_base64!==null&&v.lease_observation!=='occupied')fail();
 return v;
}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export function serviceStopSampleDigest(observation,profile,raw){
 if(!['ordinary-manual','resident-installed'].includes(profile))fail();
 return createHash('sha256').update(JSON.stringify(canonical({connection_id:observation.connection_id,boot_id:observation.boot_id,profile,...Object.fromEntries(evidence.map(k=>[k,raw[k]]))}))).digest('hex');
}
// Deliberately no qualified production tuple. Metadata, hashes or a matching
// source shape cannot enroll a deployment. Enabling requires reviewed native
// shutdown/recovery qualification and a source change, never a caller flag.
export function admitServiceStopProfile(){return null;}
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
