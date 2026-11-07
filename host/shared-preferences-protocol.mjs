import {parsePortableArtifact, portableBytes, portableKeys, portableJson} from './portable-configuration-protocol.mjs';

export const FRAME_LIMIT = 196608;
export const REPORT_LIMIT = 131072;
export const INPUT_LIMIT = 262144;
const fail = () => { throw Error('Shared preferences refused'); };
const exact = (value, names) => {
  if (portableKeys(value) !== names.split(' ').sort().join(',')) fail();
};
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const boundedText = value => typeof value === 'string' && !value.includes('\0') &&
  value.isWellFormed() && new TextEncoder().encode(value).length <= 16384;
export const sameTarget = (a, b) => !!a && !!b &&
  a.connection_id === b.connection_id && a.boot_id === b.boot_id;

function target(value) {
  if (!digest(value.connection_id) || !uuid(value.boot_id)) fail();
}
export function parseSharedPreferenceRequest(value) {
  switch (value?.action) {
    case 'inspect':
      exact(value, 'action connection_id boot_id reveal_text');
      target(value);
      if (typeof value.reveal_text !== 'boolean') fail();
      break;
    case 'edit':
      exact(value, 'action connection_id boot_id reference patch');
      target(value);
      if (!uuid(value.reference)) fail();
      parsePortableArtifact(value.patch);
      break;
    case 'status':
      exact(value, 'action connection_id boot_id reference');
      target(value);
      if (!uuid(value.reference)) fail();
      break;
    case 'retained':
      exact(value, 'action');
      break;
    case 'cancel':
      exact(value, 'action reference');
      if (!uuid(value.reference)) fail();
      break;
    default: fail();
  }
  if (portableBytes(value) > FRAME_LIMIT) fail();
  return value;
}

function guard(value) {
  exact(value, 'group mode_epoch binding_sha256 store_generation local_config_sha256 selection');
  if (![value.group, value.mode_epoch, value.store_generation].every(uuid) ||
      ![value.binding_sha256, value.local_config_sha256].every(digest)) fail();
  const selection = value.selection;
  if (selection?.kind === 'absent') {
    exact(selection, 'kind');
  } else {
    exact(selection, 'kind aggregate_generation accepted_base_sha256 selection_sha256 revision');
    if (selection.kind !== 'selected' || !uuid(selection.aggregate_generation) ||
        !uuid(selection.revision) ||
        ![selection.accepted_base_sha256, selection.selection_sha256].every(digest)) fail();
  }
}

const fields = 'reader_enabled writer_enabled export_destination personalization_enabled research_policy';
function effective(value, reveal, includeText = reveal) {
  exact(value, fields + ' personalization_text_present origins' + (includeText ? ' personalization_text' : ''));
  exact(value.origins, fields + ' personalization_text');
  if (!Object.values(value.origins).every(origin => ['shared', 'local', 'default'].includes(origin)) ||
      ![value.reader_enabled, value.writer_enabled, value.personalization_enabled,
        value.personalization_text_present].every(item => typeof item === 'boolean') ||
      !['mem', 'disabled'].includes(value.export_destination) ||
      !['required', 'disabled'].includes(value.research_policy)) fail();
  if (!includeText) return;
  if (reveal && value.personalization_text_present) {
    if (!boundedText(value.personalization_text) || value.personalization_text.length === 0) fail();
  } else if (value.personalization_text !== null) fail();
}

const viewDispositions = ['established-absent', 'selected'];
const refusals = {
  'busy/not-dispatched': 'busy',
  'unsupported/not-dispatched': 'unsupported',
  'unavailable/not-dispatched': 'unavailable',
  'invalid-input/not-dispatched': 'unavailable'
};
const reportStates = {
  inspect: {...refusals, 'unavailable/unknown': 'unresolved', 'unavailable/not-admitted': 'unavailable',
    'joining/not-admitted': 'joining', 'ok/read-only': 'ready'},
  edit: {...refusals, 'unavailable/not-dispatched': 'not-dispatched', 'invalid-input/not-dispatched': 'not-dispatched',
    'conflict/not-dispatched': 'conflict', 'joining/not-admitted': 'joining', 'unavailable/unknown': 'unknown',
    'ok/no-change': 'no-change', 'ok/local-committed': 'local-committed'},
  status: {...refusals, 'unavailable/unknown': 'unknown', 'ok/local-committed': 'local-committed'}
};

export function parseSharedPreferenceReport(bytes, operation, context, canonical) {
  if (bytes.at(-1) !== 10 || bytes.filter(value => value === 10).length !== 1) fail();
  const report = portableJson(bytes, REPORT_LIMIT);
  if (report?.report_version !== 1 || report.operation !== operation ||
      report.runtime_activation !== 'unverified' || typeof report.status !== 'string' ||
      typeof report.disposition !== 'string') fail();
  const state = reportStates[operation]?.[report.status + '/' + report.disposition];
  if (!state) fail();
  const base = 'report_version operation status disposition runtime_activation';
  if (state === 'ready') {
    exact(report, base + ' guard view');
    guard(report.guard);
    effective(report.view, context.reveal_text);
    return {state, guard: report.guard, view: {group: report.guard.group,
      disposition: report.guard.selection.kind === 'absent' ? 'established-absent' : 'selected',
      effective: {personalization_text: null, ...report.view}}};
  }
  if (operation === 'inspect' || report.status === 'invalid-input') {
    exact(report, base);
  } else {
    exact(report, base + ' guard original_operation patch_sha256');
    guard(report.guard);
    const original = {operation: report.original_operation, guard: report.guard, patch_sha256: report.patch_sha256};
    if (canonical(original) !== canonical(context)) fail();
  }
  return {state};
}

const resultStates = {
  inspect: ['ready', 'joining', 'unresolved', 'busy', 'unavailable', 'unsupported'],
  edit: ['no-change', 'local-committed', 'joining', 'unsupported', 'unavailable', 'busy', 'conflict',
    'not-dispatched', 'unknown', 'invalidated', 'capacity'],
  status: ['local-committed', 'busy', 'unavailable', 'unsupported', 'unknown'],
  retained: ['idle'],
  cancel: ['unknown', 'invalidated']
};

export function parseSharedPreferenceResult(value, context) {
  exact(value, 'state reference view retained');
  if (!resultStates[context.action]?.includes(value.state) || (value.reference !== null && !uuid(value.reference)) ||
      !Array.isArray(value.retained) || value.retained.length > 8 ||
      (context.reference && value.reference !== context.reference)) fail();
  if (value.state === 'ready') {
    exact(value.view, 'group disposition effective');
    if (context.action !== 'inspect' || !uuid(value.reference) || !uuid(value.view.group) ||
        !viewDispositions.includes(value.view.disposition)) fail();
    effective(value.view.effective, context.reveal_text, true);
  } else if (value.view !== null) fail();
  const seen = new Set();
  for (const entry of value.retained) {
    exact(entry, 'reference connection_id boot_id');
    target(entry);
    if (!uuid(entry.reference) || seen.has(entry.reference)) fail();
    seen.add(entry.reference);
  }
  if (portableBytes(value) > FRAME_LIMIT) fail();
  return value;
}

export function sharedPreferenceContext({action, reference, reveal_text}) {
  return {action, reference, reveal_text};
}
