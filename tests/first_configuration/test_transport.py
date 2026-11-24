"""Fixed command and readback tests with synthetic wired observations."""
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'host'))
import first_configuration_transport as config
import personalization_transport as personalization
import wired_observer as wired


BOOT = '11111111-1111-1111-1111-111111111111'
CONNECTION = 'a' * 64
EXECUTABLE = 'b' * 64
OTHER = 'c' * 64
SERVICE = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead'}
OBSERVATION = {'boot_id': BOOT, 'service': SERVICE}
RESIDENT = '/home/root/.local/lib/remarkable-buddies/reader-buddy'
STANDALONE = '/opt/bin/reader-buddy'
ENV = ('/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin '
       'REMARKABLE_BUDDIES_CONFIG=/home/root/.config/remarkable-buddies/config.json')


def frame(selector, expected=None, service=SERVICE):
    return {'selector': selector, 'connection_id': CONNECTION, 'boot_id': BOOT, 'budget_ms': 12000,
            'service': service, 'expected_executable_sha256': expected}


class FirstConfigurationTransport(unittest.TestCase):
    def test_request_only_accepts_closed_fixed_selectors(self):
        for request in [frame('check-initial'), frame('create-initial'), frame('check-existing-default'),
                        frame('create-existing-default', EXECUTABLE)]:
            self.assertEqual(config.request(json.dumps(request).encode()), request)
        for request in [frame('inspect'), frame('create-existing-default'), frame('create-initial', EXECUTABLE),
                        frame('check-existing-default', service=dict(SERVICE, LoadState='not-found')),
                        frame('check-existing-default', service=dict(SERVICE, ActiveState='active')),
                        dict(frame('check-existing-default'), path='/foreign')]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                config.request(json.dumps(request).encode())

    def test_recognizes_fixed_resident_launcher_without_arguments(self):
        for path, args in [(STANDALONE, ''), (RESIDENT, ' --config /foreign'), ('/tmp/reader-buddy', '')]:
            transport = Mock()
            record = f'{{ path={path} ; argv[]={path}{args} ; ignore_errors=no }}'.encode()
            with patch.object(personalization, 'reply', return_value=(0, record)), self.assertRaises(wired.Refusal):
                config.resident_identity(transport, SERVICE, time.monotonic() + 1)
            transport.open_session.return_value.exec_command.assert_called_once_with(personalization.LAUNCHER_QUERY)

    def exercise(self, selector, *, hashes=(EXECUTABLE, EXECUTABLE), expected=None, report=None, reply_error=False):
        transport, submitted = Mock(), Mock()
        selectors = []
        identity = iter(hashes)
        observation = dict(OBSERVATION)

        def exchange(peer, command, _, output, limit, on_submit=None, *, require_eof):
            self.assertIs(peer, transport)
            self.assertTrue(require_eof)
            if '--configuration-operation' not in command:
                self.assertEqual(command, f'/usr/bin/env -i PATH=/usr/bin:/bin sha256sum {RESIDENT}')
                output.extend(f'{next(identity)}  {RESIDENT}'.encode() + b'\n')
                return 0
            self.assertEqual(limit, 4096)
            executable = RESIDENT if selector.endswith('existing-default') else STANDALONE
            self.assertEqual(command, f'{ENV} {executable} --configuration-operation {selector}')
            selectors.append(selector)
            on_submit()
            output.extend(report if report is not None else
                          (json.dumps({'report_version': 1, 'operation': selector,
                                       'state': 'created' if selector.startswith('create-') else 'missing'}) + '\n').encode())
            return 0

        value = frame(selector, expected)
        with (patch.object(config.shared, 'inspect', side_effect=lambda _: dict(observation)),
              patch.object(config, 'select_executable', return_value=RESIDENT),
              patch.object(config.transport_common, 'exchange_no_input', side_effect=exchange)):
            if reply_error:
                with self.assertRaises((wired.Refusal, ValueError)):
                    config.execute(transport, value, time.monotonic() + 3, submitted)
                return selectors, submitted.call_count
            result = config.execute(transport, value, time.monotonic() + 3, submitted)
            return result['_first_config'], submitted.call_count

    def test_fixed_route_and_exactly_one_submit(self):
        for selector, expected, digest, state in [
            ('check-existing-default', None, EXECUTABLE, 'missing'),
            ('create-existing-default', EXECUTABLE, EXECUTABLE, 'created'),
            ('check-initial', None, None, 'missing'),
            ('create-initial', None, None, 'created'),
        ]:
            with self.subTest(selector=selector):
                self.assertEqual(self.exercise(selector, expected=expected),
                                 (({'report_version': 1, 'operation': selector, 'state': state}, digest), 1))

    def test_changed_binary_refuses_before_dispatch_or_leaves_possible_after_dispatch(self):
        selector = 'create-existing-default'
        self.assertEqual(self.exercise(selector, hashes=(OTHER,), expected=EXECUTABLE, reply_error=True), ([], 0))
        self.assertEqual(self.exercise(selector, hashes=(EXECUTABLE, OTHER), expected=EXECUTABLE, reply_error=True),
                         ([selector], 1))

    def test_malformed_and_mismatched_reports_cannot_confirm_the_original(self):
        for report in [
            b'{"report_version":1,"operation":"create-initial","state":"created"}\n',
            b'{"report_version":1,"operation":"create-existing-default","state":"missing"}\n',
            b'{"report_version":1,"report_version":1,"operation":"create-existing-default","state":"created"}\n',
            b'{"report_version":1,"operation":"create-existing-default","state":"created"}\n{}\n',
        ]:
            with self.subTest(report=report):
                self.assertEqual(self.exercise('create-existing-default', expected=EXECUTABLE,
                                               report=report, reply_error=True), (['create-existing-default'], 1))
