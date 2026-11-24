"""Fixed CLI maintenance over the qualified wired transport; prompt travels only via stdin."""
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_IO = 131072
COMMAND_PREFIX = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json'
OPERATIONS = {'inspect', 'set', 'disable', 'clear'}
STANDALONE = '/opt/bin/reader-buddy'
RESIDENT = '/home/root/.local/lib/remarkable-buddies/reader-buddy'
LAUNCHER_QUERY = 'systemctl show --no-pager --property=ExecStart --value reader-buddy.service'
# Match one direct ExecStart record. Neither its arguments nor its metadata are executed.
LAUNCHER = re.compile(
    rb'\{ path=([^\s;]+) ; argv\[\]=([^\s;]+)( [^{}\r\n]*?)?'
    rb' ; ignore_errors=(?:yes|no)(?: ; [^{}\r\n]+)? \}'
)


def parse(raw):
    if len(raw) > MAX_IO:
        raise ValueError('invalid request')
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('duplicate field')
            value[key] = item
        return value
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)


def request(raw):
    v = parse(raw)
    if not isinstance(v, dict) or v.get('operation') not in OPERATIONS:
        raise ValueError('invalid operation')
    required = {'operation', 'connection_id', 'boot_id'}
    if v['operation'] != 'inspect':
        required.add('expected_config_sha256')
    if v['operation'] == 'set':
        required.update({'enabled', 'text'})
    if set(v) != required or not isinstance(v['connection_id'], str) or not re.fullmatch('[a-f0-9]{64}', v['connection_id']) or not isinstance(v['boot_id'], str) or not re.fullmatch('[a-f0-9-]{36}', v['boot_id']):
        raise ValueError('invalid identity')
    if v['operation'] != 'inspect' and (not isinstance(v['expected_config_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', v['expected_config_sha256'])):
        raise ValueError('invalid revision')
    if v['operation'] == 'set' and (not isinstance(v['enabled'], bool) or not isinstance(v['text'], str) or '\0' in v['text'] or len(v['text'].encode('utf-8')) > 16384):
        raise ValueError('invalid text')
    return v


def reply(channel, limit, seconds):
    output, discarded = bytearray(), 0
    deadline = time.monotonic() + seconds
    while True:
        if time.monotonic() > deadline:
            raise shared.Refusal('timeout')
        if channel.recv_ready():
            output.extend(channel.recv(4096))
            if len(output) > limit:
                raise ValueError('oversized response')
        if channel.recv_stderr_ready():
            discarded += len(channel.recv_stderr(4096))
            if discarded > limit:
                raise ValueError('oversized diagnostics')
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            return channel.recv_exit_status(), output
        if not channel.recv_ready() and not channel.recv_stderr_ready():
            time.sleep(.01)


def select_executable(transport, load_state, *, without_arguments=False):
    channel = transport.open_session(timeout=2)
    try:
        channel.settimeout(2)
        channel.exec_command(LAUNCHER_QUERY)
        channel.shutdown_write()
        code, output = reply(channel, 4096, 2)
    finally:
        channel.close()
    if code == 0 and load_state == 'not-found' and not output.strip():
        # A standalone install can expose the CLI without installing a unit.
        return STANDALONE
    match = LAUNCHER.fullmatch(output.strip()) if code == 0 and load_state == 'loaded' else None
    if match and match[1] == match[2] and (not without_arguments or match[3] is None):
        for executable in (STANDALONE, RESIDENT):
            if match[1] == executable.encode('ascii'):
                return executable
    raise shared.Refusal('observation-unavailable')


def execute(transport, v, progress):
    before = shared.inspect(transport)
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    operation = v['operation']
    body = {k: value for k, value in v.items() if k in {'expected_config_sha256', 'enabled', 'text'}}
    body['contract_version'] = 1
    raw = json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode()
    if len(raw) > MAX_IO:
        raise ValueError('invalid request')
    executable = select_executable(transport, before['service']['LoadState'])
    channel = transport.open_session(timeout=2)
    try:
        channel.settimeout(2)
        # Dispatch might reach the peer even if exec_command fails to acknowledge.
        progress['dispatched'] = True
        channel.exec_command(f'{COMMAND_PREFIX} {executable} --personalization-operation {operation}')
        if operation != 'inspect':
            channel.sendall(raw)
        channel.shutdown_write()
        code, output = reply(channel, MAX_IO, 8)
        report = parse(output) if code == 0 else None
        status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        before['_personalization'] = {'status': status, 'report': report, 'outcome': 'read-only' if operation == 'inspect' else 'verified' if isinstance(report, dict) and report.get('status') == 'ok' else 'unknown'}
        return before
    finally:
        channel.close()


def main():
    progress = {'dispatched': False}
    v = None
    status, observation = 'unconfigured', None
    p = {'status': 'unavailable', 'report': None, 'outcome': 'not-dispatched'}
    timer = None
    def failure(s):
        outcome = 'read-only' if v and v['operation'] == 'inspect' else 'unknown' if progress['dispatched'] else 'not-dispatched'
        return {'contract_version': 1, 'status': s, 'observation': None, 'personalization': {'status': 'unavailable', 'report': None, 'outcome': outcome}}
    try:
        v = request(sys.stdin.buffer.read(MAX_IO + 1))
        if sys.platform not in ('linux', 'win32'):
            raise shared.Refusal('unsupported-host')
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise shared.Refusal('unconfigured')
        def expire():
            print(json.dumps(failure('timeout')), flush=True)
            os._exit(0)
        timer = threading.Timer(12, expire); timer.daemon = True; timer.start()
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = windows_wired.observe(config, shared, inspection=lambda t: execute(t, v, progress), expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=lambda t: execute(t, v, progress), expected_connection=v['connection_id'])
        p = observation.pop('_personalization'); status = 'observed'
        print(json.dumps({'contract_version': 1, 'status': status, 'observation': observation, 'personalization': p}))
    except shared.Refusal as error:
        print(json.dumps(failure(error.status)))
    except Exception:
        print(json.dumps(failure('observation-unavailable')))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
