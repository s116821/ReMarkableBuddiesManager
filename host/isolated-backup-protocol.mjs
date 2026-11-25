import {strictJson} from './strict-json.mjs';
import {basicUuid} from './basic-settings-protocol.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parsePortableResult} from './portable-configuration-protocol.mjs';
import {parseRestoreResult} from './ordinary-restore-protocol.mjs';

export const ISOLATED_BACKUP_REQUEST_BYTES = 512;
export const ISOLATED_BACKUP_RESPONSE_BYTES = 2 * 1024 * 1024;
export const BACKUP_PREFERENCES_RESPONSE_BYTES = 9 * 1024;
const MAX_ENTRIES = 4096;
const reference = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
const exact = (value, ...names) => keys(value) === names.join(',') && Object.keys(value).length === names.length;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const refuse = () => { throw new Error('Isolated backup inspection frame refused'); };

export function parseIsolatedBackupJson(input, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ISOLATED_BACKUP_RESPONSE_BYTES ||
      !(input instanceof Uint8Array) || input.byteLength > limit ||
      input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) refuse();
  try { return strictJson(input); } catch { refuse(); }
}

export function parseIsolatedBackupRequest(value) {
  if (value?.version !== 1) refuse();
  switch (value.action) {
    case 'scan':
      if (!exact(value, 'action', 'version')) refuse();
      break;
    case 'select':
      if (!exact(value, 'action', 'choice', 'inspection', 'version') ||
          !reference(value.choice) || !reference(value.inspection)) refuse();
      break;
    case 'download':
      if (!exact(value, 'action', 'operation', 'reference', 'version') ||
          !reference(value.operation) || !reference(value.reference)) refuse();
      break;
    case 'status':
    case 'cancel':
      if (!exact(value, 'action', 'operation', 'version') || !reference(value.operation)) refuse();
      break;
    default:
      refuse();
  }
  return value;
}

export function parseIsolatedBackupBridgeRequest(value) {
  const restore = value?.action === 'preview-restore';
  if (!restore && value?.action !== 'preview-preferences') return parseIsolatedBackupRequest(value);
  const fields = restore ? ['action', 'boot_id', 'connection_id', 'invocation', 'operation', 'reference', 'version'] :
    ['action', 'boot_id', 'connection_id', 'operation', 'reference', 'version'];
  if (!exact(value, ...fields) || value.version !== 1 || !reference(value.operation) || !reference(value.reference) ||
      !reference(value.connection_id) || !basicUuid(value.boot_id) || restore && !basicUuid(value.invocation)) refuse();
  return value;
}

const previewStatuses = new Set(['ready', 'busy', 'invalidated', 'capacity', 'unavailable']);
const preferencesOnly = new Set(['no-change', 'unsupported', 'not-dispatched']);

function parseBackupPreview(value, request, restore) {
  const fields = restore
    ? ['cleanupPending', 'invocation', 'operation', 'preview', 'reference', 'retryable', 'status', 'version']
    : ['cleanupPending', 'operation', 'preview', 'reference', 'retryable', 'status', 'version'];
  if (!exact(value, ...fields) || value.version !== 1 || value.operation !== request.operation ||
      value.reference !== request.reference || restore && value.invocation !== request.invocation ||
      !(previewStatuses.has(value.status) || !restore && preferencesOnly.has(value.status)) ||
      typeof value.retryable !== 'boolean' || typeof value.cleanupPending !== 'boolean' ||
      bytes(value) > BACKUP_PREFERENCES_RESPONSE_BYTES ||
      value.retryable && (value.status !== 'busy' || value.cleanupPending)) refuse();
  if (value.status === 'ready' || value.status === 'no-change') {
    if (value.cleanupPending) refuse();
    const {connection_id, boot_id, invocation} = request;
    const context = {action: 'prepare', connection_id, boot_id};
    if (restore) {
      const v = parseRestoreResult(value.preview, {...context, invocation}, validateResult).ordinary_restore;
      if (v.state !== 'ready' || v.preview.source.configuration_included || v.preview.target.configuration_included) refuse();
    } else if (parsePortableResult(value.preview, context, validateResult).portable_configuration.state !== value.status) refuse();
  } else if (value.preview !== null) refuse();
  return value;
}

export function parseBackupPreferencesResult(value, request) { return parseBackupPreview(value, request, false); }
export function parseBackupRestoreResult(value, request) { return parseBackupPreview(value, request, true); }

export function parseIsolatedBackupBridgeResult(value, request) {
  if (request.action === 'preview-restore') return parseBackupRestoreResult(value, request);
  if (request.action === 'preview-preferences') return parseBackupPreferencesResult(value, request);
  return parseIsolatedBackupResult(value, request);
}

const statuses = new Set([
  'scanning', 'selecting', 'observed', 'empty', 'selected', 'unqualified', 'unavailable',
  'invalid', 'incomplete', 'invalidated', 'unsupported', 'busy',
]);
const downloadStatuses = new Set([
  'downloading', 'verified', 'unavailable', 'invalid', 'incomplete', 'invalidated',
  'insufficient-space', 'verification-failed', 'busy',
]);
const count = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function parseDownloadResult(value, request) {
  const {operation, status, inspection, cleanupPending} = value;
  if (value.version !== 1 || !reference(operation) || !downloadStatuses.has(status) ||
      typeof cleanupPending !== 'boolean' ||
      (['downloading', 'verified', 'busy'].includes(status) && cleanupPending)) refuse();
  if (status === 'verified') {
    if (!exact(inspection, 'completeMedia', 'declaredSettings', 'manifests', 'markerSha256', 'objects') ||
        !reference(inspection.markerSha256) || typeof inspection.completeMedia !== 'boolean' ||
        !count(inspection.declaredSettings, 0, 3) || !count(inspection.manifests, 1, MAX_ENTRIES) ||
        !count(inspection.objects, 0, MAX_ENTRIES)) refuse();
  } else if (inspection !== null) refuse();
  if (request && (!['download', 'status', 'cancel'].includes(request.action) || operation !== request.operation ||
      (request.action === 'download' && !['downloading', 'busy', 'invalidated'].includes(status)) ||
      (request.action === 'cancel' && status !== 'invalidated'))) refuse();
  return value;
}

function checkBackups(backups) {
  const ids = new Set(), backupsSeen = new Set();
  let count = backups.length;
  for (const row of backups) {
    if (!exact(row, 'backup', 'device', 'revisions') || !uuid(row.backup) || !uuid(row.device) ||
        !Array.isArray(row.revisions) || backupsSeen.has(row.backup)) refuse();
    backupsSeen.add(row.backup);
    count += row.revisions.length;
    if (count > MAX_ENTRIES) refuse();
    let previous = null;
    for (const [index, revision] of row.revisions.entries()) {
      if (!exact(revision, 'newestObserved', 'predecessorReference', 'reference', 'sha256') ||
          !reference(revision.reference) || !reference(revision.sha256) || ids.has(revision.reference) ||
          revision.predecessorReference !== previous || revision.newestObserved !== (index === row.revisions.length - 1)) refuse();
      previous = revision.reference;
      ids.add(previous);
    }
  }
  return ids.size;
}

export function parseIsolatedBackupResult(value, request) {
  if (exact(value, 'cleanupPending', 'inspection', 'operation', 'status', 'version')) return parseDownloadResult(value, request);
  if (request?.action === 'download') refuse();
  if (!exact(value, 'backups', 'operation', 'selection', 'status', 'version') || value.version !== 1 ||
      !statuses.has(value.status) || !Array.isArray(value.backups) || value.backups.length > MAX_ENTRIES ||
      value.operation !== null && !reference(value.operation)) refuse();
  const {status, operation, backups, selection} = value;
  if (operation === null && !['busy', 'invalidated'].includes(status) ||
      status === 'busy' && operation !== null) refuse();

  if (status === 'observed' || status === 'empty') {
    if ((checkBackups(backups) > 0) !== (status === 'observed')) refuse();
  } else if (backups.length !== 0) refuse();
  if (status === 'selected') {
    if (!exact(selection, 'backup', 'device', 'reference', 'sha256') || !uuid(selection.backup) || !uuid(selection.device) ||
        !reference(selection.reference) || !reference(selection.sha256)) refuse();
  } else if (selection !== null) refuse();

  if (request?.action === 'scan' && ['selected', 'selecting'].includes(status) ||
      request?.action === 'select' && ['observed', 'empty', 'scanning'].includes(status) ||
      request?.action === 'status' && operation !== request.operation ||
      request?.action === 'cancel' && (operation !== request.operation || status !== 'invalidated')) refuse();
  if (bytes(value) > ISOLATED_BACKUP_RESPONSE_BYTES) refuse();
  return value;
}
