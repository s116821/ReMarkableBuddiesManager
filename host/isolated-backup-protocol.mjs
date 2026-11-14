import {strictJson} from './strict-json.mjs';

export const ISOLATED_BACKUP_REQUEST_BYTES = 512;
export const ISOLATED_BACKUP_RESPONSE_BYTES = 2 * 1024 * 1024;
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
    case 'status':
    case 'cancel':
      if (!exact(value, 'action', 'operation', 'version') || !reference(value.operation)) refuse();
      break;
    default:
      refuse();
  }
  return value;
}

const statuses = new Set([
  'scanning', 'selecting', 'observed', 'empty', 'selected', 'unqualified', 'unavailable',
  'invalid', 'incomplete', 'invalidated', 'unsupported', 'busy',
]);

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
