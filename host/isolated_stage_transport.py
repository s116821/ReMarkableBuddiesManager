"""Fixed, bounded isolated-stage SSH streaming using the observed wired target."""
import base64
import json
import os
import posixpath
import re
import socket
import sys
import threading
import time

import wired_observer as shared
from ordinary_restore_transport import digest, exact, parse, source_path, uuid

MAX_CONTROL = 24576
MAX_REPORT = 16384
MAX_DIAGNOSTICS = 8192
MAX_BUDGET = 12000
CHUNK = 65536
RECEIVE = 'receive-isolated-stage'
CHECK = 'check-isolated-stage'
RELEASE = 'release-isolated-stage'
SELECTORS = (RECEIVE, CHECK, RELEASE)
PREFIX = ('/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin '
          'REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json '
          '/opt/bin/reader-buddy --archive-operation ')
COMMANDS = {selector: PREFIX + selector + ' --archive-input -' for selector in SELECTORS}


def stage_id(value):
    return bool(uuid(value) and re.fullmatch(
        '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value))


def version(value):
    return type(value) is int and value == 1


def request(raw):
    value = parse(raw, MAX_CONTROL)
    if not isinstance(value, dict) or value.get('selector') not in SELECTORS:
        raise ValueError('stage control refused')
    selector = value['selector']
    receive = selector == RECEIVE
    exact(value, 'selector connection_id boot_id budget_ms ' + ('header' if receive else 'input_base64'))
    if (not digest(value['connection_id']) or not uuid(value['boot_id'])
            or type(value['budget_ms']) is not int or not 1 <= value['budget_ms'] <= MAX_BUDGET):
        raise ValueError('stage control refused')
    if receive:
        header = value['header']
        exact(header, 'version stage_id boot_id marker_sha256 inventory_sha256 object_count payload_bytes')
        if (not version(header['version']) or not stage_id(header['stage_id'])
                or header['boot_id'] != value['boot_id']
                or not digest(header['marker_sha256']) or not digest(header['inventory_sha256'])
                or type(header['object_count']) is not int or not 0 <= header['object_count'] <= 4096
                or type(header['payload_bytes']) is not int or not 0 <= header['payload_bytes'] <= (512 << 20)):
            raise ValueError('stage header refused')
    else:
        encoded = value['input_base64']
        if not isinstance(encoded, str):
            raise ValueError('stage receipt refused')
        original = base64.b64decode(encoded, validate=True)
        if base64.b64encode(original).decode('ascii') != encoded:
            raise ValueError('stage receipt refused')
        receipt = parse(original, MAX_REPORT)
        exact(receipt, 'version stage_id boot_id marker_sha256 inventory_sha256 root custody_sha256')
        root = receipt['root']
        if (not version(receipt['version']) or not stage_id(receipt['stage_id'])
                or receipt['boot_id'] != value['boot_id']
                or not all(digest(receipt[name]) for name in
                           ('marker_sha256', 'inventory_sha256', 'custody_sha256'))
                or not source_path(root) or posixpath.normpath(root) != root or root.startswith('//')
                or not root.endswith('/.remarkable-buddies-restore-stage-v1/restore-v1-' + receipt['stage_id'])):
            raise ValueError('stage receipt refused')
    return value


def remaining(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise shared.Refusal('timeout')
    return left


def send(channel, data, deadline, stop):
    offset = 0
    while offset < len(data):
        remaining(deadline)
        if stop.is_set():
            raise EOFError('stage writer stopped')
        try:
            count = channel.send(data[offset:])
        except socket.timeout:
            continue
        if count <= 0:
            raise EOFError('stage channel closed')
        offset += count


def write_stage(channel, v, deadline, read, stop):
    selector = v['selector']
    if selector == RECEIVE:
        budget = min(MAX_BUDGET, int(remaining(deadline) * 1000))
        if budget < 1:
            raise shared.Refusal('timeout')
        header = json.dumps({**v['header'], 'budget_ms': budget}, separators=(',', ':')).encode() + b'\n'
        if len(header) > 4096:
            raise ValueError('stage header refused')
        send(channel, header, deadline, stop)
        count = v['header']['payload_bytes'] + 40 * (3 + v['header']['object_count'])
        while count:
            remaining(deadline)
            chunk = read(min(CHUNK, count))
            if not chunk or len(chunk) > count:
                raise ValueError('stage body refused')
            send(channel, chunk, deadline, stop)
            count -= len(chunk)
        if read(1):
            raise ValueError('trailing stage input')
    else:
        send(channel, base64.b64decode(v['input_base64'], validate=True), deadline, stop)
    remaining(deadline)
    if stop.is_set():
        raise EOFError('stage writer stopped')
    channel.shutdown_write()


def execute(transport, v, deadline, mark_dispatch, read):
    remaining(deadline)
    before = shared.inspect(transport)
    if before['boot_id'] != v['boot_id']:
        raise shared.Refusal('cable-lost')
    channel = transport.open_session(timeout=min(2, remaining(deadline)))
    output = bytearray()
    stop, wrote, writer_closed = threading.Event(), threading.Event(), threading.Event()

    def upload():
        try:
            write_stage(channel, v, deadline, read, stop)
            wrote.set()
        except Exception:
            # A bounded early terminal refusal may arrive even if not all of
            # the local writer's data could be sent.
            pass
        finally:
            writer_closed.set()

    try:
        channel.settimeout(min(.2, remaining(deadline)))
        mark_dispatch()
        channel.exec_command(COMMANDS[v['selector']])
        threading.Thread(target=upload, daemon=True).start()
        diagnostics = 0
        while True:
            remaining(deadline)
            while channel.recv_ready():
                remaining(deadline)
                chunk = channel.recv(4096)
                output.extend(chunk)
                if len(output) > MAX_REPORT:
                    raise ValueError('oversized stage response')
            while channel.recv_stderr_ready():
                remaining(deadline)
                diagnostics += len(channel.recv_stderr(4096))
                if diagnostics > MAX_DIAGNOSTICS:
                    raise ValueError('oversized stage diagnostics')
            if channel.closed and not channel.eof_received:
                raise ValueError('stage output EOF missing')
            if (channel.eof_received and channel.exit_status_ready()
                    and not channel.recv_ready() and not channel.recv_stderr_ready()):
                break
            time.sleep(.01)
        if channel.recv_exit_status() != 0 or not output.endswith(b'\n') or output.count(b'\n') != 1:
            raise ValueError('nonterminal stage response')
        report = parse(output, MAX_REPORT)
        exact(report, 'report_version operation status incomplete activation_performed data')
        if (not version(report['report_version']) or report['operation'] != v['selector']
                or report['activation_performed'] is not False or type(report['incomplete']) is not bool):
            raise ValueError('stage report refused')
        if report['status'] == 'ok':
            data = report['data']
            if not isinstance(data, dict) or not isinstance(data.get('receipt'), dict) or not version(data['receipt'].get('version')):
                raise ValueError('stage receipt version refused')
            if not writer_closed.wait(timeout=remaining(deadline)) or not wrote.is_set():
                raise ValueError('incomplete stage writer')
        stop.set()
        remaining(deadline)
        if shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        remaining(deadline)
        before['_stage_stdout'] = base64.b64encode(output).decode('ascii')
        return before
    finally:
        stop.set()
        output.clear()
        channel.close()


def main():
    lock = threading.Lock()
    dispatched, responded = False, False
    deadline = time.monotonic() + MAX_BUDGET / 1000

    def respond(status, observation=None, stdout=None):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                dispatch = 'possible' if dispatched else 'not-dispatched'
                encoded = json.dumps({'contract_version': 1, 'status': status, 'observation': observation,
                                      'dispatch': dispatch, 'stdout_base64': stdout}).encode('utf-8') + b'\n'
                sys.stdout.buffer.write(encoded)
                sys.stdout.buffer.flush()

    def mark_dispatch():
        nonlocal dispatched
        with lock:
            remaining(deadline)
            if responded:
                raise shared.Refusal('timeout')
            dispatched = True

    def expire():
        respond('timeout')
        os._exit(0)

    start = time.monotonic()
    timer = threading.Timer(remaining(deadline), expire)
    timer.daemon = True
    timer.start()
    try:
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.setmode(0, os.O_BINARY)
            msvcrt.setmode(1, os.O_BINARY)
        sys.stdout.buffer.write(b'READY\n')
        sys.stdout.buffer.flush()
        # Read unbuffered so the upload thread owns all bytes after this line
        # and can be stopped by child exit even if its local pipe is silent.
        raw = bytearray()
        while len(raw) < MAX_CONTROL:
            part = os.read(0, 1)
            if not part:
                raise ValueError('stage control incomplete')
            raw.extend(part)
            if part == b'\n':
                break
        if not raw.endswith(b'\n'):
            raise ValueError('stage control exceeds bound')
        v = request(raw)
        deadline = min(deadline, start + v['budget_ms'] / 1000)
        timer.cancel()
        timer = threading.Timer(remaining(deadline), expire)
        timer.daemon = True
        timer.start()
        if v['selector'] != RECEIVE and os.read(0, 1):
            raise ValueError('trailing stage receipt input')
        if sys.platform not in ('linux', 'win32'):
            raise shared.Refusal('unsupported-host')
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise shared.Refusal('unconfigured')
        remaining(deadline)

        def inspect(t):
            return execute(t, v, deadline, mark_dispatch, lambda count: os.read(0, count))

        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = windows_wired.observe(config, shared, inspection=inspect,
                                                expected_connection=v['connection_id'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])
            observation = shared.observe(config, inspection=inspect, expected_connection=v['connection_id'])
        remaining(deadline)
        output = observation.pop('_stage_stdout')
        respond('observed', observation, output)
    except shared.Refusal as error:
        respond(error.status)
    except Exception:
        respond('observation-unavailable')
    finally:
        timer.cancel()


if __name__ == '__main__':
    main()
