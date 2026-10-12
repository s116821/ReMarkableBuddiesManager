import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseOwnedReport } from '../host/owned-report.mjs';
import { WiredObserver } from '../host/observer.mjs';
import { OwnedDataController } from '../src/owned-data.ts';
import { resolveDeviceProfile } from '../src/device-profile.ts';
import { ownedReport, tablet, inspection } from './fixtures/owned-report.mjs';

test('versioned report preserves incomplete/omitted/shared accounting and refuses unsafe/future shapes', () => {
  const report = ownedReport();
  const parsed = parseOwnedReport(report);
  assert.equal(parsed.complete_apparent_bytes, null);
  assert.equal(parsed.storage.cache, undefined);
  assert.equal(parsed.observed_domains.conversation.omitted_references, 4);
  assert.equal(parsed.reference_totals_additive, false);
  for (const patch of [{ report_version: 2 }, { credentials_inspected: true }, { native_documents_inspected: true },
    { observed_apparent_bytes: Number.MAX_SAFE_INTEGER + 1 }, { complete_apparent_bytes: 1024 },
    { password: 'PROTECTED_SENTINEL' }, { issues: { 'SECRET_SENTINEL': 1 } }, { storage: { arbitrary: { files: 0, apparent_bytes: 0 } } }]) {
    assert.throws(() => parseOwnedReport({ ...report, ...patch }));
  }
  for (const status of ['busy', 'unavailable', 'unsupported', 'complete']) assert.equal(parseOwnedReport(ownedReport(status)).status, status);
});
test('central profile never admits unknown/conflicting observation or claims installation', () => {
  const state = { status: 'observed', observation: tablet, checkedAt: null };
  assert.equal(resolveDeviceProfile(state).inspection, true);
  assert.equal(resolveDeviceProfile(state).installation, false);
  for (const patch of [{ firmware_conflict: true }, { architecture: null }, { firmware: null }, { model: null }]) {
    assert.equal(resolveDeviceProfile({ ...state, observation: { ...tablet, ...patch } }).inspection, false);
  }
  assert.equal(resolveDeviceProfile({ ...state, status: 'checking' }).inspection, false);
});
test('controller drops cancelled late and changed-session reports, then preserves partial and unavailable states', async () => {
  const controller = new OwnedDataController(() => {});
  let finish;
  const pending = controller.inspect({ inspectOwned: () => new Promise(resolve => { finish = resolve; }) }, tablet);
  controller.clear(); finish(inspection(ownedReport())); await pending;
  assert.equal(controller.state.report, null);
  await controller.inspect({ inspectOwned: async () => ({ ...inspection(ownedReport()), observation: { ...tablet, boot_id: '22222222-2222-2222-2222-222222222222' } }) }, tablet);
  assert.equal(controller.state.report, null);
  await controller.inspect({ inspectOwned: async () => inspection(ownedReport()) }, tablet);
  assert.equal(controller.state.status, 'Inspection partial');
  assert.equal(controller.state.report.observed_domains.conversation.missing_references, 1);
  await controller.inspect({ inspectOwned: async () => ({ ...inspection(null), inspection: { status: 'unsupported', report: null } }) }, tablet);
  assert.equal(controller.state.status, 'Installed Buddy inspection unsupported');
  assert.equal(controller.state.report, null);
});
test('actual host subprocess bounds/sanitizes report and refuses changed identity before renderer handoff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-inspection-host-'));
  try {
    const runtime = process.execPath;
    const script = path.join(root, 'fixture.mjs');
    const observer = new WiredObserver({ platform: 'linux', config: path.join(root, 'config'), python: runtime, script });
    const observed = { contract_version: 1, status: 'observed', observation: tablet };
    const publish = async (report, changed = false) => writeFile(script, `console.log(JSON.stringify(process.argv.includes('inspect-owned') ? ${JSON.stringify({ ...inspection(report), observation: changed ? { ...tablet, connection_id: 'b'.repeat(64) } : tablet })} : ${JSON.stringify(observed)}));`);
    await publish(ownedReport());
    assert.equal((await observer.inspectOwned()).status, 'observation-unavailable');
    assert.equal((await observer.observe()).status, 'observed');
    assert.equal((await observer.inspectOwned()).inspection.report.status, 'partial');
    await publish({ ...ownedReport(), password: 'PROTECTED_SENTINEL' });
    const invalid = await observer.inspectOwned();
    assert.equal(invalid.inspection.status, 'unavailable');
    assert.equal(JSON.stringify(invalid).includes('PROTECTED_SENTINEL'), false);
    await publish({ ...ownedReport(), report_version: 2 });
    assert.equal((await observer.inspectOwned()).inspection.status, 'unsupported');
    await publish(ownedReport(), true);
    assert.equal((await observer.inspectOwned()).status, 'cable-lost');
    assert.equal((await observer.inspectOwned()).status, 'observation-unavailable');
    observer.cancel();
  } finally { await rm(root, { recursive: true }); }
});

test('parser consumes actual immutable Main CLI reports, preserving complete versus incomplete inventory', async () => {
  const { readFile } = await import('node:fs/promises');
  const reports = JSON.parse(await readFile(new URL('./fixtures/main-6b-owned-reports.json', import.meta.url), 'utf8'));
  for (const [status, report] of Object.entries(reports)) {
    const parsed = parseOwnedReport(report);
    assert.equal(parsed.status, status);
    assert.equal(parsed.complete_apparent_bytes === null, status !== 'complete');
  }
  assert.deepEqual(Object.keys(reports.complete.observed_domains).sort(), ['conversation', 'export-association', 'handwriting', 'source', 'subject-memory']);
  assert.equal(reports.partial.cache_inspected, false);
  assert.equal(reports.busy.issues['busy-writer'], 1);
  assert.equal(reports.unavailable.issues['configuration-unavailable'], 1);
});
