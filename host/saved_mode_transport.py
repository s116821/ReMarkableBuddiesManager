"""One bounded saved-mode inspection using existing identity-verified wired callbacks."""
import json
import os
import re
import sys
import threading
import time
import wired_observer as shared

MAX_REQUEST = 256
MAX_RESPONSE = 16384
COMMAND = '/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json /opt/bin/reader-buddy --sync-mode-operation inspect'


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
    if (not isinstance(v, dict) or set(v) != {'connection_id', 'boot_id'}
            or not isinstance(v['connection_id'], str) or not re.fullmatch('[a-f0-9]{64}', v['connection_id'])
            or not isinstance(v['boot_id'], str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', v['boot_id'])
            or v['boot_id'] == '00000000-0000-0000-0000-000000000000'):
        raise ValueError('input refused')
    return v


def execute(transport, v):
    before = shared.inspect(transport)
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    channel = transport.open_session(timeout=2)
    try:
        channel.settimeout(2)
        channel.exec_command(COMMAND)
        try:
            channel.shutdown_write()
        except (OSError, EOFError):
            pass
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
        one_line = output.endswith(b'\n') and output.count(b'\n') == 1
        report = parse(output, MAX_RESPONSE) if code == 0 and one_line else None
        status = 'reported' if report is not None else 'unsupported' if code in (2, 126, 127) else 'unavailable'
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        before['_saved_mode'] = {'status': status, 'report': report}
        return before
    finally:
        channel.close()


def main():
    timer = None
    lock, responded = threading.Lock(), False
    def failure(status):
        return {'contract_version': 1, 'status': status, 'observation': None,
                'saved_mode': {'status': 'unavailable', 'report': None}}
    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)
    try:
        v = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
        if sys.platform not in ('linux', 'win32'):
            raise shared.Refusal('unsupported-host')
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise shared.Refusal('unconfigured')
        def expire():
            respond(failure('timeout'))
            os._exit(0)
        timer = threading.Timer(12, expire)
        timer.daemon = True
        timer.start()
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = windows_wired.observe(config, shared, inspection=lambda t: execute(t, v), expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=lambda t: execute(t, v), expected_connection=v['connection_id'])
        mode = observation.pop('_saved_mode')
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'saved_mode': mode})
    except shared.Refusal as error:
        respond(failure(error.status))
    except Exception:
        respond(failure('observation-unavailable'))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
