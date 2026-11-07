"""Synthetic fixed-command/filesystem controls, never physical tablet evidence."""
import base64
import copy
import os
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shlex
import shutil
import subprocess
import tempfile
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'host'))
import service_stop_sampler as s
import service_stop_transport as t
VECTORS=json.loads((Path(__file__).resolve().parents[1]/'fixtures/service-stop-profile-vectors.json').read_text())


class Files:
 def __init__(self,profile='ordinary-manual'):
  self.vector=copy.deepcopy(next(v for v in VECTORS if v['tuple']['profile']==profile));self.raw=self.vector['raw'];self.profile=profile;self.commands=[];self.change=None;self.permission=False;self.extra_argv=False;self.bad_parent=False;self.namespace_drift=False;self.slotpaths=dict(s.SLOTS,buddy_executable=s.APPS[profile]);self.by_path={v:k for k,v in self.slotpaths.items()};self.contents={}
  if profile=='ordinary-manual':self.slotpaths['buddy_unit']='/etc/systemd/system/'+s.BUDDY
  self.by_path={v:k for k,v in self.slotpaths.items()};self.legacy_directory=False;self.legacy_profile=False;self.shadow=False;self.companion_state='original-absent';self.companion_replaced=False;self.companion_permission=False
  for field,path in [('recovery_profile_base64',s.SLOTS['recovery_profile']),('lease_base64',s.LEASE)]:
   if self.raw[field]:self.contents[path]=base64.b64decode(self.raw[field])
 def meta(self,path,follow=False):
  record=path==s.LEASE;slot=self.by_path.get(path)
  if path=='/proc/20/exe':slot='buddy_executable'
  f=self.raw['artifacts'].get(slot) if slot else None
  if f:mode=int(f['mode']);length=int(f['length']);inode=2
  elif record:mode=0o100600;length=len(self.contents[s.LEASE]);inode=3
  else:mode=0o40700 if path==s.LEASE_DIRECTORY else 0o40755;length=0;inode=1
  if self.bad_parent and path=='/opt':mode=0o40777
  if self.change and path==s.APPS[self.profile]:inode=self.change()
  device,uid=1,0
  if self.profile=='resident-installed':
   g=json.loads(self.contents[s.LEASE])['group'];c=g['context'];mount='/sys/fs/cgroup/unified'
   cg=json.loads(json.loads(self.contents[s.LEASE])['companion'])['group']
   identities={mount:c['mount'],mount+'/system.slice':c['slice'],mount+'/system.slice/'+s.BUDDY:g['group'],mount+'/system.slice/'+s.COMPANION:cg['group'],'/proc/20/ns/mnt':c['mount_namespace'],'/proc/self/ns/mnt':c['mount_namespace'],'/proc/20/ns/cgroup':c['cgroup_namespace'],'/proc/self/ns/cgroup':c['cgroup_namespace']}
   if path in identities:
    x=identities[path];device,inode,uid,mode=x['device'],x['inode'],x['uid'],x['mode']
    if self.namespace_drift and path=='/proc/20/ns/mnt':inode+=1
    if self.companion_replaced and path==mount+'/system.slice/'+s.COMPANION:inode+=1
  return f'{device} {inode} {uid} 0 {mode:x} {length} {1 if slot or record else 2}\n2026-01-01 00:00:00.000000001 +0000\n2026-01-01 00:00:00.000000001 +0000\n'.encode()
 def run(self,transport,command,deadline,cap):
  self.commands.append(command)
  if command.startswith('/bin/systemctl '):
   unit=command.rsplit(' ',1)[1];name={s.BUDDY:'buddy',s.HELPER:'helper',s.STOCK:'stock',s.COMPANION:'companion'}[unit]
   if '--property=UMask' in command:return 0,''.join(k+'='+v+'\n' for k,v in self.raw['vendor_policy'][name].items()).encode(),b''
   value=self.raw[name];out=''.join(k+'='+v+'\n' for section in s.TEXT_SECTIONS for k,v in value[section].items()).encode();return 0,out,b''
  if 'CAPCLIENT1' in command:
   lines=['CAPCLIENT1','present']+['1 1 0 0 41ed 0 1 1 1']*3+['1 2 0 0 81ed 71172 1 1 1',s.hooks.EXPECTED_SHA256+'  /usr/bin/busctl']
   return 0,('\n'.join(lines)+'\n').encode(),b''
  if 'DBUS_SYSTEM_BUS_ADDRESS=' in command:
   parts=shlex.split(shlex.split(command)[-1]);args=parts[parts.index('call')+1:];method=args[3]
   if method=='GetId':value,kind='a'*32,'s'
   elif method=='GetNameOwner':value,kind=':1.0','s'
   elif method=='GetConnectionUnixProcessID':value,kind=1,'u'
   elif method=='GetUnit':value,kind=s.UNIT_OBJECTS[args[5]],'o'
   elif method=='Get':
    unit=next(k for k,v in s.UNIT_OBJECTS.items() if v==args[1]);name={s.BUDDY:'buddy',s.HELPER:'helper',s.STOCK:'stock',s.COMPANION:'companion'}[unit]
    h=self.raw[name]['hooks'][args[6]]
    commands=[] if h['observation']=='observed-empty' else [['PRIVATE_CANARY',[],False,0,0,0,0,0,0,0]]
    return 0,json.dumps(dict(type='v',data=[dict(type=s.hooks.SIGNATURE,data=commands)])).encode(),b''
   else:raise AssertionError('unexpected typed method')
   return 0,json.dumps(dict(type=kind,data=[value])).encode(),b''
  script=shlex.split(command)[-1];parts=shlex.split(script);path=parts[-1]
  if parts[0]=='stat' and '-f' in parts:return 0,b'63677270\n',b''
  if parts.count('stat')>1:
   chunks=[]
   for i in range(0,len(parts),11):
    pair=parts[i:i+10];path=pair[3]
    assert pair==['test','!','-L',path,'&&','stat','-c',s.STAT_FORMAT,'--',path]
    if i+10<len(parts):assert parts[i+10]=='&&'
    chunks.append(self.meta(path))
   return 0,b''.join(chunks),b''
  if 'stat' in parts:
   legacy='/home/root/.local/lib/reader-buddy'
   absent=self.profile=='resident-installed' and ((path==legacy and not self.legacy_directory) or (path==legacy+'/resident-recovery.json' and not self.legacy_profile) or (path in ['/etc/systemd/system/'+s.BUDDY,'/etc/systemd/system/'+s.HELPER] and not self.shadow) or (path=='/sys/fs/cgroup/unified/system.slice/'+s.COMPANION and self.companion_state=='original-absent'))
   if absent or self.companion_permission and path=='/sys/fs/cgroup/unified/system.slice/'+s.COMPANION:
    message='Permission denied' if self.companion_permission and path=='/sys/fs/cgroup/unified/system.slice/'+s.COMPANION else 'No such file or directory'
    return 1,b'',f"stat: cannot statx '{path}': {message}\n".encode()
   if path==s.LEASE_DIRECTORY and self.profile=='ordinary-manual':
    message='Permission denied' if self.permission else 'No such file or directory'
    return 1,b'',f"stat: cannot statx '{path}': {message}\n".encode()
   return 0,self.meta(path,script.startswith('stat -L')),b''
  if parts[0]=='sha256sum':
   slot='buddy_executable' if path=='/proc/20/exe' else self.by_path[path]
   return 0,(self.raw['artifacts'][slot]['sha256']+'  '+path+'\n').encode(),b''
  if parts[0]=='readlink':return 0,(s.APPS[self.profile]+'\n').encode(),b''
  if parts[0]=='dd':
   path=next(x[3:] for x in parts if x.startswith('if='))
   if path=='/proc/20/stat':out=('20 (reader-buddy) S '+' '.join(['0']*18+['40'])).encode()
   elif path=='/proc/20/cmdline':out=s.APPS[self.profile].encode()+b'\0'+(b'SECRET' if self.extra_argv else b'')
   elif path=='/proc/20/status':out=b'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n'
   elif path=='/proc/20/cgroup':out=b'0::/system.slice/reader-buddy.service\n'
   elif path=='/proc/sys/kernel/random/boot_id':out=(self.vector['observation']['boot_id']+'\n').encode()
   elif path=='/proc/self/mountinfo':out=(json.loads(self.contents[s.LEASE])['group']['context']['mount_record']+'\n').encode()
   elif path.endswith('/cgroup.events'):out=b'populated 0\nfrozen 0\n' if s.COMPANION in path and self.companion_state=='empty-original' else b'populated 1\nfrozen 0\n'
   elif path=='/etc/os-release':out=b'IMG_VERSION="3.28.0.172"\n'
   elif path=='/proc/sys/kernel/osrelease':out=b'5.4.70-v1.6.3-rm11x\n'
   else:out=self.contents[path]
   return 0,out[:int(next(x[6:] for x in parts if x.startswith('count=')))],b''
  raise AssertionError('unexpected fixed command')
 def sampler(self):return s.Sampler(Mock(),time.monotonic()+12,run=self.run)


class Channel:
 def __init__(self,out=b'',err=b'',code=0):self.out=out;self.err=err;self.code=code;self.closed=False;self.write_closed=False;self.commands=[]
 def settimeout(self,value):pass
 def exec_command(self,value):self.commands.append(value)
 def shutdown_write(self):self.write_closed=True
 def recv_ready(self):return bool(self.out)
 def recv_stderr_ready(self):return bool(self.err)
 def recv(self,n):v=self.out[:n];self.out=self.out[n:];return v
 def recv_stderr(self,n):v=self.err[:n];self.err=self.err[n:];return v
 def exit_status_ready(self):return True
 def recv_exit_status(self):return self.code
 def close(self):self.closed=True


class SamplerTests(unittest.TestCase):
 def test_parent_chain_is_one_ordered_command_with_original_metadata(self):
  f=Files();original=f.meta
  def meta(path,follow=False):
   lines=original(path,follow).split(b'\n');fields=lines[0].split();fields[1]=str(['/','/opt','/opt/bin'].index(path)+1).encode();lines[0]=b' '.join(fields);return b'\n'.join(lines)
  f.meta=meta;sampler=f.sampler();result=sampler.parents('/opt/bin/reader-buddy')
  self.assertEqual(result,[(p,s.metadata(f.meta(p))) for p in ['/','/opt','/opt/bin']])
  self.assertEqual(len(f.commands),1);parts=shlex.split(shlex.split(f.commands[0])[-1])
  self.assertEqual(parts.count('stat'),3);self.assertEqual(parts.count('test'),3)
  self.assertNotIn('sha256sum',parts);self.assertNotIn('dd',parts)
  f.commands.clear();self.assertEqual(sampler.parents('/'),[]);self.assertEqual(f.commands,[])
 def test_parent_chain_rejects_partial_extra_framing_status_and_stderr(self):
  f=Files();good=b''.join(f.meta(p) for p in ['/','/opt','/opt/bin'])
  bad=[(1,good,b''),(0,good,b'warning'),(0,good[:-1],b''),(0,good+b'\n',b''),
       (0,good+f.meta('/'),b''),(0,good[:-len(f.meta('/opt/bin'))],b''),
       (0,good.replace(b'\n',b'\\n'),b''),(0,good.replace(b'.000000001',b'.000001',1),b'')]
  for reply in bad:
   with self.subTest(reply=reply):
    run=Mock(return_value=reply);sampler=s.Sampler(Mock(),time.monotonic()+5,run=run)
    with self.assertRaises(ValueError):sampler.parents('/opt/bin/reader-buddy')
    self.assertEqual(run.call_count,1);self.assertEqual(run.call_args.args[3],4096);self.assertEqual(run.call_args.args[2],sampler.deadline)
 def test_all_parent_metadata_precedes_host_validation_but_never_leaf_io(self):
  for field,value in [(2,'1'),(3,'1'),(4,'81ed'),(4,'41ff')]:
   f=Files();original=f.meta;seen=[]
   def meta(path,follow=False):
    seen.append(path);raw=original(path,follow)
    if path=='/opt':
     lines=raw.split(b'\n');fields=lines[0].split();fields[field]=value.encode();lines[0]=b' '.join(fields);raw=b'\n'.join(lines)
    return raw
   f.meta=meta
   with self.assertRaises(ValueError):f.sampler().file('/opt/bin/reader-buddy',contents=True)
   self.assertIn('/opt/bin',seen) # deliberate additional metadata, not early host refusal
   self.assertEqual(len(f.commands),1)
   script=shlex.split(f.commands[0])[-1]
   self.assertNotIn('sha256sum',script);self.assertNotIn('dd ',script)
   self.assertNotIn('/opt/bin/reader-buddy',script)
 def test_changed_parent_in_second_chain_refuses_without_a_cache(self):
  f=Files();original=f.meta;reads=0
  def meta(path,follow=False):
   nonlocal reads
   raw=original(path,follow)
   if path=='/opt':
    reads+=1
    if reads==2:
     lines=raw.split(b'\n');fields=lines[0].split();fields[1]=b'99';lines[0]=b' '.join(fields);raw=b'\n'.join(lines)
   return raw
  f.meta=meta
  with self.assertRaises(ValueError):f.sampler().file('/opt/bin/reader-buddy')
  self.assertEqual(reads,2)
  chains=[c for c in f.commands if shlex.split(shlex.split(c)[-1]).count('stat')==3]
  self.assertEqual(len(chains),2);self.assertEqual(chains[0],chains[1])
 @unittest.skipUnless(sys.platform=='linux','local GNU parent chain')
 def test_actual_gnu_parent_batch_producer_and_unsafe_missing_symlink(self):
  self.exercise_parent_batch()
 @unittest.skipUnless(sys.platform=='linux' and shutil.which('busybox'),'local BusyBox parent chain')
 def test_actual_busybox_parent_batch_producer_and_unsafe_missing_symlink(self):
  self.exercise_parent_batch(shutil.which('busybox'))
 def exercise_parent_batch(self,busybox=None):
  replies=[]
  def local(_,command,deadline,cap):
   r=subprocess.run(command,shell=True,capture_output=True,timeout=max(.01,deadline-time.monotonic()))
   if len(r.stdout)>cap or len(r.stderr)>8192:raise ValueError('fixture bound')
   replies.append((command,r.returncode,r.stdout,r.stderr));return r.returncode,r.stdout,r.stderr
  with tempfile.TemporaryDirectory() as folder:
   fixture=Path(folder);prefix=s.PREFIX
   if busybox:
    binary=fixture/'bin';binary.mkdir();shim=binary/'stat'
    shim.write_text('#!/bin/sh\nexec '+shlex.quote(busybox)+' stat "$@"\n');shim.chmod(0o700)
    prefix='/usr/bin/env -i HOME=/home/root PATH='+shlex.quote(str(binary)+':/usr/bin:/bin')+' LC_ALL=C /bin/sh -c '
   with patch.object(s,'PREFIX',prefix):
    sampler=s.Sampler(Mock(),time.monotonic()+12,run=local)
    result=sampler.parents('/usr/bin/stat');self.assertEqual([p for p,_ in result],['/','/usr','/usr/bin'])
    self.assertEqual(len(replies),1)
    for name,(metadata,nlink) in result:
     current=Path(name).lstat();self.assertEqual(metadata['inode'],str(current.st_ino));self.assertEqual(metadata['mtime_ns'],str(current.st_mtime_ns));self.assertEqual(metadata['ctime_ns'],str(current.st_ctime_ns));self.assertEqual(nlink,current.st_nlink)
    missing='/usr/'+fixture.name+'-missing/leaf'
    with self.assertRaises(ValueError):sampler.parents(missing)
    self.assertNotEqual(replies[-1][1],0);self.assertNotEqual(replies[-1][2],b'') # complete earlier records, refused partial chain
    link=fixture/'parent-link';link.symlink_to('/usr/bin',target_is_directory=True)
    with self.assertRaises(ValueError):sampler.parents(str(link/'leaf'))
    self.assertNotEqual(replies[-1][1],0)
    self.assertEqual(len(replies[-1][2].splitlines()),3*(len(PurePosixPath(str(link/'leaf')).parents)-1))
    non_directory=fixture/'file-parent';non_directory.write_bytes(b'not read by producer')
    with self.assertRaises(ValueError):sampler.parents(str(non_directory/'child'/'leaf'))
    self.assertNotEqual(replies[-1][1],0);self.assertNotEqual(replies[-1][3],b'')
    quoted=fixture/"quoted ' parent";quoted.mkdir()
    with self.assertRaises(ValueError):sampler.parents(str(quoted/'leaf')) # /tmp and owned non-root directory are unsafe
    self.assertEqual(replies[-1][1],0);self.assertEqual(replies[-1][3],b'')
    self.assertNotIn("stat -L",shlex.split(replies[-1][0])[-1])
    self.assertNotIn('leaf',shlex.split(replies[-1][0])[-1])
 @unittest.skipUnless(sys.platform=='linux','local POSIX GNU stat fixture')
 def test_actual_local_posix_stat_format_quoting_and_nofollow(self):
  self.exercise_local_stat()
 @unittest.skipUnless(sys.platform=='linux' and shutil.which('busybox'),'local BusyBox stat fixture')
 def test_actual_local_busybox_stat_format_quoting_and_nofollow(self):
  self.exercise_local_stat(shutil.which('busybox'))
 def exercise_local_stat(self,busybox=None):
  def local(_transport,command,deadline,cap):
   r=subprocess.run(command,shell=True,capture_output=True,timeout=max(.01,deadline-time.monotonic()))
   if len(r.stdout)>cap or len(r.stderr)>8192:raise ValueError('fixture bound')
   return r.returncode,r.stdout,r.stderr
  with tempfile.TemporaryDirectory() as folder:
   fixture=Path(folder);prefix=s.PREFIX
   if busybox:
    # Resolve stat through an owned shim; run the actual producer script and
    # installed BusyBox applet, not an emulation of its output/formatting.
    binary=fixture/'bin';binary.mkdir();shim=binary/'stat'
    shim.write_text('#!/bin/sh\nexec '+shlex.quote(busybox)+' stat "$@"\n');shim.chmod(0o700)
    prefix='/usr/bin/env -i HOME=/home/root PATH='+shlex.quote(str(binary)+':/usr/bin:/bin')+' LC_ALL=C /bin/sh -c '
   with patch.object(s,'PREFIX',prefix):
    p=fixture/"unit ' quoted";p.write_bytes(b'local fixture')
    os.utime(p,ns=(1700000000123456789,1700000000987654321))
    sampler=s.Sampler(Mock(),time.monotonic()+12,run=local)
    evidence,links=sampler.stat(str(p));actual=p.stat()
    self.assertEqual(evidence['mtime_ns'],str(actual.st_mtime_ns));self.assertEqual(evidence['ctime_ns'],str(actual.st_ctime_ns));self.assertEqual(evidence['length'],'13');self.assertEqual(links,1)
    link=fixture/'alias';link.symlink_to(p)
    with self.assertRaises(ValueError):sampler.stat(str(link))
    self.assertEqual(sampler.stat(str(link),follow=True),(evidence,links))
    absent=fixture/'missing-final-component'
    self.assertIsNone(sampler.stat(str(absent),missing=True))
    with self.assertRaises(ValueError):sampler.stat(str(absent))
    dangling=fixture/'dangling';dangling.symlink_to(absent)
    with self.assertRaises(ValueError):sampler.stat(str(dangling),missing=True)
 def test_only_exact_qualified_missing_final_envelopes_are_absence(self):
  path="/fixed/missing ' quoted"
  for prefix in ('cannot statx',"can't stat"):
   expected=("stat: "+prefix+" '"+path+"': No such file or directory\n").encode()
   run=Mock(return_value=(1,b'',expected));sampler=s.Sampler(Mock(),time.monotonic()+5,run=run)
   self.assertIsNone(sampler.stat(path,missing=True));self.assertEqual(run.call_count,1)
   for code,out,err in [(0,b'',expected),(2,b'',expected),(1,b'partial',expected),
      (1,b'',expected+b'\n'),(1,b'',expected+b'extra diagnostic\n'),
      (1,b'',expected.replace(b'missing',b'another')),
      (1,b'',expected.replace(b'No such file or directory',b'Permission denied')),
      (1,b'',expected.replace(b'No such file or directory',b'Not a directory')),
      (1,b'',expected.replace(b'stat: ',b'')),(1,b'',expected[:-1])]:
    with self.subTest(prefix=prefix,code=code,out=out,err=err):
     run=Mock(return_value=(code,out,err));sampler=s.Sampler(Mock(),time.monotonic()+5,run=run)
     with self.assertRaises(ValueError):sampler.stat(path,missing=True)
     self.assertEqual(run.call_count,1)
 def test_collected_private_dto_and_candidate_semantics_cross_the_actual_node_boundary(self):
  root=Path(__file__).resolve().parents[2]
  imports=json.dumps((root/'host/service-stop-profiles.mjs').as_uri());private=json.dumps((root/'host/service-stop-private.mjs').as_uri())
  script="import {matchesCandidateStopProfile} from "+imports+";import {parseServiceStopRaw,serviceStopSampleDigest,admitServiceStopProfile} from "+private+";let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);parseServiceStopRaw(v.raw,'review');if(!matchesCandidateStopProfile(v.observation,v.raw,v.tuple)||serviceStopSampleDigest(v.observation,v.tuple.profile,v.raw)!==v.digest||admitServiceStopProfile(v.observation,v.raw)!==null)process.exit(1);"
  for profile in s.APPS:
   f=Files(profile);raw,digest=f.sampler().bracket(profile,f.vector['observation'],t.empty_raw)
   body=dict(raw=raw,digest=digest,observation=f.vector['observation'],tuple=f.vector['tuple'])
   r=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(body),capture_output=True,text=True,timeout=10)
   self.assertEqual(r.returncode,0,r.stderr)
 def test_actual_cli_disabled_stop_never_uses_host_config_or_ssh(self):
  v=VECTORS[0];q=dict(connection_id=v['observation']['connection_id'],boot_id=v['observation']['boot_id'],selector='stop',budget_ms=12000,expected=dict(profile='ordinary-manual',sample_sha256=v['sample_sha256']))
  r=subprocess.run([sys.executable,t.__file__],input=json.dumps(q),capture_output=True,text=True,timeout=3,env=dict(os.environ,MANAGER_WIRED_CONFIG='THIS_MUST_NOT_BE_READ'))
  self.assertEqual(r.returncode,0);value=json.loads(r.stdout);self.assertEqual(value['status'],'unconfigured');self.assertEqual(value['service_stop_raw']['command'],'not-submitted');self.assertEqual(r.stderr,'')
 def test_cross_language_canonical_digest(self):
  for v in VECTORS:self.assertEqual(s.canonical_digest(v['observation'],v['tuple']['profile'],v['raw']),v['sample_sha256'])
 def test_both_fixed_path_captures_and_stable_bracket(self):
  for profile in s.APPS:
   f=Files(profile);raw,digest=f.sampler().bracket(profile,f.vector['observation'],t.empty_raw)
   self.assertEqual(raw['process']['argv'],[s.APPS[profile]]);self.assertEqual(raw['configuration'],dict(read='not-read',effective_mode='unverified'));self.assertEqual(len(digest),64)
   self.assertEqual(raw['lease_observation'],'occupied' if profile=='resident-installed' else 'absent-final-component')
   self.assertFalse(any('/environment' in c or '/config.json' in c or t.STOP_COMMAND in c for c in f.commands))
 def test_permission_error_is_never_absence_and_unsafe_parent_refuses(self):
  f=Files();f.permission=True
  with self.assertRaises(ValueError):f.sampler().lease()
  f=Files();f.bad_parent=True
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
 def test_file_replacement_and_unexpected_argv_refuse(self):
  f=Files();serial=iter([2,3]);f.change=lambda:next(serial)
  with self.assertRaises(ValueError):f.sampler().file(s.APPS[f.profile],134217728)
  f=Files();f.extra_argv=True
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
 def test_live_namespace_drift_refuses_existing_resident_record(self):
  f=Files('resident-installed');f.namespace_drift=True
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
 def test_package_conflicts_allow_only_the_two_protected_missing_components(self):
  for directory in (False,True):
   f=Files('resident-installed');f.legacy_directory=directory;f.sampler().capture(f.profile,t.empty_raw)
  for field in ('legacy_profile','shadow'):
   f=Files('resident-installed');f.legacy_directory=True;setattr(f,field,True)
   with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
 def test_original_and_current_companion_watchdog_are_explicitly_zero(self):
  f=Files('resident-installed');f.raw['companion']['policy']['WatchdogUSec']='1s'
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
  f=Files('resident-installed');l=json.loads(f.contents[s.LEASE]);v=json.loads(l['companion']);v['snapshot']=v['snapshot'].replace('WatchdogUSec=0\n','WatchdogUSec=1s\n');l['companion']=json.dumps(v);f.contents[s.LEASE]=json.dumps(l).encode()
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
 def test_companion_terminal_group_identity_and_enoent_do_not_transfer_ownership(self):
  for field,value in [('companion_state','populated'),('companion_replaced',True),('companion_permission',True)]:
   f=Files('resident-installed');setattr(f,field,value)
   if field=='companion_replaced':f.companion_state='empty-original'
   with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
  f=Files('resident-installed');l=json.loads(f.contents[s.LEASE]);v=json.loads(l['companion']);fields=dict(line.split('=',1) for line in v['snapshot'].splitlines());state=f.raw['companion']['state']
  for key in ('InvocationID','ExecMainPID','ExecMainStartTimestampMonotonic','ControlGroup'):state[key]=fields[key]
  f.companion_state='empty-original';r=f.sampler().capture(f.profile,t.empty_raw);self.assertEqual(r['companion_group'],'empty-original')
  state['ControlGroup']=''
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
 def test_fixed_vendor_projection_and_shared_deadline_refuse_before_any_stop(self):
  for name in ('stock','companion'):
   f=Files('resident-installed');f.raw['vendor_policy'][name]['Nice']='999'
   with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
   self.assertFalse(any(t.STOP_COMMAND==c for c in f.commands))
  f=Files('resident-installed');sampler=f.sampler();sampler.deadline=time.monotonic()-1
  with self.assertRaises(Exception):sampler.capture(f.profile,t.empty_raw)
 def test_vendor_raw_duplicate_unknown_missing_and_oversized_fields_refuse(self):
  f=Files('resident-installed');good=''.join(k+'='+v+'\n' for k,v in f.raw['vendor_policy']['companion'].items()).encode()
  for data in [good+b'Id=rm-sync.service\n',good+b'SECRET=CANARY\n',good.replace(b'Nice=19\n',b''),good.replace(b'Nice=19\n',b'Nice='+b'x'*4097+b'\n')]:
   with self.assertRaises(ValueError):s.Sampler(Mock(),time.monotonic()+12,run=lambda *_:(0,data,b'')).vendor_policy(s.COMPANION)
 def test_companion_baseline_and_second_sample_drift_refuse(self):
  f=Files('resident-installed');l=json.loads(f.contents[s.LEASE]);v=json.loads(l['companion']);v['group']['context']['boot']='00000000-0000-4000-8000-000000000099';l['companion']=json.dumps(v);f.contents[s.LEASE]=json.dumps(l).encode()
  with self.assertRaises(ValueError):f.sampler().capture(f.profile,t.empty_raw)
  f=Files('resident-installed');capture=f.sampler().capture;sampler=f.sampler();calls=[]
  def change(profile,empty):
   r=capture(profile,empty)
   if calls:r['vendor_policy']['companion']['After']='changed'
   calls.append(True);return r
  sampler.capture=change
  with self.assertRaises(ValueError):sampler.bracket(f.profile,f.vector['observation'],t.empty_raw)
 def test_property_duplicates_missing_hooks_and_unknown_units_refuse(self):
  f=Files();f.raw['buddy']['stop_extra']['ExecStop']='secret hook'
  with self.assertRaises(ValueError):f.sampler().service(s.BUDDY)
  for out in [b'Id=reader-buddy.service\nId=reader-buddy.service\n',b'Unknown=secret\n',b'Id=reader-buddy.service\n']:
   with self.assertRaises(ValueError):s.Sampler(Mock(),time.monotonic()+12,run=lambda *_:(0,out,b'')).service(s.BUDDY)
  with self.assertRaises(ValueError):f.sampler().service('foreign.service')
 def test_metadata_framing_and_nanosecond_precision(self):
  f=Files();meta,n=s.metadata(f.meta('/etc/systemd/system/reader-buddy.service'))
  self.assertEqual(meta['mtime_ns'],'1767225600000000001');self.assertEqual(n,1)
  for data in [b'bad',f.meta('/').replace(b' +0000',b' UTC'),f.meta('/').replace(b'1 1 0',b'-1 1 0'),
    f.meta('/').replace(b'\n',b'\\n'),f.meta('/')+b'\n',f.meta('/').replace(b'.000000001',b'.000001')]:
   with self.assertRaises(ValueError):s.metadata(data)
 def test_actual_command_drain_bounds_empty_stdin_and_deadline(self):
  for out,err,cap,ok in [(b'abc',b'',3,True),(b'abcd',b'',3,False),(b'',b'x'*8193,3,False)]:
   c=Channel(out,err);transport=Mock();transport.open_session.return_value=c
   if ok:self.assertEqual(s.run_fixed(transport,t.STOP_COMMAND,time.monotonic()+12,cap),(0,b'abc',b''))
   else:
    with self.assertRaises(ValueError):s.run_fixed(transport,t.STOP_COMMAND,time.monotonic()+12,cap)
   self.assertTrue(c.write_closed);self.assertTrue(c.closed);self.assertEqual(c.commands,[t.STOP_COMMAND])
  transport=Mock()
  with self.assertRaises(Exception):s.run_fixed(transport,t.STOP_COMMAND,time.monotonic()-1)
  transport.open_session.assert_not_called()
 def test_current_inactive_inspection_needs_no_lifecycle_sampler(self):
  v=VECTORS[0];request=dict(connection_id=v['observation']['connection_id'],boot_id=v['observation']['boot_id'],selector='inspect',budget_ms=12000,expected=None)
  before=dict(boot_id=request['boot_id'],service=dict(LoadState='loaded',ActiveState='inactive',SubState='dead'))
  with patch.object(t,'QUALIFIED_PROFILES',('ordinary-manual',)),patch.object(t.shared,'inspect',return_value=before),patch.object(t,'Sampler') as sampler:
   r=t.execute(Mock(),request);sampler.assert_not_called();self.assertEqual(r['service']['ActiveState'],'inactive');self.assertEqual(r['_service_stop_raw']['command'],'not-submitted');self.assertIsNone(r['_service_stop_raw']['reason'])
 def test_actual_main_preserves_possible_submission_on_send_and_post_read_failure(self):
  v=VECTORS[0];q=dict(connection_id=v['observation']['connection_id'],boot_id=v['observation']['boot_id'],selector='stop',budget_ms=12000,expected=dict(profile='ordinary-manual',sample_sha256=v['sample_sha256']))
  for where in ('send','post-read'):
   output=io.StringIO();before=dict(boot_id=q['boot_id'])
   observe=lambda _config,inspection,expected_connection:inspection(Mock())
   with patch.object(t,'QUALIFIED_PROFILES',('ordinary-manual',)),patch.object(t.sys,'platform','linux'),patch.dict(sys.modules,{'paramiko':SimpleNamespace(__version__='5.0.0')}),patch.dict(os.environ,{'MANAGER_WIRED_CONFIG':'FIXTURE_ONLY'}),patch.object(t.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(q).encode()))),patch.object(t.sys,'stdout',output),patch.object(t.shared,'load_config',return_value={}),patch.object(t.shared,'observe',side_effect=observe),patch.object(t.shared,'inspect',side_effect=[before,ValueError('PRIVATE_POST_READ')]),patch.object(t.Sampler,'bracket',return_value=(copy.deepcopy(v['raw']),v['sample_sha256'])),patch.object(t,'run_fixed',side_effect=ValueError('PRIVATE_SEND') if where=='send' else None,return_value=(0,b'',b'')) as run:
    t.main();self.assertEqual(run.call_count,1)
   result=json.loads(output.getvalue());self.assertEqual(result['service_stop_raw']['command'],'unknown');self.assertIsNone(result['observation']);self.assertNotIn('PRIVATE_',output.getvalue())
 def test_qualified_fixture_stop_rechecks_digest_and_separates_acknowledgment(self):
  v=VECTORS[0];raw=v['raw'];request=dict(connection_id=v['observation']['connection_id'],boot_id=v['observation']['boot_id'],selector='stop',budget_ms=12000,expected=dict(profile='ordinary-manual',sample_sha256=v['sample_sha256']))
  for code,out,err,accepted in [(0,b'',b'',True),(1,b'',b'',False),(0,b'extra',b'',False)]:
   called=[]
   with patch.object(t,'QUALIFIED_PROFILES',('ordinary-manual',)),patch.object(t.shared,'inspect',return_value=dict(boot_id=request['boot_id'])),patch.object(t.Sampler,'bracket',return_value=(copy.deepcopy(raw),v['sample_sha256'])),patch.object(t,'run_fixed',return_value=(code,out,err)) as run:
    result=t.execute(Mock(),request,on_submission=lambda:called.append(True))['_service_stop_raw'];self.assertEqual(result['command'],'request-accepted' if accepted else 'unknown');self.assertEqual(called,[True]);self.assertEqual(run.call_args.args[1],t.STOP_COMMAND)
  with patch.object(t,'QUALIFIED_PROFILES',('ordinary-manual',)),patch.object(t.shared,'inspect',return_value=dict(boot_id=request['boot_id'])),patch.object(t.Sampler,'bracket',return_value=(copy.deepcopy(raw),'f'*64)),patch.object(t,'run_fixed') as run:
   with self.assertRaises(Exception):t.execute(Mock(),request)
   run.assert_not_called()
  self.assertEqual(t.QUALIFIED_PROFILES,())

class BoundedByteReads(unittest.TestCase):
 def test_literal_bytes_and_exact_cap(self):
  for value in (b'',b'a',b'a\0b\n'):
   run=Mock(return_value=(0,value,b''));sampler=s.Sampler(Mock(),time.monotonic()+5,run=run)
   self.assertEqual(sampler.text('/proc/20/cmdline',4),value)
   script=shlex.split(run.call_args.args[1])[-1]
   self.assertEqual(script,'dd bs=1 count=5 if=/proc/20/cmdline 2>/dev/null')
   self.assertEqual(run.call_args.args[3],5)
 def test_excess_nonzero_partial_missing_and_stderr_refuse(self):
  for result in ((0,b'12345',b''),(1,b'123',b''),(127,b'',b''),(0,b'123',b'unexpected')):
   run=Mock(return_value=result);sampler=s.Sampler(Mock(),time.monotonic()+5,run=run)
   with self.assertRaises(ValueError):sampler.text('/proc/20/stat',4)
   self.assertEqual(run.call_count,1)
 def test_input_operand_is_one_shell_word(self):
  path="/fixed/a b'c;$(false)"
  run=Mock(return_value=(0,b'',b''));s.Sampler(Mock(),time.monotonic()+5,run=run).text(path,4)
  script=shlex.split(run.call_args.args[1])[-1]
  self.assertEqual(shlex.split(script),['dd','bs=1','count=5','if='+path,'2>/dev/null'])

if __name__=='__main__':unittest.main()
