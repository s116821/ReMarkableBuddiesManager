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
from personalization_transport import COMMAND_PREFIX, select_executable
from runtime_identity_transport import metadata

ATTEST_PREFIX = b'capacities-actor-exe-v1 '
CAPTURE_FIELDS = 'tablet_id connection_id boot_id config_sha256'
BINDING_FIELDS = CAPTURE_FIELDS + ' operation_id grant_id'
BASE_FIELDS = 'contract_version status'
CAPTURE_SELECTORS = ('capture', 'capture-connection')
MUTATION_SELECTORS = ('exchange', 'disconnect')
GRANT_SELECTORS = ('grant-status', 'disconnect')
GRANT_PHASES = ('absent', 'pending-exchange', 'staged', 'active', 'pending-rotation',
                'local-disabled', 'revocation-pending', 'revoked', 'retired-unconfirmed')
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
    if selector not in (*CAPTURE_SELECTORS, *MUTATION_SELECTORS, 'status', 'grant-status'):
        raise ValueError('request refused')
    mutation = selector in MUTATION_SELECTORS
    fields = 'selector budget_ms binding'
    if mutation:
        fields += ' executable_sha256'
    if selector == 'exchange':
        fields += ' proof'
    if selector in GRANT_SELECTORS:
        fields += ' space_id'
    if selector == 'disconnect':
        fields += ' expected_grant_sha256'
    exact(value, fields)
    if type(value['budget_ms']) is not int or not 1 <= value['budget_ms'] <= (EXCHANGE_MAX_MS if mutation else READ_MAX_MS):
        raise ValueError('request refused')
    binding = value['binding']
    exact(binding, 'connection_id boot_id' if selector in CAPTURE_SELECTORS else BINDING_FIELDS)
    if not digest(binding['connection_id']) or not uuid(binding['boot_id']):
        raise ValueError('request refused')
    if selector not in CAPTURE_SELECTORS and (
            not digest(binding['config_sha256'])
            or not all(uuid(binding[key]) for key in ('tablet_id', 'grant_id', 'operation_id'))
            or binding['operation_id'] == binding['grant_id']):
        raise ValueError('request refused')
    if (mutation and not digest(value['executable_sha256'])
            or selector in GRANT_SELECTORS and not uuid(value['space_id'])
            or selector == 'disconnect' and not digest(value['expected_grant_sha256'])):
        raise ValueError('request refused')
    if selector == 'exchange':
        proof = value['proof']
        exact(proof, 'code verifier client_id redirect_uri resource')
        if (not text(proof['code'], 4096) or not text(proof['client_id'], 256)
                or not isinstance(proof['verifier'], str)
                or not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}', proof['verifier'])
                or proof['redirect_uri'] != 'http://127.0.0.1:48761/oauth/capacities/callback'
                or proof['resource'] != 'https://api.capacities.io'):
            raise ValueError('request refused')
    return value


def receipt(value, selector, binding, space=None):
    if not isinstance(value, dict) or type(value.get('contract_version')) is not int or value['contract_version'] != 1:
        raise ValueError('report refused')
    status = value.get('status')
    if selector in CAPTURE_SELECTORS:
        if status == 'unresolved':
            exact(value, BASE_FIELDS)
        elif status == 'captured':
            extra = ' connection' if selector == 'capture-connection' else ''
            exact(value, BASE_FIELDS + ' ' + CAPTURE_FIELDS + extra)
            if (not uuid(value['tablet_id']) or not digest(value['config_sha256'])
                    or any(value[key] != binding[key] for key in ('boot_id', 'connection_id'))):
                raise ValueError('report refused')
            connection = value.get('connection')
            if connection is not None:
                exact(connection, 'grant_id space_id')
                if not uuid(connection['grant_id']) or not uuid(connection['space_id']):
                    raise ValueError('report refused')
        else:
            raise ValueError('report refused')
        return value
    if selector in GRANT_SELECTORS:
        exact(value, BASE_FIELDS + ' ' + BINDING_FIELDS + ' space_id phase grant_sha256 observed_operation_id')
        allowed = ('observed', 'unresolved', 'conflict') if selector == 'grant-status' else (
            'refused', 'conflict', 'local-disabled', 'revoked', 'unresolved')
        if (status not in allowed or space != value['space_id']
                or any(value[key] != binding[key] for key in BINDING_FIELDS.split())
                or value['phase'] not in (None, *GRANT_PHASES)
                or value['grant_sha256'] is not None and not digest(value['grant_sha256'])
                or value['observed_operation_id'] is not None and not uuid(value['observed_operation_id'])
                or status == 'observed' and value['phase'] is None
                or status == 'observed' and value['phase'] in ('local-disabled', 'revocation-pending', 'revoked')
                and not digest(value['grant_sha256'])
                or status == 'local-disabled' and (value['phase'] != 'local-disabled' or not digest(value['grant_sha256']))
                or status == 'revoked' and (value['phase'] != 'revoked'
                    or not digest(value['grant_sha256']) or value['observed_operation_id'] != binding['operation_id'])):
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


def executable_digest(transport, executable, deadline):
    deadline = min(deadline - POSTFLIGHT_SECONDS, time.monotonic() + 8)
    channel = transport.open_session(timeout=min(2, remaining(deadline)))
    try:
        channel.settimeout(min(2, remaining(deadline)))
        channel.exec_command(f'/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C sha256sum -- {executable}')
        channel.shutdown_write()
        output = bytearray()
        if drain(channel, deadline, output, maximum=128, diagnostics=0) != 0:
            raise ValueError('executable read refused')
        witness = re.fullmatch(rb'([a-f0-9]{64}) [ *]' + re.escape(executable.encode('ascii')) + rb'\n', output)
        if not witness:
            raise ValueError('executable read refused')
        return witness[1].decode('ascii')
    finally:
        channel.close()


def installed_metadata(sftp, executable):
    sampled = metadata(sftp, executable)
    # Reuse the existing metadata gate. Its last row is the executable leaf
    # (mode, uid, gid, size, mtime) after the protected ancestors.
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


def admission_deadline(deadline, mutation):
    return deadline - POSTFLIGHT_SECONDS - (ACTOR_MAX_MS / 1000 if mutation else 0)


def actor(transport, selector, binding, deadline, exchange=None, grant=None, *, executable, check_installation=None):
    actor_deadline = deadline - POSTFLIGHT_SECONDS
    admission = admission_deadline(deadline, exchange is not None)
    channel = transport.open_session(timeout=min(2, remaining(admission)))
    attempt = bytearray()
    output = bytearray()
    try:
        channel.settimeout(min(2, remaining(admission)))
        attestation = ' REMARKABLE_BUDDIES_CAPACITIES_ATTEST=1' if exchange is not None else ''
        channel.exec_command(f'{COMMAND_PREFIX}{attestation} {executable} --capacities-oauth')
        if exchange is not None:
            confirm_executable(channel, exchange.executable_sha256, admission)
            if check_installation is not None:
                check_installation()
            exchange.pre_send()
            if not transport.is_active():
                raise shared.Refusal('cable-lost')
        available = int(remaining(actor_deadline) * 1000)
        if available < (ACTOR_MAX_MS if exchange is not None else 1):
            raise shared.Refusal('timeout')
        message = {'contract_version': 1, 'selector': selector, 'binding': binding,
                   'budget_ms': min(ACTOR_MAX_MS, available)}
        if selector == 'exchange':
            message['proof'] = exchange.proof
        if grant is not None:
            message.update(grant)
        attempt.extend(json.dumps(message, separators=(',', ':'), ensure_ascii=True).encode('ascii'))
        if len(attempt) > MAX_REQUEST:
            raise ValueError('request refused')
        channel.settimeout(min(2, remaining(actor_deadline)))
        if exchange is not None and remaining(actor_deadline) < ACTOR_MAX_MS / 1000:
            raise shared.Refusal('timeout')
        if exchange is not None:
            exchange.possible = True
        channel.sendall(attempt)
        channel.shutdown_write()
        if drain(channel, actor_deadline, output) != 0 or not output.endswith(b'\n') or output.count(b'\n') != 1:
            raise ValueError('report refused')
        return receipt(parse(output, MAX_RESPONSE), selector, binding, grant and grant['space_id'])
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
    admission = admission_deadline(deadline, selector in MUTATION_SELECTORS)
    executable = select_executable(transport, before['service']['LoadState'], deadline=admission)
    remaining(admission)
    sftp = open_sftp(transport)
    try:
        def sample_metadata(until):
            sftp.get_channel().settimeout(min(2, remaining(until)))
            sampled = installed_metadata(sftp, executable)
            remaining(until)
            return sampled

        installed = sample_metadata(admission)

        def check_installation():
            if sample_metadata(admission) != installed:
                raise ValueError('actor changed')

        fingerprint = None
        if selector in MUTATION_SELECTORS:
            capture = {key: binding[key] for key in ('connection_id', 'boot_id')}
            capture_selector = 'capture' if selector == 'exchange' else 'capture-connection'
            actual = actor(transport, capture_selector, capture, min(deadline, time.monotonic() + 8),
                           executable=executable)
            if actual['status'] != 'captured' or any(actual[key] != binding[key] for key in CAPTURE_FIELDS.split()):
                raise shared.Refusal('cable-lost')
            if selector == 'disconnect' and actual.get('connection') != {
                    'grant_id': binding['grant_id'], 'space_id': value['space_id']}:
                raise shared.Refusal('cable-lost')
            check_installation()
        elif selector in CAPTURE_SELECTORS:
            fingerprint = executable_digest(transport, executable, deadline)
            check_installation()
        if selector in GRANT_SELECTORS:
            grant = {key: value[key] for key in ('space_id', 'expected_grant_sha256') if key in value}
            result = actor(transport, selector, binding, deadline, exchange, grant,
                           executable=executable, check_installation=check_installation)
        else:
            result = actor(transport, selector, binding, deadline, exchange, executable=executable,
                           check_installation=check_installation)
        remaining(deadline)
        if sample_metadata(deadline) != installed or shared.inspect(transport) != before:
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
    stdout = sys.stdout.buffer

    def disposition(settled):
        if value is None or value['selector'] not in MUTATION_SELECTORS:
            return {'secret_disposition': None}
        field = 'secret_disposition' if value['selector'] == 'exchange' else 'operation_disposition'
        return {field: 'not-sent' if settled and (exchange is None or not exchange.possible) else 'possibly-sent'}

    def fail(status, settled=False):
        return {'contract_version': 1, 'status': status, 'observation': None, 'capacities_oauth': None,
                'executable_sha256': None, **disposition(settled)}

    def respond(value):
        nonlocal responded
        with lock:
            if not responded:
                responded = True
                stdout.write(json.dumps(value, ensure_ascii=True).encode('ascii') + b'\n')
                stdout.flush()

    try:
        # The host recalculates the child budget only after this fixed ready
        # line. Anchoring just before the line charges transit and scheduling.
        started = time.monotonic()
        stdout.write(b'capacities-oauth-ready-v1\n')
        stdout.flush()
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

        if value['selector'] in MUTATION_SELECTORS:
            exchange = Exchange(value.get('proof'), value['executable_sha256'], pre_send)

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
                 'executable_sha256': fingerprint, **disposition(True)})
    except shared.Refusal as error:
        respond(fail(error.status, settled=True))
    except Exception:
        respond(fail('observation-unavailable', settled=True))
    finally:
        if timer:
            timer.cancel()


if __name__ == '__main__':
    main()
