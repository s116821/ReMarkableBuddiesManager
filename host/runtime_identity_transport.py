"""Read one known binary's version; never infer package/running authority."""
import json
import os
import re
import stat
import sys
import threading
import time
import wired_observer as shared

BINARY = '/opt/bin/reader-buddy'
COMMAND = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin /opt/bin/reader-buddy --version'
LINE = re.compile(rb'(?:reader-buddy|remarkable-reader-buddy) (v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)\r?\n')


def report(status, version=None):
    return {'report_version':1,'status':status,'binary_version':version,'running_version':None,
            'package_owner':'unknown','provenance':'unknown','installation_eligible':False}


def metadata(sftp):
    parents=[]
    for path in ['/opt','/opt/bin']:
        parent=sftp.lstat(path)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=0 or parent.st_mode&0o022: raise ValueError('unsafe executable parent')
        parents.append(tuple(getattr(parent,k,None) for k in ['st_mode','st_uid','st_gid','st_size','st_mtime']))
    try:
        info = sftp.lstat(BINARY)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or not info.st_mode & stat.S_IXUSR or info.st_mode & 0o022 or not isinstance(info.st_size,int) or info.st_size <= 0:
        raise ValueError('unsafe executable')
    return tuple(parents)+ (tuple(getattr(info,k,None) for k in ['st_mode','st_uid','st_gid','st_size','st_mtime']),)


def inspect_runtime(transport, boot):
    import paramiko
    before = shared.inspect(transport)
    if before['boot_id'] != boot:
        raise shared.Refusal('cable-lost')
    sftp = paramiko.SFTPClient.from_transport(transport); sftp.get_channel().settimeout(2)
    channel = None
    try:
        try:
            original = metadata(sftp)
        except ValueError:
            original, value = None, report('unsafe')
        else:
            value = report('missing') if original is None else None
        if original is not None:
            channel = transport.open_session(timeout=2); channel.settimeout(2); channel.exec_command(COMMAND)
            raw, discarded = bytearray(), 0; deadline = time.monotonic()+4
            while True:
                if time.monotonic()>deadline: raise shared.Refusal('timeout')
                while channel.recv_ready():
                    raw.extend(channel.recv(512))
                    if len(raw)>512: raise ValueError('oversized version output')
                while channel.recv_stderr_ready():
                    discarded+=len(channel.recv_stderr(4096))
                    if discarded>4096: raise ValueError('oversized diagnostics')
                if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready(): break
                time.sleep(.01)
            code=channel.recv_exit_status(); match=LINE.fullmatch(raw) if code==0 else None
            value=report('reported',match[1].decode('ascii')) if match and len(match[1])<=96 else report('unsupported')
            if metadata(sftp)!=original: raise shared.Refusal('observation-unavailable')
        if shared.inspect(transport)!=before: raise shared.Refusal('observation-unavailable')
        before['_runtime_identity']=value
        return before
    finally:
        if channel: channel.close()
        sftp.close()


def main():
    timer=None
    def failed(status): return {'contract_version':1,'status':status,'observation':None,'runtime_identity':None}
    try:
        raw=sys.stdin.buffer.read(4097)
        if len(raw)>4096: raise ValueError('oversized request')
        def pairs(items):
            v={}
            for key,value in items:
                if key in v: raise ValueError('duplicate field')
                v[key]=value
            return v
        request=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs)
        if not isinstance(request,dict) or set(request)!={'connection_id','boot_id'} or not isinstance(request['connection_id'],str) or not re.fullmatch('[a-f0-9]{64}',request['connection_id']) or not isinstance(request['boot_id'],str) or not re.fullmatch('[a-f0-9-]{36}',request['boot_id']): raise ValueError('invalid identity')
        if sys.platform not in ('linux','win32'): raise shared.Refusal('unsupported-host')
        import paramiko
        if paramiko.__version__!='5.0.0': raise shared.Refusal('unconfigured')
        def expire():
            print(json.dumps(failed('timeout')),flush=True);os._exit(0)
        timer=threading.Timer(12,expire);timer.daemon=True;timer.start()
        if sys.platform=='win32':
            import windows_wired
            config=windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            value=windows_wired.observe(config,shared,inspection=lambda t:inspect_runtime(t,request['boot_id']),expected_connection=request['connection_id'])
        else:
            config=shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            value=shared.observe(config,inspection=lambda t:inspect_runtime(t,request['boot_id']),expected_connection=request['connection_id'])
        identity=value.pop('_runtime_identity');print(json.dumps({'contract_version':1,'status':'observed','observation':value,'runtime_identity':identity}))
    except shared.Refusal as error: print(json.dumps(failed(error.status)))
    except Exception: print(json.dumps(failed('observation-unavailable')))
    finally:
        if timer: timer.cancel()


if __name__=='__main__': main()
