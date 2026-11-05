// Candidate semantics only. A matching shape is not deployed provenance,
// qualification, native ownership, or permission to submit a service job.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseServiceStopRaw,parseCompanionBaseline} from './service-stop-private.mjs';
const catalog=JSON.parse(readFileSync(new URL('./service-stop-properties.json',import.meta.url),'utf8'));
const vendor=JSON.parse(readFileSync(new URL('./service-stop-vendor-policy.json',import.meta.url),'utf8'));
const companionPins={companion_executable:'1caf6493cce2132af89a9377679c19005bef1c5b0e658f704f95b4fdbd07138c',companion_unit:'076675399604b9fdbee7f267900bd4490de88d32ab1cc49a32d8d45a75bcac8f',companion_dropin:'4d4345a6299448ade99878ddeeb894dd9a1a90de230bc3371a5e44237da7a795'};
const BUDDY='reader-buddy.service',HELPER='reader-buddy-stock-recovery.service',STOCK='xochitl.service';
const manualUnit='434d00dc6b62096b782dc85d417338a8283269f913f954af897a85cbc8ba64a6';
const matches=(got,wanted)=>Object.entries(wanted).every(([k,v])=>got?.[k]===v);
const nonzero=v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const hash=v=>Array.isArray(v)&&v.length===32?v.map(x=>Number(x).toString(16).padStart(2,'0')).join(''):null;
const finite=v=>typeof v==='string'&&/^(?:[0-9]+(?:\.[0-9]+)?(?:us|ms|s|min|h|d|w|month|y))(?: [0-9]+(?:\.[0-9]+)?(?:us|ms|s|min|h|d|w|month|y))*$/.test(v)&&/[1-9]/.test(v);
const fixedFiles={buddy_unit:'/etc/systemd/system/reader-buddy.service',helper_unit:'/etc/systemd/system/reader-buddy-stock-recovery.service',stock_unit:'/usr/lib/systemd/system/xochitl.service',stock_dropin:'/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf'};
function protectedFile(f){if(!f||f.uid!=='0'||f.gid!=='0'||!digest(f.sha256))return false;const m=BigInt(f.mode);return (m&0o170000n)===0o100000n&&(m&0o022n)===0n;}
function policiesEqual(got,wanted,helper=false){
 if(!got||!wanted||Object.keys(got).sort().join()!==[...catalog.policy].sort().join()||Object.keys(wanted).sort().join()!==[...catalog.policy].sort().join())return false;
 return catalog.policy.every(k=>{if(k==='WatchdogUSec'&&helper&&got[k]==='infinity')return wanted[k]==='0';if(['After','Conflicts'].includes(k)){const a=got[k].split(/\s+/).filter(Boolean).sort(),b=wanted[k].split(/\s+/).filter(Boolean).sort();return new Set(a).size===a.length&&new Set(b).size===b.length&&a.join()===b.join();}return got[k]===wanted[k];});
}
function extras(s){return matches(s.stop_extra,{ExecStop:'',ExecStopPost:'',KillSignal:'15',FinalKillSignal:'9',RefuseManualStop:'no',CanStop:'yes'})&&['','root'].includes(s.stop_extra.User)&&['','root'].includes(s.stop_extra.Group);}
function safePolicy(p,fragment,dropins=''){return matches(p,{FragmentPath:fragment,DropInPaths:dropins,NeedDaemonReload:'no',KillMode:'control-group',Delegate:'no',SendSIGKILL:'yes',RestartForceExitStatus:''});}
function cleared(s){return matches(s.state,{ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlPID:'0',ExecMainPID:'0',ExecMainStartTimestampMonotonic:'0',InvocationID:'',ControlGroup:'',Job:''});}
function parseRecord(value){const text=Buffer.from(value,'base64').toString('utf8');return JSON.parse(text,(_k,v,c)=>typeof v==='number'?BigInt(c.source):v);}
function vendorEqual(got,wanted){return got&&wanted&&Object.keys(got).sort().join()===vendor.keys.toSorted().join()&&Object.keys(wanted).sort().join()===vendor.keys.toSorted().join()&&vendor.keys.every(k=>{if(!vendor.token_sets.includes(k))return got[k]===wanted[k];const a=got[k].split(/\s+/).filter(Boolean).sort(),b=wanted[k].split(/\s+/).filter(Boolean).sort();return new Set(a).size===a.length&&new Set(b).size===b.length&&a.join()===b.join();});}
export function companionTerminal(current,original,group){
 const s=current.state,o=original.state;
 const retained=s.InvocationID===o.InvocationID&&s.ExecMainPID===o.ExecMainPID&&s.ExecMainStartTimestampMonotonic===o.ExecMainStartTimestampMonotonic;
 const clear=s.InvocationID===''&&s.ExecMainPID==='0'&&s.ExecMainStartTimestampMonotonic==='0';
 if((!retained&&!clear)||s.Id!=='rm-sync.service'||s.LoadState!=='loaded'||s.MainPID!=='0'||s.ControlPID!=='0'||s.Job!==''||current.policy.WatchdogUSec!=='0'||original.policy.WatchdogUSec!=='0'||!policiesEqual(current.policy,original.policy))return false;
 if(!(s.ActiveState==='inactive'&&s.SubState==='dead'||retained&&s.ActiveState==='failed'&&s.SubState==='failed')||!['empty-original','original-absent'].includes(group))return false;
 if(s.ControlGroup===''&&group!=='original-absent'||s.ControlGroup!==o.ControlGroup&&!(s.ControlGroup===''&&group==='original-absent')||clear&&group!=='original-absent')return false;
 return true;
}
export function matchesCandidateStopProfile(observation,raw,tuple){
 try{
  // tuple must come from independently reviewed immutable build/platform policy,
  // never copied from this observation or accepted from a renderer/device file.
  if(!['review','stop'].includes(raw?.selector))return false;parseServiceStopRaw(raw,raw.selector);
  if(!tuple||Object.keys(tuple).sort().join()!=='artifacts,buddy_extra,buddy_policy,companion_policy,helper_policy,model,platform,profile,stock_policy,vendor_policy'||!['ordinary-manual','resident-installed'].includes(tuple.profile)||!observation?.model||observation.firmware_conflict||!raw.platform||!matches(raw.platform,tuple.platform)||tuple.model!==observation.model||observation.firmware!==raw.platform.firmware)return false;
  if(Object.keys(tuple.buddy_extra??{}).sort().join()!==[...catalog.stop_extra].sort().join()||Object.keys(tuple.platform??{}).sort().join()!=='firmware,kernel')return false;
  const expectedSlots=tuple.profile==='ordinary-manual'?['buddy_unit','buddy_executable']:['buddy_unit','buddy_executable','recovery_profile','native_profile','adapter','helper_unit','stock_executable','stock_unit','stock_dropin',...Object.keys(companionPins)];if(Object.keys(tuple.artifacts??{}).sort().join()!==expectedSlots.sort().join())return false;
  const b=raw.buddy,p=raw.process,a=raw.artifacts,packageUnit='/usr/lib/systemd/system/reader-buddy.service';if(!b||!p||!a||!matches(b.state,{Id:BUDDY,LoadState:'loaded',ActiveState:'active',SubState:'running',ControlPID:'0',Job:'',ControlGroup:'/system.slice/'+BUDDY})||b.stop_extra.Names!==BUDDY||!nonzero(b.state.MainPID)||BigInt(b.state.MainPID)<=1n||b.state.MainPID!==b.state.ExecMainPID||p.pid!==b.state.MainPID||!nonzero(p.start_ticks)||!nonzero(b.state.ExecMainStartTimestampMonotonic)||!/^[a-f0-9]{32}$/.test(b.state.InvocationID)||/^0+$/.test(b.state.InvocationID)||p.uid!=='0'||p.gid!=='0'||!extras(b)||!safePolicy(b.policy,tuple.profile==='ordinary-manual'?fixedFiles.buddy_unit:packageUnit))return false;
  if(!a.buddy_unit||!a.buddy_executable||p.sha256!==a.buddy_executable.sha256||!Object.entries(a).every(([k,f])=>f===null||protectedFile(f)&&tuple.artifacts?.[k]===f.sha256)||!policiesEqual(b.policy,tuple.buddy_policy)||!matches(b.stop_extra,tuple.buddy_extra))return false;
  if(tuple.profile==='ordinary-manual'){
   if(tuple.companion_policy!==null||tuple.vendor_policy!==null)return false;
   return matches(b.policy,{Type:'simple',Restart:'on-failure',DefaultDependencies:'yes',WatchdogUSec:'0',OnSuccess:'',OnFailure:''})&&matches(b.stop_extra,{WorkingDirectory:'/home/root',RestartUSec:'5s',EnvironmentFiles:'/home/root/.config/reader-buddy/environment (ignore_errors=no)'})&&finite(b.policy.TimeoutStopUSec)&&finite(b.policy.TimeoutStartUSec)&&a.buddy_unit.sha256===manualUnit&&p.executable==='/opt/bin/reader-buddy'&&p.argv.length===1&&p.argv[0]===p.executable&&raw.recovery_profile_base64===null&&raw.lease_base64===null&&raw.lease_observation==='absent-final-component'&&Object.entries(a).every(([k,f])=>['buddy_unit','buddy_executable'].includes(k)||f===null);
  }
  if(!raw.recovery_profile_base64||!raw.lease_base64||raw.lease_observation!=='occupied'||!Object.values(a).every(protectedFile)||p.executable!=='/home/root/.local/lib/remarkable-buddies/reader-buddy'||p.argv.length!==1||p.argv[0]!==p.executable||!raw.helper||!raw.stock||!raw.companion)return false;
  const profileBytes=Buffer.from(raw.recovery_profile_base64,'base64');if(createHash('sha256').update(profileBytes).digest('hex')!==a.recovery_profile.sha256||String(profileBytes.length)!==a.recovery_profile.length)return false;
  const profile=parseRecord(raw.recovery_profile_base64),lease=parseRecord(raw.lease_base64),h=raw.helper,s=raw.stock;
  if(profile.version!==6n||lease.version!==3n||raw.platform.firmware!=='3.28.0.172'||raw.platform.kernel!=='5.4.70-v1.6.3-rm11x'||profile.firmware!==raw.platform.firmware||profile.kernel!==raw.platform.kernel)return false;
  if(a.native_profile.sha256!=='f49f297717cc09cf21fad47e52d47a4faad0c84f4fed4f98ca69ddb41b96b146'||a.adapter.sha256!=='8fc60498eb404f5a833d4b4ec4c99b76080f146012c76eb1ea7cb55d44b2b62c'||!Object.entries(companionPins).every(([k,v])=>a[k].sha256===v))return false;
  const original=parseCompanionBaseline(lease.companion);
  if(!companionTerminal(raw.companion,original,raw.companion_group)||!policiesEqual(original.policy,tuple.companion_policy)||!raw.vendor_policy||!tuple.vendor_policy||Object.keys(tuple.vendor_policy).sort().join()!=='companion,stock')return false;
  for(const key of ['stock','companion'])if(!vendorEqual(raw.vendor_policy[key],vendor[key])||!vendorEqual(raw.vendor_policy[key],tuple.vendor_policy[key]))return false;
  for(const name of ['stock','companion'])for(const [key,value] of Object.entries(raw.vendor_policy[name]))if(Object.hasOwn(raw[name].policy,key)&&!(['After','Conflicts'].includes(key)?policiesEqual(raw[name].policy,{...raw[name].policy,[key]:value}):raw[name].policy[key]===value))return false;
  const fields={native_profile:'native_profile_sha256',adapter:'adapter_sha256',buddy_executable:'app_sha256',buddy_unit:'buddy_unit_sha256',helper_unit:'helper_unit_sha256',stock_executable:'stock_executable_sha256',stock_unit:'stock_unit_sha256',stock_dropin:'stock_dropin_sha256'};
  if(!Object.entries(fields).every(([slot,key])=>a[slot].sha256===hash(profile[key])))return false;
  if(lease.group.context.boot!==observation.boot_id||lease.group.unit!==BUDDY||lease.group.mount_path!=='/sys/fs/cgroup/unified'||String(lease.group.parent.pid)!==p.pid||String(lease.group.parent.start_ticks)!==p.start_ticks||lease.buddy_invocation!==b.state.InvocationID||String(lease.buddy_start_micros)!==b.state.ExecMainStartTimestampMonotonic||hash(lease.profile_sha256)!==a.native_profile.sha256||hash(lease.adapter_sha256)!==a.adapter.sha256||hash(lease.recovery_profile_sha256)!==a.recovery_profile.sha256||hash(lease.stock.executable_sha256)!==a.stock_executable.sha256||hash(lease.stock.unit_sha256)!==a.stock_unit.sha256||hash(lease.stock.dropin_sha256)!==a.stock_dropin.sha256)return false;
  if(!policiesEqual(b.policy,profile.buddy_policy)||!policiesEqual(h.policy,profile.helper_policy,true)||!policiesEqual(s.policy,profile.stock_policy)||!policiesEqual(h.policy,tuple.helper_policy,true)||!policiesEqual(s.policy,tuple.stock_policy))return false;
  if(!matches(b.policy,{Type:'notify',Restart:'no',OnSuccess:HELPER,OnFailure:HELPER,OnSuccessJobMode:'fail',OnFailureJobMode:'fail',DefaultDependencies:'yes',WatchdogUSec:'2min'})||!b.policy.Conflicts.split(/\s+/).includes('shutdown.target'))return false;
  if(!matches(h.state,{Id:HELPER,LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlPID:'0',Job:''})||!safePolicy(h.policy,'/usr/lib/systemd/system/'+HELPER)||!matches(h.policy,{Type:'oneshot',Restart:'no',DefaultDependencies:'yes',TimeoutStartUSec:'2min 10s',OnSuccess:'',OnFailure:''})||!h.policy.Conflicts.split(/\s+/).includes(BUDDY)||!h.policy.Conflicts.split(/\s+/).includes('shutdown.target')||!h.policy.After.split(/\s+/).includes(BUDDY)||profile.helper_policy.WatchdogUSec!=='0'||h.policy.WatchdogUSec==='infinity'&&!cleared(h))return false;
  return s.state.Id===STOCK&&s.state.LoadState==='loaded'&&safePolicy(s.policy,fixedFiles.stock_unit,fixedFiles.stock_dropin)&&s.policy.TimeoutStopUSec==='1min 30s';
 }catch{return false;}
}
