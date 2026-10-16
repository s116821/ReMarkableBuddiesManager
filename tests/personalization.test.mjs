import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalizationController, editText, rawOffset } from '../src/personalization.ts';
import { parsePersonalizationRequest, parsePersonalizationReport } from '../host/personalization.mjs';
import { tablet } from './fixtures/owned-report.mjs';
const text = '  first\r\n第二行 🦊\n\t ';
const report = (operation = 'inspect', value = text, enabled = true) => ({ report_version: 1, operation, status: 'ok', disk_reload_verified: true, runtime_activation: operation === 'inspect' ? 'unverified' : 'restart-required', config_sha256: 'c'.repeat(64), personalization: { schema_version: 1, enabled, text: value } });
const value = r => ({ contract_version: 1, status: 'observed', observation: tablet, personalization: { status: 'reported', outcome: r.operation === 'inspect' ? 'read-only' : r.status === 'ok' ? 'verified' : 'unknown', report: r } });
const request = { operation: 'set', connection_id: tablet.connection_id, boot_id: tablet.boot_id, expected_config_sha256: 'c'.repeat(64), enabled: true, text };
test('strict request/report preserve Unicode CRLF and refuse arbitrary paths, malformed fields, NUL and UTF8 byte overflow', () => {
  assert.equal(parsePersonalizationRequest(request).text, text);
  for (const v of [{ ...request, path: '/unowned' }, { ...request, text: '\0' }, { ...request, text: '\ud800' }, { ...request, text: '🦊'.repeat(4097) }, { ...request, enabled: 'true' }]) assert.throws(() => parsePersonalizationRequest(v));
  assert.doesNotThrow(() => parsePersonalizationRequest({ ...request, text: '🦊'.repeat(4096) }));
  for (const r of [{ ...report(), token: 'PRIVATE_SENTINEL' }, { ...report(), runtime_activation: 'active' }, { ...report(), report_version: 2 }, { ...report(), disk_reload_verified: false }]) assert.throws(() => parsePersonalizationReport(r, 'inspect'));
});
test('textarea edits retain unchanged CRLF and paste offsets address exact raw text', () => {
  assert.equal(editText('a\r\nb\r\nc', 'a\nbb\nc'), 'a\r\nbb\r\nc');
  assert.equal(editText(text, text.replace(/\r\n/g, '\n')), text);
  assert.equal(rawOffset('a\r\nb', 2), 3);
});
test('shared controller actual value/readback semantics distinguish disk saved from runtime activation', async () => {
  const c = new PersonalizationController(() => {}); const calls = [];
  const adapter = { personalization: async q => { calls.push(q); return value(report(q.operation, q.operation === 'clear' ? '' : q.operation === 'set' ? q.text : text, q.operation === 'disable' || q.operation === 'clear' ? false : true)); } };
  await c.run(adapter, tablet, 'inspect'); assert.match(c.state.status, /activation unverified/);
  await c.run(adapter, tablet, 'set', text, true); assert.match(c.state.status, /restart required/); assert.equal(c.state.report.personalization.text, text);
  await c.run(adapter, tablet, 'disable'); assert.equal(c.state.report.personalization.text, text); assert.equal(c.state.report.personalization.enabled, false);
  await c.run(adapter, tablet, 'clear'); assert.equal(c.state.report.personalization.text, '');
  assert.equal(calls[1].expected_config_sha256, 'c'.repeat(64)); assert.equal(Object.keys(calls[1]).includes('path'), false);
});
test('controller refuses conflicting readback, failed mutations and stale results after identity/disconnect', async () => {
  const c = new PersonalizationController(() => {}); await c.run({ personalization: async () => value(report()) }, tablet, 'inspect');
  await c.run({ personalization: async () => value(report('set', 'wrong')) }, tablet, 'set', text, true); assert.equal(c.state.unknown, true); assert.equal(c.state.report, null);
  await c.run({ personalization: async () => value(report()) }, tablet, 'inspect');
  let finish; const pending = c.run({ personalization: () => new Promise(r => { finish = r; }) }, tablet, 'set', text, true);
  c.clear(); finish(value(report('set'))); await pending; assert.equal(c.state.unknown, true); assert.equal(c.state.report, null);
  await c.run({ personalization: async () => value(report()) }, tablet, 'inspect');
  const fail = { report_version: 1, operation: 'set', status: 'conflict', disk_reload_verified: false, runtime_activation: 'unverified', config_sha256: null, personalization: null };
  await c.run({ personalization: async () => value(fail) }, tablet, 'set', text, true); assert.match(c.state.status, /conflict/); assert.equal(c.state.unknown, true);
});
