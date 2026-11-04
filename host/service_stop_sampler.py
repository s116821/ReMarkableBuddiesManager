"""Fixed-path read-only candidate sampling. No production profile is enabled here.

The collector requires qualified GNU stat spellings. Unsupported utilities,
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
import time
import wired_observer as shared

BUDDY = 'reader-buddy.service'
HELPER = 'reader-buddy-stock-recovery.service'
STOCK = 'xochitl.service'
LEASE_DIRECTORY = '/run/reader-buddy-resident'
LEASE = LEASE_DIRECTORY + '/activation.json'
SLOTS = dict(buddy_unit='/etc/systemd/system/reader-buddy.service',
             recovery_profile='/home/root/.local/lib/reader-buddy/resident-recovery.json',
             native_profile='/home/root/.local/lib/reader-buddy/resident-profile.json',
             adapter='/home/root/.local/lib/reader-buddy/libremarkable-resident.so',
             helper_unit='/etc/systemd/system/reader-buddy-stock-recovery.service',
             stock_executable='/usr/bin/xochitl', stock_unit='/usr/lib/systemd/system/xochitl.service',
             stock_dropin='/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf')
APPS = {'ordinary-manual':'/opt/bin/reader-buddy',
        'resident-installed':'/home/root/.local/lib/reader-buddy/reader-buddy'}
CATALOG = json.loads(Path(__file__).with_name('service-stop-properties.json').read_text())
PROPERTIES = [k for values in CATALOG.values() for k in values]
PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/usr/bin:/bin LC_ALL=C /bin/sh -c '
STAT_FORMAT = '%d %i %u %g %f %s %h\\n%y\\n%z\\n'


def refuse():
    raise ValueError('service sample refused')


def canonical_digest(observation, profile, raw):
    names = ('buddy','helper','stock','process','platform','artifacts',
             'recovery_profile_base64','lease_base64','lease_observation','configuration')
    v = dict(connection_id=observation['connection_id'],boot_id=observation['boot_id'],profile=profile,
             **{k:raw[k] for k in names})
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
        while True:
            if time.monotonic() >= command_deadline:
                raise shared.Refusal('timeout')
            if channel.recv_ready():
                output.extend(channel.recv(4096))
                if len(output)>cap:refuse()
            if channel.recv_stderr_ready():
                error.extend(channel.recv_stderr(4096))
                if len(error)>8192:refuse()
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():break
            time.sleep(.005)
        code=channel.recv_exit_status()
        if time.monotonic()>=deadline:raise shared.Refusal('timeout')
        return code,bytes(output),bytes(error)
    finally:
        output[:]=b'\0'*len(output);error[:]=b'\0'*len(error)
        channel.close()


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


class Sampler:
    def __init__(self,transport,deadline,run=run_fixed):
        self.transport,self.deadline,self.run=transport,deadline,run

    def command(self,script,cap=32768):
        return self.run(self.transport,PREFIX+shlex.quote(script),self.deadline,cap)

    def stat(self,path,follow=False,missing=False):
        # Every caller uses a compiled fixed path or a range-checked MainPID path.
        command=('stat -L ' if follow else 'test ! -L '+shlex.quote(path)+' && stat ')
        command+='--printf='+shlex.quote(STAT_FORMAT)+' -- '+shlex.quote(path)
        code,out,err=self.command(command,4096)
        if code:
            # Narrow qualified GNU spelling, under independently bracketed parents.
            expected=("stat: cannot statx '"+path+"': No such file or directory\n").encode()
            if missing and not out and err==expected:return None
            refuse()
        if err:refuse()
        return metadata(out)

    def parents(self,path):
        parents=list(PurePosixPath(path).parents);result=[]
        for parent in reversed(parents):
            p=str(parent);info=self.stat(p)
            f=info[0];mode=int(f['mode'])
            if f['uid']!='0' or f['gid']!='0' or mode&0o170000!=0o040000 or mode&0o022:refuse()
            result.append((p,info))
        return result

    def file(self,path,limit=32768,contents=False,private=False):
        parents=self.parents(path);before=self.stat(path)
        f,nlink=before;mode=int(f['mode'])
        if f['uid']!='0' or f['gid']!='0' or mode&0o170000!=0o100000 or mode&0o022 or int(f['length'])>limit:refuse()
        if private and (mode&0o7777!=0o600 or nlink!=1 or int(f['length'])==0):refuse()
        if contents:
            code,out,err=self.command('head -c '+str(limit+1)+' -- '+shlex.quote(path),limit+1)
            if code or err or len(out)!=int(f['length']) or len(out)>limit:refuse()
            checksum=hashlib.sha256(out).hexdigest()
        else:
            code,value,err=self.command('sha256sum -- '+shlex.quote(path),4096)
            if code or err:refuse()
            text=value.decode('ascii')
            if not re.fullmatch('[a-f0-9]{64}  '+re.escape(path)+'\n',text):refuse()
            checksum=text[:64]
            out=None
        if self.stat(path)!=before or self.parents(path)!=parents:refuse()
        return dict(f,sha256=checksum),out

    def text(self,path,cap):
        # Kernel/platform identity files are read-only sources, not trust anchors.
        code,out,err=self.command('head -c '+str(cap+1)+' -- '+shlex.quote(path),cap+1)
        if code or err or len(out)>cap:refuse()
        return out

    def service(self,unit):
        if unit not in (BUDDY,HELPER,STOCK):refuse()
        command='/bin/systemctl --system --no-pager --no-ask-password --all show '+' '.join('--property='+k for k in PROPERTIES)+' -- '+unit
        code,out,err=self.run(self.transport,command,self.deadline,32768)
        if code or err:refuse()
        result={}
        for line in out.decode('ascii').splitlines():
            key,separator,value=line.partition('=')
            if not separator or key not in PROPERTIES or key in result or len(value)>4096 or any(ord(c)<32 or ord(c)>126 for c in value):refuse()
            result[key]=value
        if set(result)!=set(PROPERTIES) or result['Id']!=unit:refuse()
        # Do not serialize unexpected secret-bearing arbitrary stop hook argv.
        if result['ExecStop'] or result['ExecStopPost']:refuse()
        return {section:{k:result[k] for k in names} for section,names in CATALOG.items()}

    def process(self,service,app,artifact):
        pid=service['state']['MainPID']
        if not re.fullmatch('[1-9][0-9]*',pid) or not 1<int(pid)<2**32:refuse()
        root='/proc/'+pid
        def start():
            stat=self.text(root+'/stat',4096).decode('ascii')
            if stat.split(' ',1)[0]!=pid or ')' not in stat:refuse()
            fields=stat.rsplit(')',1)[1].split()
            if len(fields)<20 or fields[0] in ('Z','X','x') or not re.fullmatch('[1-9][0-9]*',fields[19]):refuse()
            return fields[19]
        before=start();cmd=self.text(root+'/cmdline',len(app)+1)
        if cmd!=app.encode()+b'\0':refuse()
        code,exe,err=self.command('readlink -- '+shlex.quote(root+'/exe'),4096)
        if code or err or exe!=app.encode()+b'\n':refuse()
        status=self.text(root+'/status',16384).decode('ascii').splitlines()
        for key in ('Uid:','Gid:'):
            rows=[v.split()[1:] for v in status if v.startswith(key)]
            if rows!=[['0','0','0','0']]:refuse()
        membership=self.text(root+'/cgroup',16384).decode('ascii').splitlines()
        if membership.count('0::/system.slice/'+BUDDY)!=1:refuse()
        running=self.stat(root+'/exe',follow=True)[0]
        if running!= {k:v for k,v in artifact.items() if k!='sha256'}:refuse()
        code,out,err=self.command('sha256sum -- '+shlex.quote(root+'/exe'),4096)
        if code or err or out!=(artifact['sha256']+'  '+root+'/exe\n').encode() or self.stat(root+'/exe',follow=True)[0]!=running or start()!=before:refuse()
        return dict(pid=pid,start_ticks=before,uid='0',gid='0',executable=app,argv=[app],sha256=artifact['sha256'])

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
        if type(record['version']) is not int or record['version']!=2 or g['unit']!=BUDDY or g['mount_path']!=mount or str(g['parent']['pid'])!=process['pid'] or str(g['parent']['start_ticks'])!=process['start_ticks']:refuse()
        if self.text('/proc/sys/kernel/random/boot_id',64).decode('ascii').strip()!=c['boot']:refuse()
        def identity(path,expected,follow=False):
            actual=self.stat(path,follow=follow)[0]
            if any(actual[k]!=str(expected[k]) for k in ('device','inode','uid','mode')):refuse()
        for name,key in [('mnt','mount_namespace'),('cgroup','cgroup_namespace')]:
            identity('/proc/'+process['pid']+'/ns/'+name,c[key],True)
            identity('/proc/self/ns/'+name,c[key],True)
        identity(mount,c['mount']);identity(mount+'/system.slice',c['slice'])
        group=mount+'/system.slice/'+BUDDY;parents=self.parents(group);identity(group,g['group'])
        code,out,err=self.command("stat -f --printf='%t\\n' -- "+mount,64)
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

    def capture(self,profile,empty):
        if profile not in APPS:refuse()
        r=empty('review',None);r['buddy']=self.service(BUDDY)
        slots=dict(SLOTS,buddy_executable=APPS[profile])
        r['artifacts']={k:None for k in slots}
        for key in slots:
            if profile=='ordinary-manual' and key not in ('buddy_unit','buddy_executable'):continue
            cap=134217728 if key in ('buddy_executable','stock_executable','adapter') else 32768
            evidence,content=self.file(slots[key],cap,contents=key=='recovery_profile')
            r['artifacts'][key]=evidence
            if key=='recovery_profile':r['recovery_profile_base64']=base64.b64encode(content).decode('ascii')
        r['process']=self.process(r['buddy'],APPS[profile],r['artifacts']['buddy_executable'])
        os_release=self.text('/etc/os-release',16384).decode('ascii').splitlines()
        versions=[x[len('IMG_VERSION='):] for x in os_release if x.startswith('IMG_VERSION=')]
        if len(versions)!=1:refuse()
        firmware=versions[0]
        if firmware.startswith('"') and firmware.endswith('"'):firmware=firmware[1:-1]
        kernel=self.text('/proc/sys/kernel/osrelease',256).decode('ascii').strip()
        if not re.fullmatch('[0-9.]+',firmware) or not kernel or any(ord(c)<32 or ord(c)>126 for c in kernel):refuse()
        r['platform']=dict(firmware=firmware,kernel=kernel)
        r['lease_observation'],r['lease_base64']=self.lease()
        if profile=='resident-installed':
            if r['lease_observation']!='occupied' or r['lease_base64'] is None:refuse()
            self.group(r['lease_base64'],r['process'])
            if self.process(r['buddy'],APPS[profile],r['artifacts']['buddy_executable'])!=r['process']:refuse()
            r['helper']=self.service(HELPER);r['stock']=self.service(STOCK)
        if self.service(BUDDY)!=r['buddy'] or self.process(r['buddy'],APPS[profile],r['artifacts']['buddy_executable'])!=r['process']:refuse()
        if time.monotonic()>=self.deadline:raise shared.Refusal('timeout')
        return r

    def bracket(self,profile,observation,empty):
        first=self.capture(profile,empty);digest=canonical_digest(observation,profile,first)
        second=self.capture(profile,empty)
        if digest!=canonical_digest(observation,profile,second):refuse()
        return second,digest
