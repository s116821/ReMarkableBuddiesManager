"""One confidential, identity-bound Capacities actor invocation on wired SSH."""
import hashlib
import json
import os
import re
import socket
import sys
import threading
import time

import wired_observer as shared
from model_credential_transport import digest, exact, parse, uuid
from runtime_identity_transport import metadata

ENVIRONMENT = ('/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin '
               'REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json ')
COMMAND = ENVIRONMENT + '/opt/bin/reader-buddy --capacities-oauth'
EXCHANGE_COMMAND = (ENVIRONMENT + 'REMARKABLE_BUDDIES_CAPACITIES_ATTEST=1 '
                    '/opt/bin/reader-buddy --capacities-oauth')
ATTEST_PREFIX = b'capacities-actor-exe-v1 '
DIGEST_COMMAND = ('/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C '
                  'sha256sum -- /opt/bin/reader-buddy')
DIGEST_OUTPUT = re.compile(rb'([a-f0-9]{64}) [ *]/opt/bin/reader-buddy\n')
CAPTURE_FIELDS = 'tablet_id connection_id boot_id config_sha256'
BINDING_FIELDS = CAPTURE_FIELDS + ' operation_id grant_id'
BASE_FIELDS = 'contract_version status'
ACTOR_MAX_MS = 30000
EXCHANGE_MAX_MS = 60000
READ_MAX_MS = 12000
POSTFLIGHT_SECONDS = 4
MAX_REQUEST = 32768
MAX_RESPONSE = 4096
MAX_DIAGNOSTICS = 8192
MAX_EXECUTABLE = 128 * 1024 * 1024


def text(value, maximum):
    return (isinstance(value, str) and 0 < len(value) <= maximum
            and re.fullmatch(r'[\x21-\x7e]+', value))


def request(raw):
    value = parse(raw, MAX_REQUEST)
    if not isinstance(value, dict):
        raise ValueError('request refused')
    selector = value.get('selector')
    if selector not in ('capture', 'exchange', 'status'):
        raise ValueError('request refused')
    exchange = selector == 'exchange'
    exact(value, 'selector budget_ms binding proof executable_sha256' if exchange else 'selector budget_ms binding')
    if type(value['budget_ms']) is not int or not 1 <= value['budget_ms'] <= (EXCHANGE_MAX_MS if exchange else READ_MAX_MS):
        raise ValueError('request refused')
    binding = value['binding']
    exact(binding, 'connection_id boot_id' if selector == 'capture' else BINDING_FIELDS)
    if not digest(binding['connection_id']) or not uuid(binding['boot_id']):
        raise ValueError('request refused')
    if selector != 'capture' and (
            not digest(binding['config_sha256'])
            or not all(uuid(binding[key]) for key in ('tablet_id', 'grant_id', 'operation_id'))
            or binding['operation_id'] == binding['grant_id']):
        raise ValueError('request refused')
    if exchange:
        if not digest(value['executable_sha256']):
            raise ValueError('request refused')
        proof = value['proof']
        exact(proof, 'code verifier client_id redirect_uri resource')
        if (not text(proof['code'], 4096) or not text(proof['client_id'], 256)
                or not isinstance(proof['verifier'], str)
                or not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}', proof['verifier'])
                or proof['redirect_uri'] != 'http://127.0.0.1:48761/oauth/capacities/callback'
                or proof['resource'] != 'https://api.capacities.io'):
            raise ValueError('request refused')
    return value


def receipt(value, selector, binding):
    if not isinstance(value, dict) or type(value.get('contract_version')) is not int or value['contract_version'] != 1:
        raise ValueError('report refused')
    status = value.get('status')
    if selector == 'capture':
        if status == 'unresolved':
            exact(value, BASE_FIELDS)
        elif status == 'captured':
            exact(value, BASE_FIELDS + ' ' + CAPTURE_FIELDS)
            if (not uuid(value['tablet_id']) or not digest(value['config_sha256'])
                    or any(value[key] != binding[key] for key in ('boot_id', 'connection_id'))):
                raise ValueError('report refused')
        else:
            raise ValueError('report refused')
        return value
    if status not in ('not-dispatched', 'staged', 'unresolved', 'committed'):
        raise ValueError('report refused')
    committed = status == 'committed'
    exact(value, BASE_FIELDS + ' ' + BINDING_FIELDS + (' installed_config_sha256 space_id' if committed else ''))
    if any(value[key] != binding[key] for key in BINDING_FIELDS.split()):
        raise ValueError('report refused')
    if committed and (not uuid(value['space_id']) or not digest(value['installed_config_sha256'])):
        raise ValueError('report refused')
    return value


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise shared.Refusal('timeout')
    return seconds


def drain(channel, deadline, output, maximum=MAX_RESPONSE, diagnostics=MAX_DIAGNOSTICS):
    # An available exit status and an empty current buffer do not prove EOF.
    channel.settimeout(0.0)
    stdout_done = stderr_done = False
    discarded = 0
    while True:
        remaining(deadline)
        progressed = False
        if not stdout_done:
            try:
                chunk = channel.recv(4096)
            except socket.timeout:
                pass
            else:
                stdout_done = not chunk
                output.extend(chunk)
                if len(output) > maximum:
                    raise ValueError('report refused')
                progressed = True
        if not stderr_done:
            try:
                chunk = channel.recv_stderr(4096)
            except socket.timeout:
                pass
            else:
                stderr_done = not chunk
                discarded += len(chunk)
                if discarded > diagnostics:
                    raise ValueError('report refused')
                progressed = True
        if stdout_done and stderr_done and channel.exit_status_ready():
            return channel.recv_exit_status()
        if not progressed:
            time.sleep(min(.01, remaining(deadline)))


def executable_digest(transport, deadline):
    deadline = min(deadline - POSTFLIGHT_SECONDS, time.monotonic() + 8)
    channel = transport.open_session(timeout=min(2, remaining(deadline)))
    try:
        channel.settimeout(min(2, remaining(deadline)))
        channel.exec_command(DIGEST_COMMAND)
        channel.shutdown_write()
        output = bytearray()
        if drain(channel, deadline, output, maximum=128, diagnostics=0) != 0:
            raise ValueError('executable read refused')
        witness = DIGEST_OUTPUT.fullmatch(output)
        if not witness:
            raise ValueError('executable read refused')
        return witness[1].decode('ascii')
    finally:
        channel.close()


def installed_metadata(sftp):
    sampled = metadata(sftp)
    # Reuse the existing metadata gate. Its last row is the executable leaf
    # (mode, uid, gid, size, mtime) after the two protected parents.
    if sampled is None or not 1 <= sampled[-1][3] <= MAX_EXECUTABLE:
        raise ValueError('actor unavailable')
    return sampled


class Exchange:
    def __init__(self, proof, executable_sha256, pre_send):
        self.proof = proof
        self.executable_sha256 = executable_sha256
        self.pre_send = pre_send
        self.possible = False


def confirm_executable(channel, expected, deadline):
    # The launched actor measures its running ELF before reading stdin.
    # Do not give either the expected digest or proof to an unmatched actor.
    deadline = min(deadline, time.monotonic() + 8)
    witness = ATTEST_PREFIX + expected.encode('ascii') + b'\n'
    received = bytearray()
    while len(received) < len(witness):
        channel.settimeout(min(2, remaining(deadline)))
        try:
            chunk = channel.recv(len(witness) - len(received))
        except socket.timeout:
            continue
        if not chunk:
            raise ValueError('actor refused')
        received.extend(chunk)
        if not witness.startswith(received):
            raise ValueError('actor refused')


def actor(transport, selector, binding, deadline, exchange=None):
    actor_deadline = deadline - POSTFLIGHT_SECONDS
    admission_deadline = actor_deadline - ACTOR_MAX_MS / 1000 if exchange is not None else actor_deadline
    channel = transport.open_session(timeout=min(2, remaining(admission_deadline)))
    attempt = bytearray()
    output = bytearray()
    try:
        channel.settimeout(min(2, remaining(admission_deadline)))
        channel.exec_command(EXCHANGE_COMMAND if exchange is not None else COMMAND)
        if exchange is not None:
            confirm_executable(channel, exchange.executable_sha256, admission_deadline)
            exchange.pre_send()
            if not transport.is_active():
                raise shared.Refusal('cable-lost')
        available = int(remaining(actor_deadline) * 1000)
        if available < (ACTOR_MAX_MS if selector == 'exchange' else 1):
            raise shared.Refusal('timeout')
        message = {'contract_version': 1, 'selector': selector, 'binding': binding,
                   'budget_ms': min(ACTOR_MAX_MS, available)}
        if exchange is not None:
            message['proof'] = exchange.proof
        attempt.extend(json.dumps(message, separators=(',', ':'), ensure_ascii=True).encode('ascii'))
        if len(attempt) > MAX_REQUEST:
            raise ValueError('request refused')
        channel.settimeout(min(2, remaining(actor_deadline)))
        if selector == 'exchange' and remaining(actor_deadline) < ACTOR_MAX_MS / 1000:
            raise shared.Refusal('timeout')
        if exchange is not None:
            exchange.possible = True
        channel.sendall(attempt)
        channel.shutdown_write()
        if drain(channel, actor_deadline, output) != 0 or not output.endswith(b'\n') or output.count(b'\n') != 1:
            raise ValueError('report refused')
        return receipt(parse(output, MAX_RESPONSE), selector, binding)
    finally:
        attempt[:] = b'\x00' * len(attempt)
        output[:] = b'\x00' * len(output)
        channel.close()


def execute(transport, value, deadline, open_sftp, exchange):
    selector, binding = value['selector'], value['binding']
    remaining(deadline)
    before = shared.inspect(transport)
    if before['boot_id'] != binding['boot_id']:
        raise shared.Refusal('cable-lost')
    sftp = open_sftp(transport)
    try:
        sftp.get_channel().settimeout(min(2, remaining(deadline)))
        installed = installed_metadata(sftp)
        fingerprint = None
        if selector == 'exchange':
            capture = {key: binding[key] for key in ('connection_id', 'boot_id')}
            actual = actor(transport, 'capture', capture, min(deadline, time.monotonic() + 8))
            if actual['status'] != 'captured' or any(actual[key] != binding[key] for key in CAPTURE_FIELDS.split()):
                raise shared.Refusal('cable-lost')
            if installed_metadata(sftp) != installed:
                raise ValueError('actor changed')
        elif selector == 'capture':
            fingerprint = executable_digest(transport, deadline)
            if installed_metadata(sftp) != installed:
                raise ValueError('actor changed')
        result = actor(transport, selector, binding, deadline, exchange)
        remaining(deadline)
        if installed_metadata(sftp) != installed or shared.inspect(transport) != before:
            raise shared.Refusal('cable-lost')
        remaining(deadline)
        before['_capacities_oauth'] = result
        before['_executable_sha256'] = fingerprint if result['status'] == 'captured' else None
        return before
    finally:
        sftp.close()


def main():
    timer = None
    lock, responded = threading.Lock(), False
    value = None
    exchange = None

    def disposition(settled):
        if value is None or value['selector'] != 'exchange':
            return None
        return 'not-sent' if settled and (exchange is None or not exchange.possible) else 'possibly-sent'

    def fail(status, settled=False):
        return {'contract_version': 1, 'status': status, 'observation': None, 'capacities_oauth': None,
                'executable_sha256': None, 'secret_disposition': disposition(settled)}

    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                print(json.dumps(value), flush=True)

    try:
        # The host recalculates the child budget only after this fixed ready
        # line. Anchoring just before the line charges transit and scheduling.
        started = time.monotonic()
        print('capacities-oauth-ready-v1', flush=True)
        value = request(sys.stdin.buffer.read(MAX_REQUEST + 1))
        if sys.platform not in ('linux', 'win32'):
            raise shared.Refusal('unsupported-host')
        deadline = started + value['budget_ms'] / 1000

        def expire():
            respond(fail('timeout'))
            os._exit(0)

        timer = threading.Timer(remaining(deadline), expire)
        timer.daemon = True
        timer.start()
        import paramiko
        if paramiko.__version__ != '5.0.0':
            raise shared.Refusal('unconfigured')
        expected = value['binding']['connection_id']
        if sys.platform == 'win32':
            import windows_wired
            config = windows_wired.load_config(os.environ['MANAGER_WIRED_CONFIG'])
        else:
            config = shared.load_config(os.environ['MANAGER_WIRED_CONFIG'])

        def pre_send():
            sample = (windows_wired.Windows().snapshot(config) if sys.platform == 'win32'
                      else shared.wired_snapshot(config))
            if hashlib.sha256(json.dumps(sample, sort_keys=True).encode()).hexdigest() != expected:
                raise shared.Refusal('cable-lost')

        if value['selector'] == 'exchange':
            exchange = Exchange(value['proof'], value['executable_sha256'], pre_send)

        def inspect(transport):
            return execute(transport, value, deadline, paramiko.SFTPClient.from_transport, exchange)

        if sys.platform == 'win32':
            observation = windows_wired.observe(config, shared, inspection=inspect, expected_connection=expected)
        else:
            observation = shared.observe(config, inspection=inspect, expected_connection=expected)
        report = observation.pop('_capacities_oauth')
        fingerprint = observation.pop('_executable_sha256')
        remaining(deadline)
        respond({'contract_version': 1, 'status': 'observed', 'observation': observation, 'capacities_oauth': report,
                 'executable_sha256': fingerprint, 'secret_disposition': disposition(True)})
    except shared.Refusal as error:
        respond(fail(error.status, settled=True))
    except Exception:
        respond(fail('observation-unavailable', settled=True))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
