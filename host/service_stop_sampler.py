"""Fixed-path read-only candidate sampling. No production profile is enabled here.

The collector uses common GNU/BusyBox stat formats. Unsupported utilities,
properties, permissions or framing refuse; sampled checks do not defeat hostile
root replacement or transfer the native owner's FD-backed group authority.
"""
import base64
import calendar
from datetime import datetime
import hashlib
import json
from pathlib import PurePosixPath, Path
import re
import shlex
import socket
import time
import wired_observer as shared
import service_stop_hooks as hooks

BUDDY = 'reader-buddy.service'
HELPER = 'reader-buddy-stock-recovery.service'
STOCK = 'xochitl.service'
COMPANION = 'rm-sync.service'
LEASE_DIRECTORY = '/run/reader-buddy-resident'
LEASE = LEASE_DIRECTORY + '/activation.json'
SLOTS = dict(buddy_unit='/usr/lib/systemd/system/reader-buddy.service',
             recovery_profile='/home/root/.local/lib/remarkable-buddies/resident-recovery.json',
             native_profile='/home/root/.local/lib/remarkable-buddies/resident-profile.json',
             adapter='/home/root/.local/lib/remarkable-buddies/libremarkable-resident.so',
             helper_unit='/usr/lib/systemd/system/reader-buddy-stock-recovery.service',
             stock_executable='/usr/bin/xochitl', stock_unit='/usr/lib/systemd/system/xochitl.service',
             stock_dropin='/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf',
             companion_executable='/usr/bin/rm-sync', companion_unit='/usr/lib/systemd/system/rm-sync.service',
             companion_dropin='/usr/lib/systemd/system/rm-sync.service.d/rm-sync-service-override.conf')
APPS = {'ordinary-manual':'/opt/bin/reader-buddy',
        'resident-installed':'/home/root/.local/lib/remarkable-buddies/reader-buddy'}
ORDINARY_ALIAS_TARGET = '/home/root/.local/lib/reader-buddy/ordinary/reader-buddy'
CATALOG = json.loads(Path(__file__).with_name('service-stop-properties.json').read_text())
VENDOR = json.loads(Path(__file__).with_name('service-stop-vendor-policy.json').read_text())
TEXT_SECTIONS = ('state','policy','stop_extra')
PROPERTIES = [k for section in TEXT_SECTIONS for k in CATALOG[section]]
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/usr/bin:/bin LC_ALL=C /bin/sh -c '
# Both implementations preserve literal internal newlines and append one final
# newline for -c. Do not use --printf or encode literal backslash-n separators.
STAT_FORMAT = '%d %i %u %g %f %s %h\n%y\n%z'
FRAME_END = " && printf '\\000'"


def refuse():
    raise ValueError('service sample refused')


def canonical_digest(observation, profile, raw):
    names = ('buddy','helper','stock','process','platform','artifacts',
             'recovery_profile_base64','lease_base64','lease_observation','configuration',
             'companion','companion_group','vendor_policy')
    v = dict(connection_id=observation['connection_id'],boot_id=observation['boot_id'],profile=profile,
             **{k:raw[k] for k in names})
    if 'ordinary_alias' in raw:v['ordinary_alias']=raw['ordinary_alias']
    return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def run_fixed(transport, command, deadline, cap=32768):
    """One fixed command, empty stdin, shared remaining deadline and bounded drains."""
    remaining = deadline-time.monotonic()
    if remaining <= 0:
        raise shared.Refusal('timeout')
    channel = transport.open_session(timeout=min(2,remaining))
    output, error = bytearray(), bytearray()
    try:
        channel.settimeout(min(2,remaining))
        channel.exec_command(command)
        channel.shutdown_write()
        command_deadline = min(deadline,time.monotonic()+8)
        # Available status and temporarily empty buffers do not establish EOF.
        # Drain each stream fairly until an actual empty read, then require status.
        channel.settimeout(0.0)
        stdout_done = stderr_done = False
        while True:
            if time.monotonic() >= command_deadline:
                raise shared.Refusal('timeout')
            progressed = False
            if not stdout_done:
                try:
                    data = channel.recv(4096)
                except socket.timeout:
                    pass
                else:
                    stdout_done = not data
                    output.extend(data)
                    progressed = True
                    if len(output)>cap:refuse()
            if not stderr_done:
                try:
                    data = channel.recv_stderr(4096)
                except socket.timeout:
                    pass
                else:
                    stderr_done = not data
                    error.extend(data)
                    progressed = True
                    if len(error)>8192:refuse()
            if stdout_done and stderr_done and channel.exit_status_ready():break
            if not progressed:
                time.sleep(min(.005,max(0,command_deadline-time.monotonic())))
        code=channel.recv_exit_status()
        if time.monotonic()>=deadline:raise shared.Refusal('timeout')
        return code,bytes(output),bytes(error)
    finally:
        output[:]=b'\0'*len(output);error[:]=b'\0'*len(error)
        channel.close()


def _framed_script(*commands):
    # Only for fixed reads that require exit 0, empty stderr and NUL-free
    # output. Each trailing separator is emitted after its command succeeds.
    return ' && '.join(command + FRAME_END for command in commands)


def _frames(reply, caps, deadline):
    if time.monotonic() >= deadline:
        raise shared.Refusal('timeout')
    code, out, err = reply
    if type(code) is not int or code or type(err) is not bytes or err or type(out) is not bytes:
        refuse()
    parts = out.split(b'\0', len(caps) + 1)
    if len(parts) != len(caps) + 1 or parts[-1]:
        refuse()
    results = parts[:-1]
    if any(len(part) > cap for part, cap in zip(results, caps, strict=True)):
        refuse()
    return results


def timestamp(value):
    m=re.fullmatch(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.(\d{9}) ([+-])(\d\d)(\d\d)',value)
    if not m:refuse()
    offset=(int(m[4])*60+int(m[5]))*60*(1 if m[3]=='+' else -1)
    seconds=calendar.timegm(datetime.strptime(m[1],'%Y-%m-%d %H:%M:%S').timetuple())-offset
    if seconds<0:refuse()
    return str(seconds*1000000000+int(m[2]))


def metadata(raw):
    try:
        fields,mtime,ctime,empty=raw.decode('ascii').split('\n')
        values=fields.split(' ')
        if empty or len(values)!=7 or any(not re.fullmatch('0|[1-9][0-9]*',v) for i,v in enumerate(values) if i!=4):refuse()
        device,inode,uid,gid,mode,length,nlink=values
        if not re.fullmatch('[a-f0-9]+',mode):refuse()
        result=dict(device=device,inode=inode,uid=uid,gid=gid,mode=str(int(mode,16)),length=length,
                    mtime_ns=timestamp(mtime),ctime_ns=timestamp(ctime))
        if int(device)==0 or int(inode)==0 or int(nlink)==0 or any(int(v)>=2**64 for v in result.values()):refuse()
        return result,int(nlink)
    except (UnicodeError,ValueError,OverflowError):refuse()


class TypedHookRefusal(ValueError):
    """Value-free fatal refusal: never try another candidate after this group fails."""


UNIT_OBJECTS = {unit: '/org/freedesktop/systemd1/unit/' + encoded for unit,encoded in (
    (BUDDY,'reader_2dbuddy_2eservice'),
    (HELPER,'reader_2dbuddy_2dstock_2drecovery_2eservice'),
    (STOCK,'xochitl_2eservice'),(COMPANION,'rm_2dsync_2eservice'))}


class _TypedHooks:
    def __init__(self, sampler, maximum):
        self.sampler,self.maximum,self.commands = sampler,maximum,0
        self.owner,self.bus,self.client = None,None,None
        self.units = []

    def run(self, command, cap=4096, count=1):
        try:
            if self.commands + count > self.maximum or time.monotonic() >= self.sampler.deadline:
                raise ValueError()
            self.commands += count
            reply = self.sampler.run(self.sampler.transport,command,self.sampler.deadline,cap)
            code,out,err = reply
            if (time.monotonic() >= self.sampler.deadline or type(code) is not int
                    or type(out) is not bytes or type(err) is not bytes
                    or len(out)>cap or len(err)>8192):
                raise ValueError()
            return reply
        except Exception:
            raise TypedHookRefusal('typed hook observation refused') from None

    @staticmethod
    def call_script(destination, path, interface, method, signature='', *arguments):
        return shlex.join((*hooks.CALL_PREFIX,destination,path,interface,method,signature,*arguments))

    def dbus_script(self, method, signature='', *arguments):
        return self.call_script('org.freedesktop.DBus','/org/freedesktop/DBus',
                                'org.freedesktop.DBus',method,signature,*arguments)

    def bus_replies(self, scripts, cap=4096):
        if len(scripts) == 1:
            return [self.run(hooks.BUS_PREFIX + shlex.quote('exec ' + scripts[0]), cap)]
        # Retain the original allowance for logical typed calls in a group.
        count = len(scripts)
        script = _framed_script(*scripts)
        reply = self.run(hooks.BUS_PREFIX + shlex.quote(script), count * (cap + 1), count)
        return [(0, out, b'') for out in _frames(reply, (cap,) * count, self.sampler.deadline)]

    def identity(self):
        value = hooks.identity(*self.run(hooks.PREFIX+shlex.quote(hooks.IDENTITY_SCRIPT)))
        if value['state']!='present' or value['metadata'][-1]['bytes']!=hooks.EXPECTED_BYTES or value['sha256']!=hooks.EXPECTED_SHA256:
            raise ValueError()
        return value

    def start(self):
        self.client = self.identity()
        bus, owner = self.bus_replies((self.dbus_script('GetId'),
                                       self.dbus_script('GetNameOwner','s','org.freedesktop.systemd1')))
        self.bus = hooks.bus_id(*bus)
        self.owner = hooks.bus_owner(*owner)
        [pid] = self.bus_replies((self.dbus_script('GetConnectionUnixProcessID','s',self.owner),))
        hooks.pid_one(*pid)

    def unit(self, unit):
        if unit not in UNIT_OBJECTS or not hooks.owner_valid(self.owner):
            raise ValueError()
        [reply] = self.bus_replies((self.call_script(self.owner,'/org/freedesktop/systemd1',
                                      'org.freedesktop.systemd1.Manager','GetUnit','s',unit),))
        if hooks.scalar(*reply,'o') != UNIT_OBJECTS[unit]:
            raise ValueError()

    def read(self, unit):
        if unit not in self.units:
            self.unit(unit)
            self.units.append(unit)
        scripts = tuple(self.call_script(self.owner,UNIT_OBJECTS[unit],'org.freedesktop.DBus.Properties',
                                         'Get','ss','org.freedesktop.systemd1.Service',prop)
                        for prop in hooks.PROPERTIES)
        result = {}
        for prop, reply in zip(hooks.PROPERTIES, self.bus_replies(scripts, 32768), strict=True):
            observation = hooks.decode_hook(prop,reply[1],reply[2],reply[0],complete=True)
            if observation != dict(property=prop,observation='observed-empty',type_verified=True,reason='typed-empty'):
                raise ValueError()
            result[prop] = observation
        return result

    def finish(self):
        for unit in self.units:
            self.unit(unit)
        pid, owner, bus = self.bus_replies((self.dbus_script('GetConnectionUnixProcessID','s',self.owner),
                                            self.dbus_script('GetNameOwner','s','org.freedesktop.systemd1'),
                                            self.dbus_script('GetId')))
        hooks.pid_one(*pid)
        if hooks.bus_owner(*owner) != self.owner:
            raise ValueError()
        if hooks.bus_id(*bus) != self.bus or self.identity() != self.client:
            raise ValueError()

    def clear(self):
        self.owner,self.bus,self.client = None,None,None
        self.units.clear()


class Sampler:
    def __init__(self,transport,deadline,run=run_fixed):
        self.transport,self.deadline,self.run=transport,deadline,run
        self._hooks = None

    def _typed_group(self, operation, maximum):
        if self._hooks is not None:refuse()
        group = _TypedHooks(self,maximum)
        self._hooks = group
        try:
            try:group.start()
            except Exception:raise TypedHookRefusal('typed hook observation refused') from None
            result = operation()
            try:group.finish()
            except Exception:raise TypedHookRefusal('typed hook observation refused') from None
            return result
        finally:
            group.clear()
            self._hooks = None

    def command(self,script,cap=32768):
        return self.run(self.transport,PREFIX+shlex.quote(script),self.deadline,cap)

    def _read_frames(self, *reads):
        scripts, caps = zip(*reads, strict=True)
        reply = self.command(_framed_script(*scripts), sum(caps) + len(caps))
        return _frames(reply, caps, self.deadline)

    @staticmethod
    def _stat_script(path,follow=False,allow_link=False):
        # Every caller uses a compiled fixed path or a range-checked MainPID path.
        command=('stat -L ' if follow else 'stat ' if allow_link else 'test ! -L '+shlex.quote(path)+' && stat ')
        return command+'-c '+shlex.quote(STAT_FORMAT)+' -- '+shlex.quote(path)

    def stat(self,path,follow=False,missing=False,allow_link=False):
        code,out,err=self.command(self._stat_script(path,follow,allow_link),4096)
        if code:
            # Exact C-locale envelopes, under independently bracketed parents.
            expected=tuple(("stat: "+prefix+" '"+path+"': No such file or directory\n").encode()
                           for prefix in ('cannot statx', "can't stat"))
            if missing and code==1 and not out and err in expected:return None
            refuse()
        if err:refuse()
        return metadata(out)

    def _stat_chain(self,scripts):
        code,out,err=self.command(' && '.join(scripts),4096)
        if code or err:refuse()
        return self._stat_rows(out,len(scripts))

    @staticmethod
    def _stat_rows(out,count):
        lines=out.split(b'\n')
        if len(lines)!=3*count+1 or lines[-1]!=b'':refuse()
        return [metadata(b'\n'.join(lines[i:i+3])+b'\n') for i in range(0,3*count,3)]

    @staticmethod
    def _parent_paths(path):
        return [str(parent) for parent in reversed(PurePosixPath(path).parents)]

    @staticmethod
    def _validate_parents(parents,rows):
        result=[]
        for p,info in zip(parents,rows,strict=True):
            f=info[0];mode=int(f['mode'])
            if f['uid']!='0' or f['gid']!='0' or mode&0o170000!=0o040000 or mode&0o022:refuse()
            result.append((p,info))
        return result

    def parents(self,path):
        parents=self._parent_paths(path)
        if not parents:return []
        # The host validates parents before any access to leaf contents.
        rows=self._stat_chain([self._stat_script(p) for p in parents])
        return self._validate_parents(parents,rows)

    def file(self,path,limit=32768,contents=False,private=False):
        parents=self.parents(path);before=self.stat(path)
        f,nlink=before;mode=int(f['mode'])
        if f['uid']!='0' or f['gid']!='0' or mode&0o170000!=0o100000 or mode&0o022 or int(f['length'])>limit:refuse()
        if private and (mode&0o7777!=0o600 or nlink!=1 or int(f['length'])==0):refuse()
        tail=[self._stat_script(path),*(self._stat_script(p) for p,_ in parents)]
        if contents:
            out=self.text(path,limit)
            if len(out)!=int(f['length']):refuse()
            checksum=hashlib.sha256(out).hexdigest()
            closing=self._stat_chain(tail)
        else:
            value,rows=self._read_frames(
                ('sha256sum -- '+shlex.quote(path),4096),
                (' && '.join(tail),4096))
            text=value.decode('ascii')
            if not re.fullmatch('[a-f0-9]{64}  '+re.escape(path)+'\n',text):refuse()
            checksum=text[:64]
            out=None
            closing=self._stat_rows(rows,len(tail))
        if closing!=[before,*(row for _,row in parents)]:refuse()
        return dict(f,sha256=checksum),out

    def ordinary_alias(self, app):
        if app != APPS['ordinary-manual']:refuse()
        return self._ordinary_alias_leaf(app,self.parents(app))

    def _ordinary_alias_leaf(self, app, parents):
        before=self.stat(app,allow_link=True)
        f,nlink=before
        mode=int(f['mode'])
        if mode&0o170000==0o100000:return None
        expected=ORDINARY_ALIAS_TARGET.encode('ascii')
        if f['uid']!='0' or f['gid']!='0' or mode!=0o120777 or nlink!=1 or int(f['length'])!=len(expected):refuse()
        code,literal,err=self.command('readlink -- '+shlex.quote(app),256)
        if code or err or literal!=expected+b'\n':refuse()
        # These are metadata reads only. Validate the target parents before
        # returning evidence that allows access to any target leaf contents.
        target_paths=self._parent_paths(ORDINARY_ALIAS_TARGET)
        target_script=' && '.join(self._stat_script(p) for p in target_paths)
        tail=[self._stat_script(app,allow_link=True),*(self._stat_script(p) for p,_ in parents)]
        target_rows,tail_rows=self._read_frames((target_script,4096),(' && '.join(tail),4096))
        target_parents=self._validate_parents(target_paths,self._stat_rows(target_rows,len(target_paths)))
        if self._stat_rows(tail_rows,len(tail))!=[before,*(row for _,row in parents)]:refuse()
        def parent_digest(rows):
            return hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
        return dict(f,links='1',literal=ORDINARY_ALIAS_TARGET,
                    link_parents_sha256=parent_digest(parents),
                    target_parents_sha256=parent_digest(target_parents))

    @staticmethod
    def _text_script(path,cap):
        # Kernel/platform identity files are read-only sources, not trust anchors.
        # bs=1 makes count a byte limit even for short procfs reads. Probe one
        # excess byte; exact-cap EOF is valid, excess and nonzero exits refuse.
        # POSIX dd writes normal counters to stderr: suppress those, preserving
        # its exit status (including read errors and a missing utility). No retry.
        return 'dd bs=1 count='+str(cap+1)+' '+shlex.quote('if='+path)+' 2>/dev/null'

    def text(self,path,cap):
        code,out,err=self.command(self._text_script(path,cap),cap+1)
        if code or err or len(out)>cap:refuse()
        return out

    def service(self,unit):
        if unit not in UNIT_OBJECTS:refuse()
        if self._hooks is None:
            return self._typed_group(lambda:self.service(unit),12)
        command='/bin/systemctl --system --no-pager --no-ask-password --all show '+' '.join('--property='+k for k in PROPERTIES)+' -- '+unit
        code,out,err=self.run(self.transport,command,self.deadline,32768)
        if code or err:refuse()
        result={}
        for line in out.decode('ascii').splitlines():
            key,separator,value=line.partition('=')
            if not separator or key not in PROPERTIES or key in result or len(value)>4096 or any(ord(c)<32 or ord(c)>126 for c in value):refuse()
            result[key]=value
        if set(result)!=set(PROPERTIES) or result['Id']!=unit:refuse()
        value={section:{k:result[k] for k in CATALOG[section]} for section in TEXT_SECTIONS}
        try:value['hooks']=self._hooks.read(unit)
        except Exception:raise TypedHookRefusal('typed hook observation refused') from None
        if len(json.dumps(value,separators=(',',':')).encode())>16384:refuse()
        return value

    def absent(self,path):
        parents=self.parents(path)
        if self.stat(path,missing=True) is not None or self.parents(path)!=parents or self.stat(path,missing=True) is not None:refuse()

    def package_conflicts(self):
        # Only these two fixed missing-component cases are supported.
        legacy='/home/root/.local/lib/reader-buddy'
        parents=self.parents(legacy);directory=self.stat(legacy,missing=True)
        if directory is None:
            if self.parents(legacy)!=parents or self.stat(legacy,missing=True) is not None:refuse()
        else:
            self.absent(legacy+'/resident-recovery.json')
            if self.stat(legacy)!=directory or self.parents(legacy)!=parents:refuse()
        for unit in (BUDDY,HELPER):self.absent('/etc/systemd/system/'+unit)

    def vendor_policy(self,unit):
        name={STOCK:'stock',COMPANION:'companion'}.get(unit)
        if name is None:refuse()
        command='/bin/systemctl --system --no-pager --no-ask-password --all show '+' '.join('--property='+k for k in VENDOR['keys'])+' -- '+unit
        code,out,err=self.run(self.transport,command,self.deadline,32768)
        if code or err:refuse()
        result={}
        for line in out.decode('ascii').splitlines():
            key,sep,value=line.partition('=')
            if not sep or key not in VENDOR['keys'] or key in result or len(value)>4096 or any(ord(c)<32 or ord(c)>126 for c in value):refuse()
            result[key]=value
        if set(result)!=set(VENDOR['keys']) or len(json.dumps(result,separators=(',',':')).encode())>16384:refuse()
        for key,wanted in VENDOR[name].items():
            got=result[key]
            if key in VENDOR['token_sets']:
                a,b=got.split(),wanted.split()
                if len(a)!=len(set(a)) or len(b)!=len(set(b)) or set(a)!=set(b):refuse()
            elif got!=wanted:refuse()
        return result

    def process(self,service,app,artifact,argv0=None):
        argv0=app if argv0 is None else argv0
        pid=service['state']['MainPID']
        if not re.fullmatch('[1-9][0-9]*',pid) or not 1<int(pid)<2**32:refuse()
        root='/proc/'+pid
        def start(raw):
            stat=raw.decode('ascii')
            if stat.split(' ',1)[0]!=pid or ')' not in stat:refuse()
            fields=stat.rsplit(')',1)[1].split()
            if len(fields)<20 or fields[0] in ('Z','X','x') or not re.fullmatch('[1-9][0-9]*',fields[19]):refuse()
            return fields[19]
        before=start(self.text(root+'/stat',4096));cmd=self.text(root+'/cmdline',len(argv0)+1)
        if cmd!=argv0.encode()+b'\0':refuse()
        code,exe,err=self.command('readlink -- '+shlex.quote(root+'/exe'),4096)
        if code or err or exe!=app.encode()+b'\n':refuse()
        exe_stat=self._stat_script(root+'/exe',follow=True)
        status,membership,opening=self._read_frames(
            (self._text_script(root+'/status',16384),16384),
            (self._text_script(root+'/cgroup',16384),16384),
            (exe_stat,4096))
        status=status.decode('ascii').splitlines()
        for key in ('Uid:','Gid:'):
            rows=[v.split()[1:] for v in status if v.startswith(key)]
            if rows!=[['0','0','0','0']]:refuse()
        membership=membership.decode('ascii').splitlines()
        if membership.count('0::/system.slice/'+BUDDY)!=1:refuse()
        running=metadata(opening)[0]
        if running!= {k:v for k,v in artifact.items() if k!='sha256'}:refuse()
        checksum,closing,end=self._read_frames(
            ('sha256sum -- '+shlex.quote(root+'/exe'),4096),
            (exe_stat,4096),
            (self._text_script(root+'/stat',4096),4096))
        if checksum!=(artifact['sha256']+'  '+root+'/exe\n').encode() or metadata(closing)[0]!=running or start(end)!=before:refuse()
        return dict(pid=pid,start_ticks=before,uid='0',gid='0',executable=app,argv=[argv0],sha256=artifact['sha256'])

    def lease(self):
        parents=self.parents(LEASE_DIRECTORY);directory=self.stat(LEASE_DIRECTORY,missing=True)
        if directory is None:
            if self.parents(LEASE_DIRECTORY)!=parents or self.stat(LEASE_DIRECTORY,missing=True) is not None:refuse()
            return 'absent-final-component',None
        f=directory[0]
        if f['uid']!='0' or f['gid']!='0' or int(f['mode'])&0o170000!=0o040000 or int(f['mode'])&0o7777!=0o700:refuse()
        record=self.stat(LEASE,missing=True)
        if record is None:
            if self.stat(LEASE_DIRECTORY)!=directory or self.stat(LEASE,missing=True) is not None or self.parents(LEASE_DIRECTORY)!=parents:refuse()
            return 'absent-final-component',None
        _,data=self.file(LEASE,32768,contents=True,private=True)
        if self.stat(LEASE_DIRECTORY)!=directory or self.parents(LEASE_DIRECTORY)!=parents:refuse()
        return 'occupied',base64.b64encode(data).decode('ascii')

    def group(self,record_base64,process):
        def pairs(items):
            value={}
            for key,item in items:
                if key in value:refuse()
                value[key]=item
            return value
        record=json.loads(base64.b64decode(record_base64).decode('utf8'),object_pairs_hook=pairs)
        g=record['group'];c=g['context'];mount='/sys/fs/cgroup/unified'
        if type(record['version']) is not int or record['version']!=3 or g['unit']!=BUDDY or g['mount_path']!=mount or str(g['parent']['pid'])!=process['pid'] or str(g['parent']['start_ticks'])!=process['start_ticks']:refuse()
        if self.text('/proc/sys/kernel/random/boot_id',64).decode('ascii').strip()!=c['boot']:refuse()
        def identity(path,expected,follow=False):
            actual=self.stat(path,follow=follow)[0]
            if any(actual[k]!=str(expected[k]) for k in ('device','inode','uid','mode')):refuse()
        for name,key in [('mnt','mount_namespace'),('cgroup','cgroup_namespace')]:
            identity('/proc/'+process['pid']+'/ns/'+name,c[key],True)
            identity('/proc/self/ns/'+name,c[key],True)
        identity(mount,c['mount']);identity(mount+'/system.slice',c['slice'])
        group=mount+'/system.slice/'+BUDDY;parents=self.parents(group);identity(group,g['group'])
        code,out,err=self.command("stat -f -c %t -- "+mount,64)
        # Linux UAPI CGROUP2_SUPER_MAGIC, matching the existing native source check.
        if code or err or out!=b'63677270\n':refuse()
        records=self.text('/proc/self/mountinfo',256*1024).decode('ascii').splitlines()
        candidates=[line for line in records if len(line.split())>=6 and line.split()[4]==mount]
        if candidates!=[c['mount_record']]:refuse()
        events={}
        for line in self.text(group+'/cgroup.events',4096).decode('ascii').splitlines():
            fields=line.split()
            if len(fields)!=2 or fields[0] not in ('populated','frozen') or fields[1] not in ('0','1') or fields[0] in events:refuse()
            events[fields[0]]=fields[1]
        if events.get('populated')!='1':refuse()
        identity(group,g['group'])
        if self.parents(group)!=parents:refuse()
        # These sampled comparisons do not transfer the native owner's open FDs.

    def companion(self,record_base64):
        def pairs(items):
            value={}
            for key,item in items:
                if key in value:refuse()
                value[key]=item
            return value
        lease=json.loads(base64.b64decode(record_base64).decode('utf8'),object_pairs_hook=pairs)
        text=lease['companion']
        if not isinstance(text,str) or len(text.encode())>65536:refuse()
        original=json.loads(text,object_pairs_hook=pairs);g=original['group']
        if type(original['version']) is not int or original['version']!=1 or g['unit']!=COMPANION or g['mount_path']!='/sys/fs/cgroup/unified' or g['context']!=lease['group']['context'] or g['group']==lease['group']['group']:refuse()
        snapshot=original['snapshot']
        if not isinstance(snapshot,str) or len(snapshot.encode())>16384:refuse()
        fields={}
        for line in snapshot.splitlines():
            key,sep,value=line.partition('=')
            if not sep or key in fields or any(ord(c)<32 or ord(c)>126 for c in value):refuse()
            fields[key]=value
        if set(fields)!=set(CATALOG['state']+CATALOG['policy']) or fields['Id']!=COMPANION or fields['WatchdogUSec']!='0':refuse()
        first=self.service(COMPANION)
        mount='/sys/fs/cgroup/unified';path=mount+'/system.slice/'+COMPANION
        parents=self.parents(path);before=self.stat(path,missing=True)
        if before is None:
            if self.stat(path,missing=True) is not None:refuse()
            observed='original-absent'
        else:
            if any(before[0][k]!=str(g['group'][k]) for k in ('device','inode','uid','mode')):refuse()
            events={}
            for line in self.text(path+'/cgroup.events',4096).decode('ascii').splitlines():
                key,sep,value=line.partition(' ')
                if not sep or key not in ('populated','frozen') or key in events or value not in ('0','1'):refuse()
                events[key]=value
            if 'populated' not in events:refuse()
            observed='populated' if events['populated']=='1' else 'empty-original'
            if self.stat(path)!=before:refuse()
        if self.parents(path)!=parents:refuse()
        last=self.service(COMPANION)
        if first!=last:refuse()
        state=last['state'];policy=last['policy']
        if policy['WatchdogUSec']!='0':refuse()
        for key,value in policy.items():
            if key in ('After','Conflicts'):
                a,b=value.split(),fields[key].split()
                if len(a)!=len(set(a)) or len(b)!=len(set(b)) or set(a)!=set(b):refuse()
            elif value!=fields[key]:refuse()
        retained=all(state[k]==fields[k] for k in ('InvocationID','ExecMainPID','ExecMainStartTimestampMonotonic'))
        cleared=state['InvocationID']=='' and state['ExecMainPID']=='0' and state['ExecMainStartTimestampMonotonic']=='0'
        if not (retained or cleared) or state['LoadState']!='loaded' or state['MainPID']!='0' or state['ControlPID']!='0' or state['Job']!='':refuse()
        if not (state['ActiveState']=='inactive' and state['SubState']=='dead' or retained and state['ActiveState']=='failed' and state['SubState']=='failed'):refuse()
        if observed=='populated' or cleared and observed!='original-absent':refuse()
        if state['ControlGroup']=='' and observed!='original-absent' or state['ControlGroup']!=fields['ControlGroup'] and not (state['ControlGroup']=='' and observed=='original-absent'):refuse()
        return last,observed

    def capture(self,profile,empty):
        if profile not in APPS:refuse()
        r=empty('review',None);r['buddy']=self.service(BUDDY)
        app=APPS[profile]
        alias=self.ordinary_alias(app) if profile=='ordinary-manual' else None
        executable=alias['literal'] if alias else app
        slots=dict(SLOTS,buddy_executable=executable)
        if alias:r['ordinary_alias']=alias
        if profile=='ordinary-manual':slots['buddy_unit']='/etc/systemd/system/'+BUDDY
        else:self.package_conflicts()
        r['artifacts']={k:None for k in slots}
        for key in slots:
            if profile=='ordinary-manual' and key not in ('buddy_unit','buddy_executable'):continue
            cap=134217728 if key in ('buddy_executable','stock_executable','adapter','companion_executable') else 32768
            evidence,content=self.file(slots[key],cap,contents=key=='recovery_profile')
            r['artifacts'][key]=evidence
            if key=='recovery_profile':r['recovery_profile_base64']=base64.b64encode(content).decode('ascii')
        def process():
            artifact=r['artifacts']['buddy_executable']
            return (self.process(r['buddy'],executable,artifact,argv0=app) if alias else
                    self.process(r['buddy'],executable,artifact))
        r['process']=process()
        os_release,kernel=self._read_frames(
            (self._text_script('/etc/os-release',16384),16384),
            (self._text_script('/proc/sys/kernel/osrelease',256),256))
        os_release=os_release.decode('ascii').splitlines()
        versions=[x[len('IMG_VERSION='):] for x in os_release if x.startswith('IMG_VERSION=')]
        if len(versions)!=1:refuse()
        firmware=versions[0]
        if firmware.startswith('"') and firmware.endswith('"'):firmware=firmware[1:-1]
        kernel=kernel.decode('ascii').strip()
        if not re.fullmatch('[0-9.]+',firmware) or not kernel or any(ord(c)<32 or ord(c)>126 for c in kernel):refuse()
        r['platform']=dict(firmware=firmware,kernel=kernel)
        r['lease_observation'],r['lease_base64']=self.lease()
        if profile=='resident-installed':
            if r['lease_observation']!='occupied' or r['lease_base64'] is None:refuse()
            self.group(r['lease_base64'],r['process'])
            if process()!=r['process']:refuse()
            r['helper']=self.service(HELPER);r['stock']=self.service(STOCK)
            r['companion'],r['companion_group']=self.companion(r['lease_base64'])
            r['vendor_policy']={name:self.vendor_policy(unit) for name,unit in [('stock',STOCK),('companion',COMPANION)]}
        if self.service(BUDDY)!=r['buddy'] or process()!=r['process']:refuse()
        if alias:
            paths=self._parent_paths(app)
            target_raw,parent_rows=self._read_frames(
                (self._stat_script(executable),4096),
                (' && '.join(self._stat_script(path) for path in paths),4096))
            target=metadata(target_raw)[0]
            if (not int(target['mode'])&0o111 or
                target!={k:v for k,v in r['artifacts']['buddy_executable'].items() if k!='sha256'}):refuse()
            parents=self._validate_parents(paths,self._stat_rows(parent_rows,len(paths)))
            if self._ordinary_alias_leaf(app,parents)!=alias:refuse()
        if time.monotonic()>=self.deadline:raise shared.Refusal('timeout')
        return r

    def bracket(self,profile,observation,empty):
        if profile not in APPS:refuse()
        def sample():
            first=self.capture(profile,empty);digest=canonical_digest(observation,profile,first)
            second=self.capture(profile,empty)
            if digest!=canonical_digest(observation,profile,second):refuse()
            return second,digest
        return self._typed_group(sample,18 if profile=='ordinary-manual' else 40)
