"""One bounded global-memory query through the existing identity-verified wired SSH callback."""
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 16384
MAX_RESPONSE = 131072
COMMAND = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --memory-operation query --memory-input -'


def parse(raw, limit):
    if len(raw) > limit:
        raise ValueError('input refused')
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('duplicate field')
            value[key] = item
        return value
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('input refused')))


def request(raw):
    v = parse(raw, MAX_REQUEST)
    if (not isinstance(v, dict) or set(v) != {'connection_id', 'boot_id', 'text'}
            or not isinstance(v['connection_id'], str) or not re.fullmatch('[a-f0-9]{64}', v['connection_id'])
            or not isinstance(v['boot_id'], str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', v['boot_id'])
            or v['boot_id'] == '00000000-0000-0000-0000-000000000000'
            or not isinstance(v['text'], str) or not v['text'].strip() or '\0' in v['text']
            or len(v['text'].encode('utf-8')) > 2048):
        raise ValueError('input refused')
    return v


def execute(transport, v):
    before = shared.inspect(transport)
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    body = {'document': None, 'text': v['text'], 'now_ms': time.time_ns() // 1000000,
            'current_claims': [], 'max_matches': 8, 'max_context_bytes': 8192}
    raw = json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    if len(raw) > MAX_REQUEST:
        raise ValueError('invalid request')
    channel = transport.open_session(timeout=2)
    try:
        channel.settimeout(2)
        channel.exec_command(COMMAND)
        sent = True
        try:
            channel.sendall(raw)
            channel.shutdown_write()
        except (OSError, EOFError):
            sent = False
        output, discarded = bytearray(), 0
        deadline = time.monotonic() + 8
        while True:
            if time.monotonic() > deadline:
                raise shared.Refusal('timeout')
            while channel.recv_ready():
                output.extend(channel.recv(4096))
                if len(output) > MAX_RESPONSE:
                    raise ValueError('oversized response')
            while channel.recv_stderr_ready():
                discarded += len(channel.recv_stderr(4096))
                if discarded > MAX_RESPONSE:
                    raise ValueError('oversized diagnostics')
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                break
            time.sleep(.01)
        code = channel.recv_exit_status()
        report = parse(output, MAX_RESPONSE) if sent and code == 0 and output.endswith(b'\n') else None
        status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        before['_memory_query'] = {'status': status, 'report': report}
        return before
    finally:
        channel.close()

def main():
    timer = None
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'memory_query': {'status': 'unavailable', 'report': None}}
    try:
        v = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
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
            observation = windows_wired.observe(config, shared, inspection=lambda t: execute(t, v), expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=lambda t: execute(t, v), expected_connection=v['connection_id'])
        query = observation.pop('_memory_query')
        print(json.dumps({'contract_version': 1, 'status': 'observed', 'observation': observation, 'memory_query': query}))
    except shared.Refusal as error:
        print(json.dumps(failure(error.status)))
    except Exception:
        print(json.dumps(failure('observation-unavailable')))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
