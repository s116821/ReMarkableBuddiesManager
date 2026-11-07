"""Deterministic SSH stream scheduling; no transport, tablet or wall-clock waits."""
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'host'))
import service_stop_sampler as sampler
import service_stop_transport as transport
import wired_observer as shared


class Clock:
    def __init__(self):
        self.now = 100.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class ScheduledChannel:
    """None is actual EOF; a future/absent event is temporarily unavailable."""
    def __init__(self, clock, stdout, stderr, status_at=0.0):
        self.clock = clock
        self.streams = {
            'stdout': [(100.0 + at, data) for at, data in stdout],
            'stderr': [(100.0 + at, data) for at, data in stderr],
        }
        self.eof = {'stdout': False, 'stderr': False}
        self.status_at = 100.0 + status_at
        self.commands = []
        self.reads = []
        self.timeouts = []
        self.closed = self.write_closed = False

    def settimeout(self, value):
        self.timeouts.append(value)

    def exec_command(self, command):
        self.commands.append(command)

    def shutdown_write(self):
        self.write_closed = True

    def ready(self, name):
        events = self.streams[name]
        return bool(events and events[0][0] <= self.clock.now and events[0][1] is not None)

    def recv_ready(self):
        return self.ready('stdout')

    def recv_stderr_ready(self):
        return self.ready('stderr')

    def read(self, name, maximum):
        self.reads.append(name)
        if self.eof[name]:
            return b''
        events = self.streams[name]
        if not events or events[0][0] > self.clock.now:
            raise socket.timeout()
        at, data = events.pop(0)
        if data is None:
            self.eof[name] = True
            return b''
        if len(data) > maximum:
            events.insert(0, (at, data[maximum:]))
        return data[:maximum]

    def recv(self, maximum):
        return self.read('stdout', maximum)

    def recv_stderr(self, maximum):
        return self.read('stderr', maximum)

    def exit_status_ready(self):
        return self.clock.now >= self.status_at

    def recv_exit_status(self):
        return 0

    def close(self):
        self.closed = True


class ReceiveCompletion(unittest.TestCase):
    def run_channel(self, stdout, stderr, cap=32768, status_at=0.0):
        clock = Clock()
        channel = ScheduledChannel(clock, stdout, stderr, status_at)
        connection = Mock()
        connection.open_session.return_value = channel
        with patch.object(sampler.time, 'monotonic', clock.monotonic), \
                patch.object(sampler.time, 'sleep', clock.sleep):
            try:
                result = sampler.run_fixed(connection, 'fixed-read-only-fixture', 100.05, cap)
                return result, channel
            finally:
                self.assertTrue(channel.closed)
                self.assertTrue(channel.write_closed)
                self.assertEqual(channel.commands, ['fixed-read-only-fixture'])
                connection.open_session.assert_called_once()

    def test_status_before_delayed_stdout_does_not_truncate(self):
        result, channel = self.run_channel(
            [(0, b'first'), (.01, b'-last'), (.02, None)], [(0, None)])
        self.assertEqual(result, (0, b'first-last', b''))
        self.assertTrue(all(channel.eof.values()))

    def test_status_before_delayed_stderr_does_not_hide_diagnostics(self):
        result, channel = self.run_channel(
            [(0, b'complete'), (0, None)], [(.01, b'late diagnostic'), (.02, None)])
        self.assertEqual(result, (0, b'complete', b'late diagnostic'))
        self.assertTrue(all(channel.eof.values()))

    def test_late_stdout_over_cap_refuses(self):
        with self.assertRaises(ValueError):
            self.run_channel([(0, b'ok'), (.01, b'oversized'), (.02, None)], [(0, None)], cap=4)

    def test_late_stderr_over_cap_refuses(self):
        with self.assertRaises(ValueError):
            self.run_channel([(0, None)], [(.01, b'x' * 8193), (.02, None)])

    def test_missing_eof_on_either_stream_uses_original_deadline(self):
        for stdout, stderr in [([(0, b'partial')], [(0, None)]), ([(0, None)], [])]:
            with self.subTest(stdout=bool(stdout[0][1])):
                with self.assertRaises(shared.Refusal) as raised:
                    self.run_channel(stdout, stderr)
                self.assertEqual(raised.exception.status, 'timeout')

    def test_complete_both_eofs_wait_for_status(self):
        result, channel = self.run_channel(
            [(0, b'body'), (.01, None)], [(0, b'diagnostic'), (.02, None)], status_at=.03)
        self.assertEqual(result, (0, b'body', b'diagnostic'))
        self.assertTrue(all(channel.eof.values()))
        self.assertIn(0.0, channel.timeouts)

    def test_stdout_backlog_does_not_starve_stderr_bound(self):
        with self.assertRaises(ValueError):
            self.run_channel([(0, b'x' * 16384), (0, None)], [(0, b'e' * 8193), (0, None)])

    def test_submitted_stop_with_missing_eof_stays_unknown_without_replay(self):
        # Exercise the real main/execute failure reducer, with only local synthetic
        # profile/inspection seams admitted. Neither production registry changes.
        request = dict(connection_id='a' * 64,
                       boot_id='11111111-1111-4111-8111-111111111111',
                       selector='stop', budget_ms=50,
                       expected=dict(profile='ordinary-manual', sample_sha256='b' * 64))
        clock = Clock()
        channel = ScheduledChannel(clock, [(0, None)], [])
        connection = Mock()
        connection.open_session.return_value = channel
        output = io.StringIO()

        def observe(_config, inspection, expected_connection):
            self.assertEqual(expected_connection, request['connection_id'])
            return inspection(connection)

        with patch.object(sampler.time, 'monotonic', clock.monotonic), \
                patch.object(sampler.time, 'sleep', clock.sleep), \
                patch.object(transport, 'QUALIFIED_PROFILES', ('ordinary-manual',)), \
                patch.object(transport, 'Sampler') as sample, \
                patch.object(transport.threading, 'Timer'), \
                patch.object(transport.sys, 'platform', 'linux'), \
                patch.object(transport.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))), \
                patch.dict(sys.modules, {'paramiko': SimpleNamespace(__version__='5.0.0')}), \
                patch.dict(os.environ, {'MANAGER_WIRED_CONFIG': 'synthetic-not-read'}), \
                patch.object(shared, 'load_config', return_value={}), \
                patch.object(shared, 'observe', side_effect=observe), \
                patch.object(shared, 'inspect', return_value=dict(boot_id=request['boot_id'])), \
                contextlib.redirect_stdout(output):
            sample.return_value.bracket.return_value = (transport.empty_raw('review'), 'b' * 64)
            transport.main()

        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['service_stop_raw']['command'], 'unknown')
        self.assertEqual(result['service_stop_raw']['reason'], 'unavailable')
        self.assertIsNone(result['observation'])
        self.assertEqual(channel.commands, [transport.STOP_COMMAND])
        self.assertTrue(channel.closed)
        connection.open_session.assert_called_once()


if __name__ == '__main__':
    unittest.main()
